import { Service } from 'egg';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { RunnableSequence, RunnablePassthrough } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { HydeRetriever } from "langchain/retrievers/hyde";
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import { OpenAIEmbeddings } from '@langchain/openai';
import { formatDocumentsAsString } from 'langchain/util/document';

export default class RagAgentService extends Service {
  /**
   * 获取Agent配置
   */
  private async getAgentById(id: number) {
    const agent = await this.ctx.model.Agent.findByPk(id);
    if (!agent) {
      throw new Error('Agent not found');
    }
    return agent;
  }

  /**
   * 获取知识库列表
   */
  private async getKnowledgeBases(agent: any) {
    if (!agent.knowledge_base_ids) {
      return [];
    }
    
    const knowledgeBaseIds = JSON.parse(agent.knowledge_base_ids);
    return await this.ctx.model.KnowledgeBase.findAll({
      where: {
        id: knowledgeBaseIds,
        status: 1,
      },
    });
  }

  /**
   * 创建检索增强生成链
   */
  private async createRAGChain(agent: any, knowledgeBases: any[]) {
    const config = this.app.config.ai || {};
    const llm = new ChatOpenAI({
      modelName: agent.model_name || 'gpt-3.5-turbo',
      openAIApiKey: config.openai?.apiKey,
      temperature: agent.model_parameters?.temperature || 0,
    });

    // 创建向量存储
    const vectorStore = await this.ctx.service.vectorStore.create(knowledgeBases);
    
    // 创建HYDE检索器（Hypothetical Document Embeddings）
    const hydeRetriever = new HydeRetriever({
      vectorStore,
      llm,
      k: 5,
    });

    // 获取Agent的提示词
    const systemPrompt = await this.ctx.service.prompt.getAgentPrompt(agent.id);

    // 创建系统提示模板
    const systemTemplate = systemPrompt || `你是一个智能助手，名为"${agent.name}"。
${agent.system_prompt || ''}

回答用户问题时，请遵循以下原则：
1. 基于给定的上下文信息回答问题
2. 如果上下文中没有相关信息，请诚实地说明你不知道
3. 不要编造信息
4. 使用简洁清晰的语言
5. 如果合适，可以使用符号和列表

上下文信息：
{context}`;

    const userTemplate = `{question}`;
    
    const promptTemplate = PromptTemplate.fromTemplate(systemTemplate);
    
    // 创建RAG链
    const ragChain = RunnableSequence.from([
      {
        context: async (input: { question: string }) => {
          const docs = await hydeRetriever.getRelevantDocuments(input.question);
          return formatDocumentsAsString(docs);
        },
        question: (input: { question: string }) => input.question,
      },
      promptTemplate,
      llm,
      new StringOutputParser(),
    ]);
    
    return ragChain;
  }

  /**
   * 处理单轮对话
   */
  public async chat(agentId: number, sessionId: string, message: string) {
    // 获取Agent和知识库
    const agent = await this.getAgentById(agentId);
    const knowledgeBases = await this.getKnowledgeBases(agent);
    
    // 创建RAG链
    const ragChain = await this.createRAGChain(agent, knowledgeBases);
    
    // 保存对话历史
    await this.saveConversation(agentId, sessionId, message, '', '', true);
    
    // 执行RAG链
    const response = await ragChain.invoke({
      question: message,
    });
    
    // 更新对话记录
    await this.updateConversation(agentId, sessionId, message, response);
    
    return response;
  }

  /**
   * 处理多轮对话
   */
  public async chatWithHistory(agentId: number, sessionId: string, message: string) {
    // 获取Agent和知识库
    const agent = await this.getAgentById(agentId);
    const knowledgeBases = await this.getKnowledgeBases(agent);
    
    // 获取历史对话
    const history = await this.ctx.model.Conversation.findAll({
      where: {
        agent_id: agentId,
        session_id: sessionId,
      },
      order: [['created_at', 'ASC']],
      limit: 10,
    });
    
    // 创建消息列表
    const messages = [];
    
    // 获取Agent的提示词
    const systemPromptContent = await this.ctx.service.prompt.getAgentPrompt(agentId);
    
    // 从长期记忆中获取与当前消息相关的记忆
    const relevantMemories = await this.ctx.service.memory.getRelevantMemories(agentId, message);
    
    // 创建向量存储
    const vectorStore = await this.ctx.service.vectorStore.create(knowledgeBases);
    
    // 获取相关文档
    const docs = await vectorStore.similaritySearch(message, 5);
    const context = formatDocumentsAsString(docs);
    
    // 构建增强的系统提示词，包含记忆和知识库内容
    let enhancedSystemPrompt = systemPromptContent || agent.system_prompt;
    
    // 添加长期记忆（如果有）
    if (relevantMemories && relevantMemories.trim().length > 0) {
      enhancedSystemPrompt += `\n\n用户相关记忆：\n${relevantMemories}`;
    }
    
    // 添加知识库检索结果
    if (context && context.trim().length > 0) {
      enhancedSystemPrompt += `\n\n相关信息：\n${context}`;
    }
    
    // 添加系统消息
    messages.push(new SystemMessage(enhancedSystemPrompt));
    
    // 添加历史对话
    for (const entry of history) {
      messages.push(new HumanMessage(entry.user_input));
      if (entry.agent_response) {
        messages.push(new AIMessage(entry.agent_response));
      }
    }
    
    // 添加当前消息
    messages.push(new HumanMessage(message));
    
    // 创建LLM
    const llm = new ChatOpenAI({
      modelName: agent.model_name || 'gpt-3.5-turbo',
      openAIApiKey: this.app.config.ai?.openai?.apiKey,
      temperature: agent.model_parameters?.temperature || 0.7,
    });
    
    // 保存对话(先保存一条处理中的消息记录)
    const conversation = await this.saveConversation(agentId, sessionId, message, context, '', true);
    
    try {
      // 获取短期记忆（会话级别）
      const shortTermMemory = await this.ctx.service.memory.getShortTermMemory(agentId, sessionId);
      
      // 在模型调用前检查并传入短期记忆状态
      const modelResponse = await llm.invoke(messages, {
        // 传递短期记忆作为模型的额外上下文
        session_state: shortTermMemory
      });
      
      // 保存对话的完整响应
      await this.updateConversation(agentId, sessionId, message, modelResponse.content.toString());
      
      // 处理对话内容，提取可能的长期记忆
      this.ctx.service.memory.processMemoryFromConversation(
        agentId,
        message,
        modelResponse.content.toString()
      ).catch(err => {
        this.ctx.logger.error('处理记忆时出错:', err);
      });
      
      return modelResponse.content.toString();
    } catch (error) {
      this.ctx.logger.error('RAG Agent对话时出错:', error);
      throw error;
    }
  }

  /**
   * 处理多轮对话（流式输出版本）
   */
  public async chatWithHistoryStream(agentId: number, sessionId: string, message: string) {
    // 获取Agent和知识库
    const agent = await this.getAgentById(agentId);
    const knowledgeBases = await this.getKnowledgeBases(agent);
    
    // 获取历史对话
    const history = await this.ctx.model.Conversation.findAll({
      where: {
        agent_id: agentId,
        session_id: sessionId,
      },
      order: [['created_at', 'ASC']],
      limit: 10,
    });
    
    // 创建消息列表
    const messages = [];
    
    // 获取Agent的提示词
    const systemPromptContent = await this.ctx.service.prompt.getAgentPrompt(agentId);
    
    // 从长期记忆中获取与当前消息相关的记忆
    const relevantMemories = await this.ctx.service.memory.getRelevantMemories(agentId, message);
    
    // 创建向量存储
    const vectorStore = await this.ctx.service.vectorStore.create(knowledgeBases);
    
    // 获取相关文档
    const docs = await vectorStore.similaritySearch(message, 5);
    const context = formatDocumentsAsString(docs);
    
    // 构建增强的系统提示词，包含记忆和知识库内容
    let enhancedSystemPrompt = systemPromptContent || agent.system_prompt;
    
    // 添加长期记忆（如果有）
    if (relevantMemories && relevantMemories.trim().length > 0) {
      enhancedSystemPrompt += `\n\n用户相关记忆：\n${relevantMemories}`;
    }
    
    // 添加知识库检索结果
    if (context && context.trim().length > 0) {
      enhancedSystemPrompt += `\n\n相关信息：\n${context}`;
    }
    
    // 添加系统消息
    messages.push(new SystemMessage(enhancedSystemPrompt));
    
    // 添加历史对话
    for (const entry of history) {
      messages.push(new HumanMessage(entry.user_input));
      if (entry.agent_response) {
        messages.push(new AIMessage(entry.agent_response));
      }
    }
    
    // 添加当前消息
    messages.push(new HumanMessage(message));
    
    // 创建LLM（启用流式输出）
    const llm = new ChatOpenAI({
      modelName: agent.model_name || 'gpt-3.5-turbo',
      openAIApiKey: this.app.config.ai?.openai?.apiKey,
      temperature: agent.model_parameters?.temperature || 0.7,
      streaming: true,
    });
    
    // 保存对话(先保存一条处理中的消息记录)
    const conversation = await this.saveConversation(agentId, sessionId, message, context, '', true);
    
    try {
      // 收集完整响应用于保存
      let fullResponse = '';
      
      // 启动流式生成
      const streamingResponse = await llm.stream(messages);
      
      // 返回流式生成器
      const responseGenerator = async function* () {
        for await (const chunk of streamingResponse) {
          if (chunk.content) {
            fullResponse += chunk.content;
            yield chunk.content;
          }
        }
        
        // 请求完成后更新对话
        await this.updateConversation(agentId, sessionId, message, fullResponse);
        
        // 处理对话内容，提取可能的长期记忆
        this.ctx.service.memory.processMemoryFromConversation(
          agentId,
          message,
          fullResponse
        ).catch(err => {
          this.ctx.logger.error('处理记忆时出错:', err);
        });
      }.bind(this);
      
      return responseGenerator();
    } catch (error: any) {
      this.ctx.logger.error('RAG Agent流式对话出错:', error);
      
      // 更新对话记录为错误状态
      const failedConversation = await this.ctx.model.Conversation.findOne({
        where: {
          agent_id: agentId,
          session_id: sessionId,
          user_input: message,
          status: 0,
        },
        order: [['created_at', 'DESC']],
      });
      
      if (failedConversation) {
        await failedConversation.update({
          agent_response: `处理请求时出错: ${error.message}`,
          status: 2, // 错误状态
          updated_at: new Date(),
        });
      }
      
      throw error;
    }
  }

  /**
   * 保存对话
   */
  private async saveConversation(agentId: number, sessionId: string, userInput: string, context: string, agentResponse: string, isProcessing: boolean = false) {
    return await this.ctx.model.Conversation.create({
      agent_id: agentId,
      session_id: sessionId,
      user_input: userInput,
      context: context,
      agent_response: agentResponse,
      status: isProcessing ? 0 : 1,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }

  /**
   * 更新对话
   */
  private async updateConversation(agentId: number, sessionId: string, userInput: string, agentResponse: string) {
    const conversation = await this.ctx.model.Conversation.findOne({
      where: {
        agent_id: agentId,
        session_id: sessionId,
        user_input: userInput,
        status: 0,
      },
      order: [['created_at', 'DESC']],
    });
    
    if (conversation) {
      await conversation.update({
        agent_response: agentResponse,
        status: 1,
        updated_at: new Date(),
      });
    }
    
    return conversation;
  }

  /**
   * 知识库搜索
   */
  public async searchKnowledgeBase(agentId: number, query: string, limit = 5) {
    const agent = await this.getAgentById(agentId);
    const knowledgeBases = await this.getKnowledgeBases(agent);
    
    // 创建向量存储
    const vectorStore = await this.ctx.service.vectorStore.create(knowledgeBases);
    
    // 执行混合搜索
    return await this.ctx.service.vectorStore.hybridSearch(vectorStore, query, limit);
  }

  /**
   * 清理会话
   */
  public async clearSession(agentId: number, sessionId: string) {
    await this.ctx.model.Conversation.destroy({
      where: {
        agent_id: agentId,
        session_id: sessionId,
      },
    });
    
    return { success: true };
  }
} 
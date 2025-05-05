import { Service } from 'egg';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { formatDocumentsAsString } from 'langchain/util/document';

/**
 * 基于自定义工作流的Agent服务
 */
export default class GraphAgentService extends Service {
  /**
   * 获取Agent配置信息
   */
  private async getAgentById(id: number) {
    const agent = await (this.ctx.model as any).Agent.findByPk(id);
    if (!agent) {
      throw new Error(`Agent配置不存在: ${id}`);
    }
    return agent;
  }

  /**
   * 获取知识库
   */
  private async getKnowledgeBases(agent: any) {
    const knowledgeBases = await (this.ctx.model as any).KnowledgeBase.findAll({
      where: {
        id: {
          [(this.app as any).Sequelize.Op.in]: agent.knowledge_base_ids || [],
        },
      },
    });
    return knowledgeBases;
  }

  /**
   * 创建知识检索链
   */
  private async createRetrievalChain(agent: any) {
    // 1. 创建LLM
    const llm = new ChatOpenAI({
      modelName: agent.model_name || 'gpt-3.5-turbo',
      openAIApiKey: this.app.config.ai?.openai?.apiKey,
      temperature: agent.model_parameters?.temperature || 0.7,
    });

    // 2. 创建系统提示模板
    const systemPromptTemplate = PromptTemplate.fromTemplate(`
你是一个智能助手，基于以下知识信息回答用户的问题。

相关知识：
{context}

用户相关记忆：
{memory}

请记住:
1. 如果提供的信息不足以回答问题，请诚实地说你不知道，不要编造信息
2. 你的回答应当简洁、有帮助、符合礼貌，基于上下文和用户问题提供准确信息
3. 使用用户的语言回答问题

${agent.system_prompt || ""}
`);

    // 3. 创建人类消息模板
    const humanPromptTemplate = PromptTemplate.fromTemplate(`{question}`);

    // 4. 创建序列链
    const chain = RunnableSequence.from([
      {
        // 格式化输入
        context: async (input: { question: string, chat_history: BaseMessage[] }) => {
          try {
            // 创建向量存储
            const knowledgeBases = await this.getKnowledgeBases(agent);
            const vectorStore = await this.ctx.service.vectorStore.create(knowledgeBases);
            
            // 获取相关文档
            const docs = await vectorStore.similaritySearch(input.question, 5);
            return formatDocumentsAsString(docs);
          } catch (error: any) {
            this.ctx.logger.error('检索知识库出错:', error);
            return "";
          }
        },
        memory: async (input: { question: string, chat_history: BaseMessage[] }) => {
          try {
            // 获取相关记忆
            const memories = await this.ctx.service.memory.getRelevantMemories(agent.id, input.question);
            return memories || "";
          } catch (error: any) {
            this.ctx.logger.error('检索记忆出错:', error);
            return "";
          }
        },
        question: (input: { question: string, chat_history: BaseMessage[] }) => input.question,
        chat_history: (input: { question: string, chat_history: BaseMessage[] }) => input.chat_history,
      },
      {
        // 构建消息
        system: systemPromptTemplate,
        human: humanPromptTemplate, 
        chat_history: (input) => input.chat_history,
      },
      {
        // 组合消息
        messages: (input) => {
          const messages = [new SystemMessage(input.system)];
          
          // 添加对话历史
          if (input.chat_history && input.chat_history.length > 0) {
            messages.push(...input.chat_history);
          }
          
          // 添加当前问题
          messages.push(new HumanMessage(input.human));
          
          return messages;
        }
      },
      // 调用LLM并解析结果
      llm,
      new StringOutputParser()
    ]);
    
    return chain;
  }

  /**
   * 处理对话
   */
  public async chat(agentId: number, sessionId: string, message: string) {
    // 获取Agent
    const agent = await this.getAgentById(agentId);
    
    // 创建检索链
    const chain = await this.createRetrievalChain(agent);
    
    // 获取历史对话
    const history = await (this.ctx.model as any).Conversation.findAll({
      where: {
        agent_id: agentId,
        session_id: sessionId,
      },
      order: [['created_at', 'ASC']],
      limit: 10,
    });
    
    // 创建消息历史
    const chatHistory: BaseMessage[] = [];
    
    // 添加历史对话
    for (const entry of history) {
      chatHistory.push(new HumanMessage(entry.user_input));
      if (entry.agent_response) {
        chatHistory.push(new AIMessage(entry.agent_response));
      }
    }
    
    // 保存对话(先保存一条处理中的消息记录)
    await (this.ctx.model as any).Conversation.create({
      agent_id: agentId,
      session_id: sessionId,
      user_input: message,
      agent_response: '',
      status: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    
    try {
      // 调用链
      const response = await chain.invoke({
        question: message,
        chat_history: chatHistory,
      });
      
      // 更新对话记录
      const conversation = await (this.ctx.model as any).Conversation.findOne({
        where: {
          agent_id: agentId,
          session_id: sessionId,
          user_input: message,
          status: 0,
        },
        order: [['created_at', 'DESC']],
      });
      
      if (conversation) {
        await conversation.update({
          agent_response: response,
          status: 1,
          updated_at: new Date(),
        });
      }
      
      // 处理并保存记忆（异步操作，不等待完成）
      this.ctx.service.memory.processMemoryFromConversation(
        agentId,
        message,
        response
      ).catch(err => {
        this.ctx.logger.error('处理记忆时出错:', err);
      });
      
      return response;
    } catch (error: any) {
      this.ctx.logger.error('Graph Agent对话出错:', error);
      
      // 更新对话记录为错误状态
      const conversation = await (this.ctx.model as any).Conversation.findOne({
        where: {
          agent_id: agentId,
          session_id: sessionId,
          user_input: message,
          status: 0,
        },
        order: [['created_at', 'DESC']],
      });
      
      if (conversation) {
        await conversation.update({
          agent_response: `处理请求时出错: ${error.message}`,
          status: 2, // 错误状态
          updated_at: new Date(),
        });
      }
      
      throw error;
    }
  }

  /**
   * 处理对话（流式输出版本）
   */
  public async chatStream(agentId: number, sessionId: string, message: string) {
    // 获取Agent
    const agent = await this.getAgentById(agentId);
    
    // 创建LLM并开启流式输出
    const llm = new ChatOpenAI({
      modelName: agent.model_name || 'gpt-3.5-turbo',
      openAIApiKey: this.app.config.ai?.openai?.apiKey,
      temperature: agent.model_parameters?.temperature || 0.7,
      streaming: true,
    });
    
    // 获取历史对话
    const history = await (this.ctx.model as any).Conversation.findAll({
      where: {
        agent_id: agentId,
        session_id: sessionId,
      },
      order: [['created_at', 'ASC']],
      limit: 10,
    });
    
    // 创建消息历史
    const chatHistory: BaseMessage[] = [];
    
    // 添加历史对话
    for (const entry of history) {
      chatHistory.push(new HumanMessage(entry.user_input));
      if (entry.agent_response) {
        chatHistory.push(new AIMessage(entry.agent_response));
      }
    }
    
    // 保存对话(先保存一条处理中的消息记录)
    const conversation = await (this.ctx.model as any).Conversation.create({
      agent_id: agentId,
      session_id: sessionId,
      user_input: message,
      agent_response: '',
      status: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    
    try {
      // 创建系统提示
      let systemPrompt = agent.system_prompt || "你是一个智能助手，可以回答用户的问题。";
      
      // 获取相关记忆
      const memories = await this.ctx.service.memory.getRelevantMemories(agentId, message);
      if (memories && memories.trim().length > 0) {
        systemPrompt += `\n\n用户相关记忆：\n${memories}`;
      }
      
      // 获取相关知识
      try {
        // 创建向量存储
        const knowledgeBases = await this.getKnowledgeBases(agent);
        const vectorStore = await this.ctx.service.vectorStore.create(knowledgeBases);
        
        // 获取相关文档
        const docs = await vectorStore.similaritySearch(message, 5);
        const context = formatDocumentsAsString(docs);
        
        if (context && context.trim().length > 0) {
          systemPrompt += `\n\n相关知识：\n${context}`;
        }
      } catch (error: any) {
        this.ctx.logger.error('检索知识库出错:', error);
      }
      
      // 创建消息列表
      const messages = [
        new SystemMessage(systemPrompt),
        ...chatHistory,
        new HumanMessage(message)
      ];
      
      // 收集完整响应用于保存
      let fullResponse = '';
      
      // 设置处理器和回调
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
        await conversation.update({
          agent_response: fullResponse,
          status: 1,
          updated_at: new Date(),
        });
        
        // 处理记忆（异步，不等待完成）
        try {
          await this.ctx.service.memory.processMemoryFromConversation(
            agentId,
            message,
            fullResponse
          );
        } catch (err) {
          this.ctx.logger.error('处理记忆时出错:', err);
        }
      }.bind(this);
      
      return responseGenerator();
    } catch (error: any) {
      this.ctx.logger.error('Stream Agent对话出错:', error);
      
      // 更新对话记录为错误状态
      await conversation.update({
        agent_response: `处理请求时出错: ${error.message}`,
        status: 2, // 错误状态
        updated_at: new Date(),
      });
      
      throw error;
    }
  }
} 
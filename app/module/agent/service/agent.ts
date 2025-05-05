import { Service } from 'egg';
import { ChatOpenAI } from '@langchain/openai';
import { RunnableSequence } from '@langchain/core/runnables';
import { AgentExecutor, createOpenAIFunctionsAgent } from 'langchain/agents';
import { Tool } from '@langchain/core/tools';
import { BaseMessage } from '@langchain/core/messages';
import { StateGraph, END } from '@langchain/langgraph';
import { VectorStore } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';

// 1. Agent 相关接口
interface IAgent {
  id: number;
  name: string;
  description?: string;
  system_prompt?: string;
  tools: string; // JSON 字符串，存储工具 ID 数组
  knowledge_base_ids: string; // JSON 字符串，存储知识库 ID 数组
  prompt_id?: number;
  prompt_variables?: string; // JSON 字符串
  custom_prompt?: string;
  model_name: string;
  model_parameters: string; // JSON 字符串
  created_at?: Date;
  updated_at?: Date;
  // 为数据库模型添加常用方法
  toJSON(): any;
  update(values: Partial<IAgent>): Promise<IAgent>;
  destroy(): Promise<void>;
}

// 2. 工具相关接口
interface ITool {
  id: number;
  name: string;
  description: string;
  type: 'api' | 'function' | 'database' | 'file' | 'search' | 'ai' | 'workflow' | 'mcp';
  config: string; // JSON 字符串
  status: number;
}

// 工具配置接口
interface IToolConfig {
  // API 工具配置
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  data?: any;
  
  // 函数工具配置
  function?: string;
  
  // 其他工具类型的配置
  // ...
}

// 扩展 LangChain Tool 类型
interface ICustomTool extends Tool {
  name: string;
  description: string;
  func: (input: string) => Promise<string>;
}

// 3. 对话相关接口
interface IConversation {
  id?: number;
  agent_id: number;
  session_id: string;
  user_input: string;
  agent_response: string;
  context?: string;
  tools_used?: string;
  status: number; // 0: 处理中, 1: 已完成, 2: 错误
  created_at: Date;
  updated_at: Date;
  update(values: Partial<IConversation>): Promise<IConversation>;
}

// 4. 知识库相关接口
interface IKnowledgeBase {
  id: number;
  name: string;
  description?: string;
  type: string;
  config: string; // JSON 字符串
  status: number;
}

// 5. 提示词模板接口
interface IPrompt {
  id: number;
  name: string;
  content: string;
  variables?: string; // JSON 字符串
  description?: string;
  created_at?: Date;
  updated_at?: Date;
}

// 6. Agent 状态接口 (用于 LangGraph)
interface AgentState {
  messages: BaseMessage[];
  currentStep: number;
  maxSteps: number;
  tools: ICustomTool[];
  knowledgeBase?: VectorStore;
  context: Record<string, any>;
  channels?: {
    messages: BaseMessage[];
    currentStep: number;
    maxSteps: number;
    tools: ICustomTool[];
    knowledgeBase?: VectorStore;
    context: Record<string, any>;
  };
}

// 7. 模型参数接口
interface ModelParameters {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
}

interface AgentState {
  messages: BaseMessage[];
  currentStep: number;
  maxSteps: number;
  tools: Tool[];
  knowledgeBase?: VectorStore;
  context: Record<string, any>;
}

export default class ReactAgentService extends Service {
  private async getAgentById(id: number): Promise<IAgent | null> {
    return await this.ctx.model.Agent.findByPk(id) as IAgent | null;
  }

  private async getToolsByAgent(agent: any) {
    if (!agent.tools) return [];
    const toolIds = JSON.parse(agent.tools);
    return await this.ctx.model.Tool.findAll({
      where: {
        id: toolIds,
        status: 1,
      },
    });
  }

  private async getKnowledgeBasesByAgent(agent: any) {
    if (!agent.knowledge_base_ids) return [];
    const knowledgeBaseIds = JSON.parse(agent.knowledge_base_ids);
    return await this.ctx.model.KnowledgeBase.findAll({
      where: {
        id: knowledgeBaseIds,
        status: 1,
      },
    });
  }

  private createTool(tool: any): Tool {
    const config = JSON.parse(tool.config);
    
    switch (tool.type) {
      case 'api':
        return {
          name: tool.name,
          description: tool.description,
          func: async (input: string) => {
            const response = await this.ctx.curl(config.url, {
              method: config.method,
              data: config.data,
              headers: config.headers,
            });
            return JSON.stringify(response.data);
          },
        };
      
      case 'function':
        return {
          name: tool.name,
          description: tool.description,
          func: async (input: string) => {
            return await eval(config.function)(input);
          },
        };
      
      case 'database':
        return {
          name: tool.name,
          description: tool.description,
          func: async (input: string) => {
            const { query, params } = JSON.parse(input);
            const result = await this.ctx.model.query(query, {
              replacements: params,
            });
            return JSON.stringify(result);
          },
        };
      
      case 'file':
        return {
          name: tool.name,
          description: tool.description,
          func: async (input: string) => {
            const { operation, path, content } = JSON.parse(input);
            switch (operation) {
              case 'read':
                return await this.ctx.fs.readFile(path, 'utf-8');
              case 'write':
                await this.ctx.fs.writeFile(path, content);
                return 'File written successfully';
              default:
                throw new Error('Invalid file operation');
            }
          },
        };
      
      case 'search':
        return {
          name: tool.name,
          description: tool.description,
          func: async (input: string) => {
            const { query, limit } = JSON.parse(input);
            const results = await this.ctx.service.search.search(query, limit);
            return JSON.stringify(results);
          },
        };
      
      case 'ai':
        return {
          name: tool.name,
          description: tool.description,
          func: async (input: string) => {
            const { model, prompt, parameters } = JSON.parse(input);
            const response = await this.ctx.service.ai.generate(model, prompt, parameters);
            return response;
          },
        };
      
      case 'workflow':
        return {
          name: tool.name,
          description: tool.description,
          func: async (input: string) => {
            const { workflowId, parameters } = JSON.parse(input);
            const result = await this.ctx.service.workflow.execute(workflowId, parameters);
            return JSON.stringify(result);
          },
        };
      
      case 'mcp':
        return {
          name: tool.name,
          description: tool.description,
          func: async (input: string) => {
            const { serverId, messages, options } = JSON.parse(input);
            const result = await this.ctx.service.mcpClient.invoke(serverId, messages, options);
            return JSON.stringify(result);
          },
        };
      
      default:
        throw new Error(`Unsupported tool type: ${tool.type}`);
    }
  }

  private createAgentGraph(agent: any, tools: Tool[], knowledgeBase?: VectorStore) {
    const llm = new ChatOpenAI({
      modelName: agent.model_name || 'gpt-3.5-turbo',
      temperature: agent.model_parameters?.temperature || 0,
      openAIApiKey: this.app.config.ai?.openai?.apiKey,
    });

    const agentInstance = createOpenAIFunctionsAgent({
      llm,
      tools,
      systemMessage: agent.system_prompt,
    });

    const agentExecutor = AgentExecutor.fromAgentAndTools({
      agent: agentInstance,
      tools,
    });

    const workflow = new StateGraph<AgentState>({
      channels: {
        messages: {
          value: [] as any[],
        },
        currentStep: {
          value: 0,
        },
        maxSteps: {
          value: 10,
        },
        tools: {
          value: tools,
        },
        knowledgeBase: {
          value: knowledgeBase,
        },
        context: {
          value: {} as Record<string, any>,
        },
      },
    });

    // 添加思考节点 
    workflow.addNode('think', async (state: AgentState) => {
      const { messages, knowledgeBase, context } = state.channels;
      const lastMessage = messages[messages.length - 1];
      
      // 如果有知识库，先进行知识检索
      if (knowledgeBase) {
        const docs = await knowledgeBase.similaritySearch(lastMessage.content, 3);
        context.retrievedKnowledge = docs.map(doc => doc.pageContent).join('\n');
      }

      // 使用LLM进行思考
      const thought = await llm.invoke([
        { role: 'system', content: agent.system_prompt },
        { role: 'user', content: lastMessage.content },
        { role: 'assistant', content: context.retrievedKnowledge || '' },
      ]);

      return {
        ...state,
        context: {
          ...context,
          thought: thought.content,
        },
      };
    });

    // 添加行动节点
    workflow.addNode('act', async (state) => {
      const { context, tools } = state;
      const { thought } = context;

      // 选择最合适的工具
      const tool = tools.find(t => 
        t.name.toLowerCase().includes(thought.toLowerCase())
      );

      if (!tool) {
        return {
          ...state,
          context: {
            ...context,
            action: 'No suitable tool found',
          },
        };
      }

      // 执行工具
      const result = await tool.func(thought);
      
      return {
        ...state,
        context: {
          ...context,
          action: tool.name,
          result,
        },
      };
    });

    // 添加观察节点
    workflow.addNode('observe', async (state) => {
      const { context, messages } = state;
      const { thought, action, result } = context;

      // 使用LLM分析结果
      const observation = await llm.invoke([
        { role: 'system', content: 'Analyze the tool execution result' },
        { role: 'user', content: `Thought: ${thought}\nAction: ${action}\nResult: ${result}` },
      ]);

      return {
        ...state,
        messages: [
          ...messages,
          { role: 'assistant', content: observation.content },
        ],
        currentStep: state.currentStep + 1,
      };
    });

    // 添加条件边
    workflow.addConditionalEdges(
      'think',
      (state) => {
        if (state.currentStep >= state.maxSteps) {
          return END;
        }
        return 'act';
      },
    );

    workflow.addConditionalEdges(
      'act',
      (state) => {
        if (state.context.action === 'No suitable tool found') {
          return END;
        }
        return 'observe';
      },
    );

    workflow.addConditionalEdges(
      'observe',
      (state) => {
        if (state.currentStep >= state.maxSteps) {
          return END;
        }
        return 'think';
      },
    );

    workflow.setEntryPoint('think');

    return workflow.compile();
  }

  public async createAgentExecutor(agentId: number) {
    const agent = await this.getAgentById(agentId);
    if (!agent) {
      throw new Error('Agent not found');
    }

    const tools = await this.getToolsByAgent(agent);
    const toolList = tools.map(this.createTool.bind(this));

    const knowledgeBases = await this.getKnowledgeBasesByAgent(agent);
    let knowledgeBase;
    if (knowledgeBases.length > 0) {
      // 创建向量存储
      knowledgeBase = await this.ctx.service.vectorStore.create(knowledgeBases);
    }

    return this.createAgentGraph(agent, toolList, knowledgeBase);
  }

  public async chat(agentId: number, sessionId: string, message: string) {
    const executor = await this.createAgentExecutor(agentId);
    
    // 获取历史对话
    const history = await this.ctx.model.Conversation.findAll({
      where: {
        agent_id: agentId,
        session_id: sessionId,
      },
      order: [['created_at', 'ASC']],
      limit: 10,
    });

    // 构建对话历史
    const chatHistory: BaseMessage[] = history.map(item => ({
      type: 'human',
      content: item.user_input,
    }));

    // 添加当前消息
    chatHistory.push({
      type: 'human',
      content: message,
    });

    // 执行对话
    const result = await executor.invoke({
      messages: chatHistory,
      currentStep: 0,
      maxSteps: 10,
      tools: [],
      context: {},
    });

    // 保存对话记录
    await this.ctx.model.Conversation.create({
      agent_id: agentId,
      session_id: sessionId,
      user_input: message,
      agent_response: result.messages[result.messages.length - 1].content,
      tools_used: JSON.stringify(result.context),
    });

    return result.messages[result.messages.length - 1].content;
  }
} 
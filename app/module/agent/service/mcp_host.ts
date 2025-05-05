import { Service } from 'egg';
import { v4 as uuidv4 } from 'uuid';
import { BaseMessage } from '@langchain/core/messages';

interface McpToolCall {
  id: string;
  type: string;
  name: string;
  parameters: Record<string, any>;
}

interface McpMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: McpToolCall[];
  toolCallId?: string;
}

export default class McpHostService extends Service {
  private registeredModels: Map<string, any> = new Map();
  private registeredTools: Map<string, any> = new Map();

  // 注册AI模型
  public registerModel(modelId: string, handler: any) {
    this.registeredModels.set(modelId, handler);
    this.ctx.logger.info(`[MCP Host] 已注册模型: ${modelId}`);
  }

  // 注册工具
  public registerTool(toolId: string, handler: any) {
    this.registeredTools.set(toolId, handler);
    this.ctx.logger.info(`[MCP Host] 已注册工具: ${toolId}`);
  }

  // 处理聊天完成请求
  public async handleChatCompletion(requestData: any) {
    const { model, messages, tools = [], stream = false, ...parameters } = requestData;

    // 验证模型是否存在
    if (!this.registeredModels.has(model)) {
      throw new Error(`未找到模型: ${model}`);
    }

    // 获取模型处理器
    const modelHandler = this.registeredModels.get(model);

    // 转换消息格式为LangChain格式
    const langchainMessages = this.convertToLangChainMessages(messages);

    // 转换工具格式为LangChain格式
    const langchainTools = this.convertToLangChainTools(tools);

    try {
      // 调用模型处理请求
      if (stream) {
        return await this.handleStreamingResponse(modelHandler, langchainMessages, langchainTools, parameters);
      } else {
        return await this.handleNonStreamingResponse(modelHandler, langchainMessages, langchainTools, parameters);
      }
    } catch (error) {
      this.ctx.logger.error('[MCP Host] 模型调用失败', error);
      throw error;
    }
  }

  // 处理工具调用
  public async handleToolExecution(toolCallId: string, name: string, parameters: Record<string, any>) {
    if (!this.registeredTools.has(name)) {
      throw new Error(`未找到工具: ${name}`);
    }

    const tool = this.registeredTools.get(name);

    try {
      const result = await tool(parameters);
      
      return {
        id: uuidv4(),
        role: 'tool',
        content: typeof result === 'string' ? result : JSON.stringify(result),
        toolCallId,
      };
    } catch (error) {
      this.ctx.logger.error(`[MCP Host] 工具执行失败: ${name}`, error);
      return {
        id: uuidv4(),
        role: 'tool',
        content: `工具执行错误: ${error.message}`,
        toolCallId,
      };
    }
  }

  // 转换消息格式为LangChain格式
  private convertToLangChainMessages(messages: McpMessage[]): BaseMessage[] {
    return messages.map(msg => {
      switch (msg.role) {
        case 'system':
          return { role: 'system', content: msg.content };
        case 'user':
          return { role: 'human', content: msg.content };
        case 'assistant':
          return { role: 'ai', content: msg.content };
        case 'tool':
          return { role: 'function', name: msg.toolCallId, content: msg.content };
        default:
          return { role: 'human', content: msg.content };
      }
    });
  }

  // 转换工具格式为LangChain格式
  private convertToLangChainTools(tools: any[]) {
    return tools.map(tool => {
      return {
        name: tool.name,
        description: tool.description,
        func: async (parameters: any) => {
          if (this.registeredTools.has(tool.name)) {
            const handler = this.registeredTools.get(tool.name);
            return await handler(parameters);
          }
          throw new Error(`未找到工具处理器: ${tool.name}`);
        },
      };
    });
  }

  // 处理非流式响应
  private async handleNonStreamingResponse(modelHandler: any, messages: BaseMessage[], tools: any[], parameters: any) {
    const response = await modelHandler.invoke({
      messages,
      tools,
      ...parameters,
    });

    // 转换响应格式为MCP格式
    return {
      id: uuidv4(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: parameters.model || 'unknown',
      messages: this.convertFromLangChainMessages(response.messages || [response]),
    };
  }

  // 处理流式响应
  private async handleStreamingResponse(modelHandler: any, messages: BaseMessage[], tools: any[], parameters: any) {
    // 获取流式响应
    const stream = await modelHandler.stream({
      messages,
      tools,
      ...parameters,
    });

    return stream;
  }

  // 转换LangChain消息格式为MCP格式
  private convertFromLangChainMessages(messages: any[]): McpMessage[] {
    return messages.map(msg => {
      const mcpMessage: McpMessage = {
        id: uuidv4(),
        role: this.mapLangChainRoleToMcp(msg.role),
        content: msg.content,
      };

      // 处理工具调用
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        mcpMessage.toolCalls = msg.toolCalls.map((tc: any) => ({
          id: tc.id || uuidv4(),
          type: tc.type || 'function',
          name: tc.name,
          parameters: tc.parameters,
        }));
      }

      // 处理工具调用响应
      if (msg.role === 'function') {
        mcpMessage.toolCallId = msg.name;
      }

      return mcpMessage;
    });
  }

  // 映射LangChain角色到MCP角色
  private mapLangChainRoleToMcp(role: string): McpMessage['role'] {
    switch (role) {
      case 'system':
        return 'system';
      case 'human':
        return 'user';
      case 'ai':
        return 'assistant';
      case 'function':
        return 'tool';
      default:
        return 'user';
    }
  }
} 
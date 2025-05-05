import { Service } from 'egg';
import { v4 as uuidv4 } from 'uuid';

interface McpInvokeOptions {
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: any[];
  parameters?: Record<string, any>;
}

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

interface McpResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  messages: McpMessage[];
}

export default class McpClientService extends Service {
  private async getServerById(id: number) {
    return await this.ctx.model.McpServer.findByPk(id);
  }

  public async invoke(serverId: number, messages: McpMessage[], options: McpInvokeOptions = {}) {
    const server = await this.getServerById(serverId);
    if (!server) {
      throw new Error('MCP服务器未找到');
    }

    try {
      const url = `${server.protocol}://${server.host}:${server.port}/v1/chat/completions`;
      const response = await this.ctx.curl(url, {
        method: 'POST',
        contentType: 'application/json',
        dataType: 'json',
        headers: {
          'Authorization': `Bearer ${server.api_key}`,
        },
        data: {
          model: options.modelId || 'gpt-3.5-turbo',
          messages,
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 2000,
          tools: options.tools || [],
          ...options.parameters,
        },
        timeout: 60000,
      });

      if (response.status !== 200) {
        throw new Error(`MCP服务器响应错误: ${response.status}`);
      }

      return response.data as McpResponse;
    } catch (error) {
      this.ctx.logger.error('[MCP Client] 调用MCP服务失败', error);
      throw error;
    }
  }

  public async invokeTool(serverId: number, messages: McpMessage[], toolResponse: McpMessage) {
    const updatedMessages = [...messages, toolResponse];
    
    return this.invoke(serverId, updatedMessages);
  }

  public async streamInvoke(serverId: number, messages: McpMessage[], options: McpInvokeOptions = {}) {
    const server = await this.getServerById(serverId);
    if (!server) {
      throw new Error('MCP服务器未找到');
    }

    try {
      const url = `${server.protocol}://${server.host}:${server.port}/v1/chat/completions`;
      // 实现SSE流式调用
      const response = await this.ctx.curl(url, {
        method: 'POST',
        contentType: 'application/json',
        headers: {
          'Authorization': `Bearer ${server.api_key}`,
          'Accept': 'text/event-stream',
        },
        data: {
          model: options.modelId || 'gpt-3.5-turbo',
          messages,
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 2000,
          tools: options.tools || [],
          stream: true,
          ...options.parameters,
        },
        timeout: 60000,
        streaming: true, // 启用流式响应
      });

      return response.res;
    } catch (error) {
      this.ctx.logger.error('[MCP Client] 流式调用MCP服务失败', error);
      throw error;
    }
  }
} 
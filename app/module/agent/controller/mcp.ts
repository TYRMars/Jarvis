import { Controller } from 'egg';

export default class McpController extends Controller {
  // MCP API请求 - 聊天完成
  public async chatCompletions() {
    const { ctx } = this;
    const requestData = ctx.request.body;

    try {
      const result = await ctx.service.mcpHost.handleChatCompletion(requestData);
      if (requestData.stream) {
        // 流式响应处理
        ctx.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Transfer-Encoding': 'chunked',
        });
        
        ctx.status = 200;
        
        // 将流传递给客户端
        result.on('data', (chunk: Buffer) => {
          ctx.res.write(chunk);
        });
        
        result.on('end', () => {
          ctx.res.end();
        });
        
        result.on('error', (err: Error) => {
          ctx.logger.error('[MCP] 流式响应错误', err);
          ctx.res.end();
        });
        
        // 避免返回普通响应
        return;
      } else {
        // 非流式响应
        ctx.body = result;
      }
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        error: {
          message: error.message,
          type: 'internal_server_error',
        },
      };
    }
  }

  // MCP API请求 - 工具执行
  public async toolExecution() {
    const { ctx } = this;
    const { toolCallId, name } = ctx.params;
    const parameters = ctx.request.body;

    try {
      const result = await ctx.service.mcpHost.handleToolExecution(toolCallId, name, parameters);
      ctx.body = result;
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        error: {
          message: error.message,
          type: 'internal_server_error',
        },
      };
    }
  }

  // MCP 模型列表
  public async listModels() {
    const { ctx } = this;

    try {
      const models = await ctx.service.ai.getAvailableModels();
      ctx.body = {
        object: 'list',
        data: models.map(model => ({
          id: model.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'agent-system',
        })),
      };
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        error: {
          message: error.message,
          type: 'internal_server_error',
        },
      };
    }
  }

  // MCP 服务器健康检查
  public async healthCheck() {
    const { ctx } = this;
    
    ctx.body = {
      status: 'ok',
      version: '1.0.0',
      timestamp: Date.now(),
    };
  }
} 
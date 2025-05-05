import { Controller } from 'egg';

export default class GraphAgentController extends Controller {
  /**
   * 使用Graph工作流处理对话
   */
  public async chat() {
    const { ctx } = this;
    const id = ctx.params?.id;
    const { session_id, message, stream = false } = ctx.request.body;

    try {
      if (!id || !session_id || !message) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'Agent ID、会话ID和消息内容不能为空',
        };
        return;
      }
      
      // 如果请求流式输出，则使用SSE
      if (stream) {
        return await this.streamChat(id, session_id, message);
      }
      
      // 否则使用普通同步响应
      const response = await ctx.service.graphAgent.chat(Number(id), session_id, message);
      
      ctx.body = {
        success: true,
        data: response,
      };
    } catch (error: any) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }
  
  /**
   * 流式输出处理
   */
  private async streamChat(id: string, sessionId: string, message: string) {
    const { ctx } = this;
    
    try {
      // 设置SSE头部
      ctx.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      
      // 保持连接
      ctx.res.flushHeaders();
      
      // 定义发送事件的函数
      const sendEvent = (event: string, data: string) => {
        ctx.res.write(`event: ${event}\ndata: ${data}\n\n`);
        ctx.res.flushHeaders();
      };
      
      // 开始流式生成
      try {
        const streamGenerator = await ctx.service.graphAgent.chatStream(Number(id), sessionId, message);
        
        // 发送开始事件
        sendEvent('start', JSON.stringify({ success: true }));
        
        // 处理流式输出
        for await (const chunk of streamGenerator) {
          sendEvent('chunk', JSON.stringify({ 
            content: chunk,
          }));
        }
        
        // 发送完成事件
        sendEvent('done', JSON.stringify({ success: true }));
      } catch (error: any) {
        // 发送错误事件
        sendEvent('error', JSON.stringify({ 
          success: false, 
          message: error.message,
        }));
      }
      
      // 结束响应
      ctx.res.end();
    } catch (error: any) {
      // 如果在设置SSE过程中发生错误，则返回常规错误响应
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }
} 
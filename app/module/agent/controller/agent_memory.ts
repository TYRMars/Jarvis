import { Controller } from 'egg';

export default class AgentMemoryController extends Controller {
  /**
   * 获取Agent的长期记忆
   */
  public async getLongTermMemories() {
    const { ctx } = this;
    const { agent_id, key, limit = '10' } = ctx.query;
    
    try {
      if (!agent_id) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'agent_id is required',
        };
        return;
      }
      
      const memories = await ctx.service.memory.getLongTermMemory(
        Number(agent_id),
        key as string,
        Number(limit)
      );
      
      ctx.body = {
        success: true,
        data: memories,
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
   * 创建或更新Agent的长期记忆
   */
  public async setLongTermMemory() {
    const { ctx } = this;
    const { agent_id, key, value, importance } = ctx.request.body;
    
    try {
      if (!agent_id || !key || !value) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'agent_id, key and value are required',
        };
        return;
      }
      
      const memory = await ctx.service.memory.setLongTermMemory(
        Number(agent_id),
        key,
        value,
        Number(importance) || 0.5
      );
      
      ctx.body = {
        success: true,
        data: memory,
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
   * 删除Agent的长期记忆
   */
  public async removeLongTermMemory() {
    const { ctx } = this;
    const { agent_id, key } = ctx.request.body;
    
    try {
      if (!agent_id || !key) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'agent_id and key are required',
        };
        return;
      }
      
      await ctx.service.memory.removeLongTermMemory(Number(agent_id), key);
      
      ctx.body = {
        success: true,
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
   * 清除Agent的短期记忆
   */
  public async clearShortTermMemory() {
    const { ctx } = this;
    const { agent_id, session_id } = ctx.request.body;
    
    try {
      if (!agent_id || !session_id) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'agent_id and session_id are required',
        };
        return;
      }
      
      await ctx.service.memory.clearShortTermMemory(Number(agent_id), session_id);
      
      ctx.body = {
        success: true,
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
   * 手动提取记忆
   */
  public async processMemoryFromText() {
    const { ctx } = this;
    const { agent_id, user_message, ai_response } = ctx.request.body;
    
    try {
      if (!agent_id || !user_message || !ai_response) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'agent_id, user_message and ai_response are required',
        };
        return;
      }
      
      await ctx.service.memory.processMemoryFromConversation(
        Number(agent_id),
        user_message,
        ai_response
      );
      
      ctx.body = {
        success: true,
      };
    } catch (error: any) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }
} 
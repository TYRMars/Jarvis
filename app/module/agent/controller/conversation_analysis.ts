import { Controller } from 'egg';

export default class ConversationAnalysisController extends Controller {
  /**
   * 分析对话
   */
  public async analyzeConversation() {
    const { ctx } = this;
    const { agent_id, session_id } = ctx.request.body;

    try {
      if (!agent_id || !session_id) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'Agent ID和会话ID不能为空',
        };
        return;
      }

      const analysis = await ctx.service.conversationAnalyzer.analyzeConversation(
        Number(agent_id),
        session_id
      );

      ctx.body = {
        success: true,
        data: analysis,
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
   * 获取Agent的所有对话分析
   */
  public async getAnalysisByAgent() {
    const { ctx } = this;
    const { agent_id } = ctx.params;
    const { page = 1, pageSize = 10 } = ctx.query;

    try {
      if (!agent_id) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'Agent ID不能为空',
        };
        return;
      }

      const analyses = await ctx.service.conversationAnalyzer.getAnalysisByAgent(
        Number(agent_id),
        Number(page),
        Number(pageSize)
      );

      ctx.body = {
        success: true,
        data: analyses,
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
   * 获取会话的对话分析
   */
  public async getAnalysisBySession() {
    const { ctx } = this;
    const { agent_id, session_id } = ctx.params;

    try {
      if (!agent_id || !session_id) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'Agent ID和会话ID不能为空',
        };
        return;
      }

      const analysis = await ctx.service.conversationAnalyzer.getAnalysisBySession(
        Number(agent_id),
        session_id
      );

      ctx.body = {
        success: true,
        data: analysis,
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
   * 获取Agent对话分析统计
   */
  public async getAgentAnalyticsStats() {
    const { ctx } = this;
    const { agent_id } = ctx.params;

    try {
      if (!agent_id) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'Agent ID不能为空',
        };
        return;
      }

      const stats = await ctx.service.conversationAnalyzer.getAgentAnalyticsStats(Number(agent_id));

      ctx.body = {
        success: true,
        data: stats,
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
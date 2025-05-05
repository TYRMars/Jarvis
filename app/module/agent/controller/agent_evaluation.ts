import { Controller } from 'egg';

export default class AgentEvaluationController extends Controller {
  /**
   * 评估Agent响应
   */
  public async evaluateResponse() {
    const { ctx } = this;
    const { agent_id, user_query, agent_response, evaluator_model = 'gpt-4' } = ctx.request.body;

    try {
      if (!agent_id || !user_query || !agent_response) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'Agent ID、用户问题和Agent响应不能为空',
        };
        return;
      }

      const evaluation = await ctx.service.agentEvaluator.evaluateResponse(
        Number(agent_id),
        user_query,
        agent_response,
        evaluator_model
      );

      ctx.body = {
        success: true,
        data: evaluation,
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
   * 获取Agent评估历史
   */
  public async getEvaluationHistory() {
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

      const history = await ctx.service.agentEvaluator.getEvaluationHistory(
        Number(agent_id),
        Number(page),
        Number(pageSize)
      );

      ctx.body = {
        success: true,
        data: history,
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
   * 获取Agent评估统计
   */
  public async getEvaluationStats() {
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

      const stats = await ctx.service.agentEvaluator.getEvaluationStats(Number(agent_id));

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

  /**
   * 运行自动评估
   */
  public async runAutomaticEvaluation() {
    const { ctx } = this;
    const { agent_id } = ctx.params;
    const { count = 5 } = ctx.request.body;

    try {
      if (!agent_id) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'Agent ID不能为空',
        };
        return;
      }

      ctx.body = {
        success: true,
        message: '自动评估已开始，请稍后查看结果',
      };

      // 异步执行自动评估
      this.evaluateAgentAsync(Number(agent_id), Number(count));
    } catch (error: any) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * 异步执行评估（不阻塞请求）
   */
  private async evaluateAgentAsync(agentId: number, count: number) {
    try {
      await this.ctx.service.agentEvaluator.runAutomaticEvaluation(agentId, count);
    } catch (error: any) {
      this.ctx.logger.error(`[AgentEvaluationController] 自动评估失败: ${error.message}`);
    }
  }
} 
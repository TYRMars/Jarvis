import { Controller } from 'egg';

export default class ConversationController extends Controller {
  /**
   * 获取对话列表
   */
  public async list() {
    const { ctx } = this;
    const user_id = ctx.user.id; // 从上下文中获取当前用户ID

    try {
      const conversations = await ctx.service.conversation.listByUser(user_id);
      ctx.body = conversations;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  }

  /**
   * 根据ID获取对话
   */
  public async getById() {
    const { ctx } = this;
    const { id } = ctx.params;
    const user_id = ctx.user.id;

    try {
      const conversation = await ctx.service.conversation.getById(id, user_id);
      if (!conversation) {
        ctx.status = 404;
        ctx.body = { error: '对话不存在' };
        return;
      }
      ctx.body = conversation;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  }

  /**
   * 删除对话
   */
  public async delete() {
    const { ctx } = this;
    const { id } = ctx.params;
    const user_id = ctx.user.id;

    try {
      const result = await ctx.service.conversation.delete(id, user_id);
      if (!result) {
        ctx.status = 404;
        ctx.body = { error: '对话不存在' };
        return;
      }
      ctx.body = { success: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  }

  /**
   * 根据Agent获取对话列表
   */
  public async listByAgent() {
    const { ctx } = this;
    const agentId = ctx.params?.agentId;
    const { page = 1, pageSize = 10 } = ctx.query;

    try {
      const conversations = await (ctx.model as any).Conversation.findAndCountAll({
        where: {
          agent_id: Number(agentId),
        },
        order: [['created_at', 'DESC']],
        limit: Number(pageSize),
        offset: (Number(page) - 1) * Number(pageSize),
      });

      ctx.body = {
        success: true,
        data: {
          total: conversations.count,
          items: conversations.rows,
          page: Number(page),
          pageSize: Number(pageSize),
        },
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
   * 获取Agent的所有会话列表
   */
  public async listSessions() {
    const { ctx } = this;
    const agentId = ctx.params?.agentId;

    try {
      // 查询该Agent的所有会话，并按照会话分组
      const result = await (ctx.model as any).Conversation.findAll({
        attributes: [
          'session_id',
          [(ctx.app as any).Sequelize.fn('MAX', (ctx.app as any).Sequelize.col('created_at')), 'last_time'],
          [(ctx.app as any).Sequelize.fn('COUNT', (ctx.app as any).Sequelize.col('id')), 'message_count'],
        ],
        where: {
          agent_id: Number(agentId),
        },
        group: ['session_id'],
        order: [[(ctx.app as any).Sequelize.literal('last_time'), 'DESC']],
      });

      // 获取每个会话的最后一条消息内容
      const sessions = await Promise.all(
        result.map(async (session: any) => {
          const lastMessage = await (ctx.model as any).Conversation.findOne({
            where: {
              agent_id: Number(agentId),
              session_id: session.session_id,
            },
            order: [['created_at', 'DESC']],
          });

          return {
            session_id: session.session_id,
            last_time: session.dataValues.last_time,
            message_count: session.dataValues.message_count,
            last_message: {
              user_input: lastMessage.user_input,
              agent_response: lastMessage.agent_response,
            },
          };
        })
      );

      ctx.body = {
        success: true,
        data: sessions,
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
   * 创建新对话
   */
  public async create() {
    const { ctx } = this;
    const { agent_id, user_input } = ctx.request.body;
    const user_id = ctx.user.id; // 从上下文中获取当前用户ID

    try {
      const conversation = await ctx.service.conversation.create({
        user_id,
        agent_id,
        user_input,
      });
      ctx.body = conversation;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  }
} 
import { Service } from 'egg';

export default class ConversationService extends Service {
  // 创建对话
  async create(params: {
    user_id: number;
    agent_id: number;
    user_input: string;
  }) {
    const { user_id, agent_id, user_input } = params;
    
    // 生成会话ID
    const session_id = `${user_id}_${Date.now()}`;
    
    // 创建对话记录
    const conversation = await this.ctx.model.Conversation.create({
      user_id,
      agent_id,
      session_id,
      user_input,
      agent_response: '', // 初始响应为空
      created_at: new Date(),
      updated_at: new Date(),
    });

    return conversation;
  }

  // 获取用户的对话列表
  async listByUser(user_id: number) {
    const conversations = await this.ctx.model.Conversation.findAll({
      where: { user_id },
      order: [['created_at', 'DESC']],
      include: [
        {
          model: this.ctx.model.Agent,
          attributes: ['id', 'name'],
        },
      ],
    });

    return conversations;
  }

  // 获取对话详情（带用户权限检查）
  async getById(id: number, user_id: number) {
    const conversation = await this.ctx.model.Conversation.findOne({
      where: { id, user_id },
      include: [
        {
          model: this.ctx.model.Agent,
          attributes: ['id', 'name'],
        },
      ],
    });

    return conversation;
  }

  // 删除对话（带用户权限检查）
  async delete(id: number, user_id: number) {
    const result = await this.ctx.model.Conversation.destroy({
      where: { id, user_id },
    });

    return result > 0;
  }
} 
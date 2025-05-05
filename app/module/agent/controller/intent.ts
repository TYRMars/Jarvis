import { Controller } from 'egg';

export default class IntentController extends Controller {
  // 创建意图
  async create() {
    const { ctx } = this;
    const { name, description, type, config } = ctx.request.body;
    const user_id = ctx.user.id;

    const intent = await ctx.service.intent.create({
      user_id,
      name,
      description,
      type,
      config,
    });

    ctx.body = {
      success: true,
      data: intent,
    };
  }

  // 添加训练样本
  async addExample() {
    const { ctx } = this;
    const { intent_id, text, entities, metadata } = ctx.request.body;

    const example = await ctx.service.intent.addExample({
      intent_id,
      text,
      entities,
      metadata,
    });

    ctx.body = {
      success: true,
      data: example,
    };
  }

  // 训练意图分类器
  async train() {
    const { ctx } = this;
    const { intent_id } = ctx.params;

    const intent = await ctx.service.intent.train(Number(intent_id));

    ctx.body = {
      success: true,
      data: intent,
    };
  }

  // 预测意图
  async predict() {
    const { ctx } = this;
    const { intent_id } = ctx.params;
    const { text } = ctx.request.body;

    const result = await ctx.service.intent.predict(Number(intent_id), text);

    ctx.body = {
      success: true,
      data: result,
    };
  }

  // 批量预测
  async batchPredict() {
    const { ctx } = this;
    const { intent_id } = ctx.params;
    const { texts } = ctx.request.body;

    const results = await ctx.service.intent.batchPredict(Number(intent_id), texts);

    ctx.body = {
      success: true,
      data: results,
    };
  }

  // 评估意图分类器
  async evaluate() {
    const { ctx } = this;
    const { intent_id } = ctx.params;
    const { test_data } = ctx.request.body;

    const result = await ctx.service.intent.evaluate(Number(intent_id), test_data);

    ctx.body = {
      success: true,
      data: result,
    };
  }

  // 获取意图列表
  async list() {
    const { ctx } = this;
    const { page = 1, pageSize = 10 } = ctx.query;
    const user_id = ctx.user.id;

    const { count, rows } = await ctx.model.Intent.findAndCountAll({
      where: { user_id },
      limit: Number(pageSize),
      offset: (Number(page) - 1) * Number(pageSize),
      order: [['created_at', 'DESC']],
    });

    ctx.body = {
      success: true,
      data: {
        list: rows,
        pagination: {
          total: count,
          page: Number(page),
          pageSize: Number(pageSize),
        },
      },
    };
  }

  // 获取意图详情
  async detail() {
    const { ctx } = this;
    const { intent_id } = ctx.params;
    const user_id = ctx.user.id;

    const intent = await ctx.model.Intent.findOne({
      where: { id: intent_id, user_id },
      include: [{
        model: ctx.model.IntentExample,
        as: 'examples',
      }],
    });

    if (!intent) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '意图不存在',
      };
      return;
    }

    ctx.body = {
      success: true,
      data: intent,
    };
  }
} 
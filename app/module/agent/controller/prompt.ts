import { Controller } from 'egg';

export default class PromptController extends Controller {
  /**
   * 创建提示模板
   */
  public async create() {
    const { ctx } = this;
    const { 
      name, 
      description, 
      content, 
      category, 
      tags, 
      variables, 
      examples, 
      version, 
      is_public, 
      created_by 
    } = ctx.request.body;

    const prompt = await ctx.model.Prompt.create({
      name,
      description,
      content,
      category,
      tags: Array.isArray(tags) ? tags.join(',') : tags,
      variables: typeof variables === 'object' ? JSON.stringify(variables) : variables,
      examples: typeof examples === 'object' ? JSON.stringify(examples) : examples,
      version,
      is_public,
      created_by,
    });

    ctx.body = {
      success: true,
      data: prompt,
    };
  }

  /**
   * 更新提示模板
   */
  public async update() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { 
      name, 
      description, 
      content, 
      category, 
      tags, 
      variables, 
      examples, 
      version, 
      is_public 
    } = ctx.request.body;

    const prompt = await ctx.model.Prompt.findByPk(id);
    if (!prompt) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '提示模板不存在',
      };
      return;
    }

    await prompt.update({
      name,
      description,
      content,
      category,
      tags: Array.isArray(tags) ? tags.join(',') : tags,
      variables: typeof variables === 'object' ? JSON.stringify(variables) : variables,
      examples: typeof examples === 'object' ? JSON.stringify(examples) : examples,
      version,
      is_public,
    });

    ctx.body = {
      success: true,
      data: prompt,
    };
  }

  /**
   * 删除提示模板
   */
  public async delete() {
    const { ctx } = this;
    const id = ctx.params.id;

    const prompt = await ctx.model.Prompt.findByPk(id);
    if (!prompt) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '提示模板不存在',
      };
      return;
    }

    // 检查是否有Agent使用此模板
    const agentsCount = await ctx.model.Agent.count({
      where: {
        prompt_id: id,
      },
    });

    if (agentsCount > 0) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        message: `该提示模板正在被${agentsCount}个Agent使用，无法删除`,
      };
      return;
    }

    await prompt.destroy();

    ctx.body = {
      success: true,
    };
  }

  /**
   * 获取提示模板详情
   */
  public async getById() {
    const { ctx } = this;
    const id = ctx.params.id;

    const prompt = await ctx.model.Prompt.findByPk(id);
    if (!prompt) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '提示模板不存在',
      };
      return;
    }

    ctx.body = {
      success: true,
      data: prompt,
    };
  }

  /**
   * 获取提示模板列表
   */
  public async list() {
    const { ctx } = this;
    const { 
      page = 1, 
      pageSize = 10,
      category,
      tag,
      is_public,
      keyword,
    } = ctx.query;

    const where: any = {};

    if (category) {
      where.category = category;
    }

    if (tag) {
      where.tags = { [ctx.model.Sequelize.Op.like]: `%${tag}%` };
    }

    if (is_public !== undefined) {
      where.is_public = is_public === 'true';
    }

    if (keyword) {
      where[ctx.model.Sequelize.Op.or] = [
        { name: { [ctx.model.Sequelize.Op.like]: `%${keyword}%` } },
        { description: { [ctx.model.Sequelize.Op.like]: `%${keyword}%` } },
      ];
    }

    const { count, rows } = await ctx.model.Prompt.findAndCountAll({
      where,
      offset: (Number(page) - 1) * Number(pageSize),
      limit: Number(pageSize),
      order: [['created_at', 'DESC']],
    });

    ctx.body = {
      success: true,
      data: {
        total: count,
        items: rows,
      },
    };
  }

  /**
   * 渲染提示模板
   */
  public async render() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { variables } = ctx.request.body;

    const prompt = await ctx.model.Prompt.findByPk(id);
    if (!prompt) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '提示模板不存在',
      };
      return;
    }

    // 渲染模板
    const renderedPrompt = await ctx.service.prompt.renderTemplate(prompt.content, variables);

    ctx.body = {
      success: true,
      data: {
        original: prompt.content,
        rendered: renderedPrompt,
        variables,
      },
    };
  }

  /**
   * 获取所有模板分类
   */
  public async getCategories() {
    const { ctx } = this;

    const categories = await ctx.model.Prompt.findAll({
      attributes: ['category'],
      group: ['category'],
    });

    ctx.body = {
      success: true,
      data: categories.map(item => item.category),
    };
  }

  /**
   * 获取所有标签
   */
  public async getTags() {
    const { ctx } = this;

    const prompts = await ctx.model.Prompt.findAll({
      attributes: ['tags'],
      where: {
        tags: {
          [ctx.model.Sequelize.Op.ne]: null,
          [ctx.model.Sequelize.Op.ne]: '',
        },
      },
    });

    // 提取所有标签并去重
    const allTags = new Set<string>();
    prompts.forEach(prompt => {
      if (prompt.tags) {
        prompt.tags.split(',').forEach(tag => {
          allTags.add(tag.trim());
        });
      }
    });

    ctx.body = {
      success: true,
      data: Array.from(allTags),
    };
  }

  /**
   * 复制提示模板
   */
  public async clone() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { name } = ctx.request.body;

    const sourcePrompt = await ctx.model.Prompt.findByPk(id);
    if (!sourcePrompt) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '源提示模板不存在',
      };
      return;
    }

    // 创建副本
    const clonedPrompt = await ctx.model.Prompt.create({
      name: name || `${sourcePrompt.name} (复制)`,
      description: sourcePrompt.description,
      content: sourcePrompt.content,
      category: sourcePrompt.category,
      tags: sourcePrompt.tags,
      variables: sourcePrompt.variables,
      examples: sourcePrompt.examples,
      version: '1.0.0', // 复制后重置版本
      is_public: sourcePrompt.is_public,
      created_by: ctx.request.body.created_by || sourcePrompt.created_by,
    });

    ctx.body = {
      success: true,
      data: clonedPrompt,
    };
  }
}
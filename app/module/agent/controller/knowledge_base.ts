import { Controller } from 'egg';

export default class KnowledgeBaseController extends Controller {
  /**
   * 创建知识库
   */
  public async create() {
    const { ctx } = this;
    const { 
      name, 
      description, 
      type, 
      config, 
      embedding_model 
    } = ctx.request.body;

    const knowledgeBase = await ctx.model.KnowledgeBase.create({
      name,
      description,
      type,
      config: typeof config === 'object' ? JSON.stringify(config) : config,
      embedding_model,
      last_updated: new Date(),
    });

    ctx.body = {
      success: true,
      data: knowledgeBase,
    };
  }

  /**
   * 更新知识库
   */
  public async update() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { 
      name, 
      description, 
      type, 
      config, 
      embedding_model,
      status 
    } = ctx.request.body;

    const knowledgeBase = await ctx.model.KnowledgeBase.findByPk(id);
    if (!knowledgeBase) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '知识库不存在',
      };
      return;
    }

    await knowledgeBase.update({
      name,
      description,
      type,
      config: typeof config === 'object' ? JSON.stringify(config) : config,
      embedding_model,
      status,
      last_updated: new Date(),
    });

    ctx.body = {
      success: true,
      data: knowledgeBase,
    };
  }

  /**
   * 删除知识库
   */
  public async delete() {
    const { ctx } = this;
    const id = ctx.params.id;

    const knowledgeBase = await ctx.model.KnowledgeBase.findByPk(id);
    if (!knowledgeBase) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '知识库不存在',
      };
      return;
    }

    // 检查是否有Agent在使用此知识库
    const agents = await ctx.model.Agent.findAll();
    const usingAgents = agents.filter(agent => {
      try {
        const knowledgeBaseIds = JSON.parse(agent.knowledge_base_ids || '[]');
        return knowledgeBaseIds.includes(Number(id));
      } catch {
        return false;
      }
    });

    if (usingAgents.length > 0) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        message: `该知识库正在被${usingAgents.length}个Agent使用，无法删除`,
      };
      return;
    }

    await knowledgeBase.destroy();

    ctx.body = {
      success: true,
    };
  }

  /**
   * 获取知识库详情
   */
  public async getById() {
    const { ctx } = this;
    const id = ctx.params.id;

    const knowledgeBase = await ctx.model.KnowledgeBase.findByPk(id);
    if (!knowledgeBase) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '知识库不存在',
      };
      return;
    }

    ctx.body = {
      success: true,
      data: knowledgeBase,
    };
  }

  /**
   * 获取知识库列表
   */
  public async list() {
    const { ctx } = this;
    const { 
      page = 1, 
      pageSize = 10,
      type,
      status,
      keyword,
    } = ctx.query;

    const where: any = {};

    if (type) {
      where.type = type;
    }

    if (status !== undefined) {
      where.status = status;
    }

    if (keyword) {
      where[ctx.model.Sequelize.Op.or] = [
        { name: { [ctx.model.Sequelize.Op.like]: `%${keyword}%` } },
        { description: { [ctx.model.Sequelize.Op.like]: `%${keyword}%` } },
      ];
    }

    const { count, rows } = await ctx.model.KnowledgeBase.findAndCountAll({
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
   * 生成知识库摘要
   */
  public async summarize() {
    const { ctx } = this;
    const id = ctx.params.id;

    try {
      const summary = await ctx.service.ai.summarizeKnowledgeBase(Number(id));
      
      ctx.body = {
        success: true,
        data: summary,
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
   * 提取知识库关键概念
   */
  public async extractConcepts() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { limit = 10 } = ctx.request.body;

    try {
      const concepts = await ctx.service.ai.extractKeyConcepts(Number(id), Number(limit));
      
      ctx.body = {
        success: true,
        data: concepts,
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
   * 生成知识库问答对
   */
  public async generateQAPairs() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { count = 10 } = ctx.request.body;

    try {
      const qaPairs = await ctx.service.ai.generateQAPairs(Number(id), Number(count));
      
      ctx.body = {
        success: true,
        data: qaPairs,
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
   * 搜索知识库
   */
  public async search() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { query, limit = 5 } = ctx.request.body;

    try {
      // 加载知识库
      const knowledgeBase = await ctx.model.KnowledgeBase.findByPk(id);
      if (!knowledgeBase) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          message: '知识库不存在',
        };
        return;
      }

      // 创建向量存储
      const vectorStore = await ctx.service.vectorStore.create([knowledgeBase]);
      
      // 执行搜索
      const results = await ctx.service.vectorStore.search(vectorStore, query, Number(limit));
      
      ctx.body = {
        success: true,
        data: results,
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
   * 批量导入知识库
   */
  public async batchImport() {
    const { ctx } = this;
    const { knowledgeBases } = ctx.request.body;

    try {
      if (!Array.isArray(knowledgeBases) || knowledgeBases.length === 0) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: '知识库数据格式不正确或为空',
        };
        return;
      }

      const result = await ctx.service.vectorStore.batchImport(knowledgeBases);

      ctx.body = {
        success: true,
        data: result,
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
   * 从文件批量导入知识（支持txt, pdf, docx, csv等）
   */
  public async batchImportFromFiles() {
    const { ctx } = this;
    try {
      const files = ctx.request.files;
      if (!files || files.length === 0) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: '未上传任何文件',
        };
        return;
      }

      const targetKbId = ctx.request.body.knowledge_base_id;
      if (!targetKbId) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: '目标知识库ID不能为空',
        };
        return;
      }

      // 调用服务处理文件导入
      const result = await ctx.service.vectorStore.importFromFiles(files, Number(targetKbId));

      ctx.body = {
        success: true,
        data: result,
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
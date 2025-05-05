import { Controller } from 'egg';

export default class ToolController extends Controller {
  /**
   * 创建工具
   */
  public async create() {
    const { ctx } = this;
    const {
      name,
      description,
      type,
      config,
      category,
      version,
      tags,
      icon,
      creator
    } = ctx.request.body;

    const tool = await ctx.model.Tool.create({
      name,
      description,
      type,
      config: typeof config === 'object' ? JSON.stringify(config) : config,
      category,
      version,
      tags: Array.isArray(tags) ? tags.join(',') : tags,
      icon,
      creator
    });

    ctx.body = {
      success: true,
      data: tool,
    };
  }

  /**
   * 更新工具
   */
  public async update() {
    const { ctx } = this;
    const id = ctx.params.id;
    const {
      name,
      description,
      type,
      config,
      category,
      version,
      tags,
      icon,
      status
    } = ctx.request.body;

    const tool = await ctx.model.Tool.findByPk(id);
    if (!tool) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '工具不存在',
      };
      return;
    }

    await tool.update({
      name,
      description,
      type,
      config: typeof config === 'object' ? JSON.stringify(config) : config,
      category,
      version,
      tags: Array.isArray(tags) ? tags.join(',') : tags,
      icon,
      status
    });

    ctx.body = {
      success: true,
      data: tool,
    };
  }

  /**
   * 删除工具
   */
  public async delete() {
    const { ctx } = this;
    const id = ctx.params.id;

    const tool = await ctx.model.Tool.findByPk(id);
    if (!tool) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '工具不存在',
      };
      return;
    }

    // 检查是否有Agent使用此工具
    const agents = await ctx.model.Agent.findAll();
    const usingAgents = agents.filter(agent => {
      try {
        const toolIds = JSON.parse(agent.tools || '[]');
        return toolIds.includes(Number(id));
      } catch {
        return false;
      }
    });

    if (usingAgents.length > 0) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        message: `该工具正在被${usingAgents.length}个Agent使用，无法删除`,
      };
      return;
    }

    await tool.destroy();

    ctx.body = {
      success: true,
    };
  }

  /**
   * 获取工具详情
   */
  public async getById() {
    const { ctx } = this;
    const id = ctx.params.id;

    const tool = await ctx.model.Tool.findByPk(id);
    if (!tool) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '工具不存在',
      };
      return;
    }

    ctx.body = {
      success: true,
      data: tool,
    };
  }

  /**
   * 获取工具列表
   */
  public async list() {
    const { ctx } = this;
    const {
      page = 1,
      pageSize = 10,
      type,
      category,
      status,
      tag,
      keyword,
    } = ctx.query;

    const where: any = {};

    if (type) {
      where.type = type;
    }

    if (category) {
      where.category = category;
    }

    if (status !== undefined) {
      where.status = status;
    }

    if (tag) {
      where.tags = { [ctx.model.Sequelize.Op.like]: `%${tag}%` };
    }

    if (keyword) {
      where[ctx.model.Sequelize.Op.or] = [
        { name: { [ctx.model.Sequelize.Op.like]: `%${keyword}%` } },
        { description: { [ctx.model.Sequelize.Op.like]: `%${keyword}%` } },
      ];
    }

    const { count, rows } = await ctx.model.Tool.findAndCountAll({
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
   * 测试工具
   */
  public async test() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { input } = ctx.request.body;

    try {
      const tool = await ctx.model.Tool.findByPk(id);
      if (!tool) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          message: '工具不存在',
        };
        return;
      }

      // 执行工具
      const result = await ctx.service.toolExecutor.executeToolById(Number(id), input);

      ctx.body = {
        success: true,
        data: {
          result,
          input,
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
   * 获取工具类型列表
   */
  public async getToolTypes() {
    const { ctx } = this;

    const toolTypes = [
      {
        type: 'api',
        name: 'API调用',
        description: '调用外部API接口',
        configSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'API地址' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: '请求方法' },
            headers: { type: 'object', description: '请求头' },
            data: { type: 'object', description: '请求数据' },
            auth: { type: 'object', description: '认证信息' },
          },
          required: ['url', 'method']
        }
      },
      {
        type: 'function',
        name: '函数调用',
        description: '执行自定义JavaScript函数',
        configSchema: {
          type: 'object',
          properties: {
            function: { type: 'string', description: '函数代码' },
            is_async: { type: 'boolean', description: '是否异步函数' },
          },
          required: ['function']
        }
      },
      {
        type: 'database',
        name: '数据库查询',
        description: '执行数据库查询操作',
        configSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'SQL查询语句' },
            params: { type: 'array', description: '查询参数' },
            database: { type: 'string', description: '数据库名称' },
          },
          required: ['query']
        }
      },
      {
        type: 'file',
        name: '文件操作',
        description: '读写文件',
        configSchema: {
          type: 'object',
          properties: {
            operations: { 
              type: 'array', 
              items: { type: 'string', enum: ['read', 'write', 'append', 'delete'] },
              description: '支持的操作类型' 
            },
            basePath: { type: 'string', description: '基础路径' },
          },
          required: ['operations']
        }
      },
      {
        type: 'search',
        name: '搜索工具',
        description: '执行搜索操作',
        configSchema: {
          type: 'object',
          properties: {
            engine: { type: 'string', description: '搜索引擎类型' },
            api_key: { type: 'string', description: 'API密钥' },
          },
          required: ['engine']
        }
      },
      {
        type: 'ai',
        name: 'AI模型调用',
        description: '调用AI模型生成内容',
        configSchema: {
          type: 'object',
          properties: {
            model: { type: 'string', description: '模型名称' },
            provider: { type: 'string', description: '提供商' },
            api_key: { type: 'string', description: 'API密钥' },
          },
          required: ['model', 'provider']
        }
      },
      {
        type: 'workflow',
        name: '工作流',
        description: '执行多步工作流',
        configSchema: {
          type: 'object',
          properties: {
            steps: { 
              type: 'array', 
              items: { 
                type: 'object',
                properties: {
                  tool_id: { type: 'number', description: '工具ID' },
                  input_mapping: { type: 'object', description: '输入映射' },
                  output_mapping: { type: 'object', description: '输出映射' },
                }
              },
              description: '工作流步骤' 
            },
          },
          required: ['steps']
        }
      },
      {
        type: 'custom',
        name: '自定义工具',
        description: '完全自定义的工具',
        configSchema: {
          type: 'object',
          properties: {
            handler: { type: 'string', description: '处理函数' },
            parameters: { type: 'object', description: '参数配置' },
          },
          required: ['handler']
        }
      }
    ];

    ctx.body = {
      success: true,
      data: toolTypes,
    };
  }

  /**
   * 获取工具分类
   */
  public async getCategories() {
    const { ctx } = this;

    const categories = await ctx.model.Tool.findAll({
      attributes: ['category'],
      group: ['category'],
    });

    ctx.body = {
      success: true,
      data: categories.map(item => item.category),
    };
  }

  /**
   * 获取工具标签
   */
  public async getTags() {
    const { ctx } = this;

    const tools = await ctx.model.Tool.findAll({
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
    tools.forEach(tool => {
      if (tool.tags) {
        tool.tags.split(',').forEach(tag => {
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
   * 复制工具
   */
  public async clone() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { name, creator } = ctx.request.body;

    const sourceTool = await ctx.model.Tool.findByPk(id);
    if (!sourceTool) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: '源工具不存在',
      };
      return;
    }

    // 创建副本
    const clonedTool = await ctx.model.Tool.create({
      name: name || `${sourceTool.name} (复制)`,
      description: sourceTool.description,
      type: sourceTool.type,
      config: sourceTool.config,
      category: sourceTool.category,
      version: '1.0.0', // 复制后重置版本
      tags: sourceTool.tags,
      icon: sourceTool.icon,
      creator: creator || sourceTool.creator,
      status: 1, // 默认启用
    });

    ctx.body = {
      success: true,
      data: clonedTool,
    };
  }

  /**
   * 导入工具
   */
  public async import() {
    const { ctx } = this;
    const { tools } = ctx.request.body;

    try {
      const createdTools = [];
      
      for (const toolData of tools) {
        // 检查是否已存在同名工具
        const existingTool = await ctx.model.Tool.findOne({
          where: {
            name: toolData.name,
          },
        });

        if (existingTool) {
          // 添加标记避免重名
          toolData.name = `${toolData.name} (导入)`;
        }

        const tool = await ctx.model.Tool.create({
          ...toolData,
          config: typeof toolData.config === 'object' ? JSON.stringify(toolData.config) : toolData.config,
          tags: Array.isArray(toolData.tags) ? toolData.tags.join(',') : toolData.tags,
        });

        createdTools.push(tool);
      }

      ctx.body = {
        success: true,
        data: {
          total: createdTools.length,
          tools: createdTools,
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
   * 验证工具配置
   */
  public async validateConfig() {
    const { ctx } = this;
    const { type, config } = ctx.request.body;

    try {
      const result = await ctx.service.toolExecutor.validateToolConfig(type, config);
      
      ctx.body = {
        success: true,
        data: result,
      };
    } catch (error: any) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        message: error.message,
        errors: error.errors,
      };
    }
  }
} 
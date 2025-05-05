import { Controller } from 'egg';

export default class LlmProviderController extends Controller {
  /**
   * 创建LLM提供商配置
   */
  public async create() {
    const { ctx } = this;
    const { 
      user_id, 
      provider, 
      name, 
      api_key, 
      base_url, 
      secret_key, 
      default_model 
    } = ctx.request.body;

    try {
      // 数据验证
      if (!provider || !name || !api_key) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: '提供商、名称和API密钥不能为空',
        };
        return;
      }

      const providerConfig = await ctx.model.LlmProviderConfig.create({
        user_id,
        provider,
        name,
        api_key,
        base_url,
        secret_key,
        default_model,
        status: 1,
      });

      ctx.body = {
        success: true,
        data: {
          ...providerConfig.toJSON(),
          api_key: '******',
          secret_key: secret_key ? '******' : null,
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
   * 更新LLM提供商配置
   */
  public async update() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { 
      name, 
      api_key, 
      base_url, 
      secret_key, 
      default_model, 
      status 
    } = ctx.request.body;

    try {
      const providerConfig = await ctx.model.LlmProviderConfig.findByPk(id);
      if (!providerConfig) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          message: '提供商配置不存在',
        };
        return;
      }

      // 更新配置，如果api_key或secret_key为空，则保持原值
      const updateData: any = {
        name,
        base_url,
        default_model,
        status,
      };

      if (api_key) {
        updateData.api_key = api_key;
      }

      if (secret_key) {
        updateData.secret_key = secret_key;
      }

      await providerConfig.update(updateData);

      ctx.body = {
        success: true,
        data: {
          ...providerConfig.toJSON(),
          api_key: '******',
          secret_key: providerConfig.secret_key ? '******' : null,
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
   * 删除LLM提供商配置
   */
  public async delete() {
    const { ctx } = this;
    const id = ctx.params.id;

    try {
      const providerConfig = await ctx.model.LlmProviderConfig.findByPk(id);
      if (!providerConfig) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          message: '提供商配置不存在',
        };
        return;
      }

      // 检查是否有Agent在使用此配置
      const usingAgents = await ctx.model.Agent.findAll({
        where: { provider_config_id: id },
      });

      if (usingAgents.length > 0) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: `该配置正在被${usingAgents.length}个Agent使用，无法删除`,
        };
        return;
      }

      await providerConfig.destroy();

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
   * 获取LLM提供商配置详情
   */
  public async getById() {
    const { ctx } = this;
    const id = ctx.params.id;

    try {
      const providerConfig = await ctx.model.LlmProviderConfig.findByPk(id);
      if (!providerConfig) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          message: '提供商配置不存在',
        };
        return;
      }

      ctx.body = {
        success: true,
        data: {
          ...providerConfig.toJSON(),
          api_key: '******',
          secret_key: providerConfig.secret_key ? '******' : null,
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
   * 获取LLM提供商配置列表
   */
  public async list() {
    const { ctx } = this;
    const { user_id, provider, page = 1, pageSize = 10 } = ctx.query;

    try {
      const where: any = {};
      
      if (user_id) {
        where.user_id = user_id;
      }
      
      if (provider) {
        where.provider = provider;
      }

      const { count, rows } = await ctx.model.LlmProviderConfig.findAndCountAll({
        where,
        offset: (Number(page) - 1) * Number(pageSize),
        limit: Number(pageSize),
        order: [['created_at', 'DESC']],
      });

      const items = rows.map(config => ({
        ...config.toJSON(),
        api_key: '******',
        secret_key: config.secret_key ? '******' : null,
      }));

      ctx.body = {
        success: true,
        data: {
          total: count,
          items,
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
   * 测试LLM提供商配置
   */
  public async testConfig() {
    const { ctx } = this;
    const { provider, api_key, base_url, secret_key, model } = ctx.request.body;

    try {
      if (!provider || !api_key) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: '提供商和API密钥不能为空',
        };
        return;
      }

      // 使用临时配置测试
      const result = await ctx.service.ai.testProviderConfig({
        provider,
        api_key,
        base_url,
        secret_key,
        model,
      });

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
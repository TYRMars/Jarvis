import { Controller } from 'egg';

export default class AIController extends Controller {
  /**
   * 生成文本
   */
  public async generate() {
    const { ctx } = this;
    const { model, prompt, params } = ctx.request.body;

    try {
      const result = await ctx.service.ai.generate(model, prompt, params);
      
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
   * 批量生成文本
   */
  public async batchGenerate() {
    const { ctx } = this;
    const { model, prompts, params } = ctx.request.body;

    try {
      const results = await ctx.service.ai.batchGenerate(model, prompts, params);
      
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
   * 使用模板生成文本
   */
  public async generateFromTemplate() {
    const { ctx } = this;
    const { model, template, variables, params } = ctx.request.body;

    try {
      const result = await ctx.service.ai.generateFromTemplate(model, template, variables, params);
      
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
   * 优化文本内容
   */
  public async optimizeContent() {
    const { ctx } = this;
    const { content, options } = ctx.request.body;

    try {
      const result = await ctx.service.ai.optimizeKnowledgeContent(content, options);
      
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
   * 创建默认提示模板
   */
  public async createDefaultTemplates() {
    const { ctx } = this;

    try {
      const result = await ctx.service.prompt.createDefaultTemplates();
      
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
   * 获取可用的LLM模型列表
   */
  public async getAvailableModels() {
    const { ctx } = this;
    
    try {
      const models = await ctx.service.ai.getAvailableModels();
      
      ctx.body = {
        success: true,
        data: models,
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
   * 测试模型连接
   */
  public async testModel() {
    const { ctx } = this;
    const { provider, model, prompt = '你好，这是一条测试消息，请回复"测试成功"。' } = ctx.request.body;
    
    try {
      if (!provider || !model) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: '提供商和模型名称不能为空',
        };
        return;
      }
      
      const response = await ctx.service.ai.generate({
        prompt,
        model,
        provider,
        temperature: 0.7,
      });
      
      ctx.body = {
        success: true,
        data: {
          response,
          model,
          provider,
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
} 
import { Controller } from 'egg';

export default class PromptEditorController extends Controller {
  /**
   * 创建提示词版本
   */
  public async createVersion() {
    const { ctx } = this;
    const { prompt_id, content, variables, version, changelog, created_by } = ctx.request.body;

    try {
      // 检查提示模板是否存在
      const prompt = await ctx.model.Prompt.findByPk(prompt_id);
      if (!prompt) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          message: '提示模板不存在',
        };
        return;
      }

      // 检查版本号是否已存在
      const existingVersion = await ctx.model.PromptVersion.findOne({
        where: {
          prompt_id,
          version,
        },
      });

      if (existingVersion) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: '该版本号已存在',
        };
        return;
      }

      // 创建新版本
      const promptVersion = await ctx.model.PromptVersion.create({
        prompt_id,
        content,
        variables: typeof variables === 'object' ? JSON.stringify(variables) : variables,
        version,
        changelog,
        created_by,
      });

      // 更新提示模板的内容和变量
      await prompt.update({
        content,
        variables: typeof variables === 'object' ? JSON.stringify(variables) : variables,
        version,
      });

      ctx.body = {
        success: true,
        data: promptVersion,
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
   * 获取提示词版本历史
   */
  public async getVersionHistory() {
    const { ctx } = this;
    const { prompt_id } = ctx.params;

    try {
      const versions = await ctx.model.PromptVersion.findAll({
        where: { prompt_id },
        order: [['created_at', 'DESC']],
      });

      ctx.body = {
        success: true,
        data: versions,
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
   * 回滚到指定版本
   */
  public async rollbackToVersion() {
    const { ctx } = this;
    const { prompt_id, version_id } = ctx.request.body;

    try {
      // 检查提示模板是否存在
      const prompt = await ctx.model.Prompt.findByPk(prompt_id);
      if (!prompt) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          message: '提示模板不存在',
        };
        return;
      }

      // 查找目标版本
      const targetVersion = await ctx.model.PromptVersion.findByPk(version_id);
      if (!targetVersion || targetVersion.prompt_id !== Number(prompt_id)) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          message: '目标版本不存在或不属于该提示模板',
        };
        return;
      }

      // 更新提示模板
      await prompt.update({
        content: targetVersion.content,
        variables: targetVersion.variables,
        version: targetVersion.version,
      });

      // 创建新版本记录表示回滚操作
      const newVersion = await ctx.model.PromptVersion.create({
        prompt_id,
        content: targetVersion.content,
        variables: targetVersion.variables,
        version: this.generateNewVersion(targetVersion.version),
        changelog: `回滚至版本 ${targetVersion.version}`,
        created_by: ctx.request.body.created_by || 'system',
      });

      ctx.body = {
        success: true,
        data: {
          prompt,
          version: newVersion,
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
   * 测试提示词
   */
  public async testPrompt() {
    const { ctx } = this;
    const { content, variables, test_input } = ctx.request.body;
    
    try {
      // 解析变量
      const parsedVariables = typeof variables === 'string' ? JSON.parse(variables) : variables;
      
      // 变量值
      const variableValues = typeof test_input === 'string' ? JSON.parse(test_input) : test_input;
      
      // 测试渲染提示词
      const renderedPrompt = await ctx.service.prompt.renderTemplate(content, parsedVariables, variableValues);
      
      // 获取变量分析
      const variableAnalysis = await ctx.service.prompt.analyzeVariables(content, parsedVariables);
      
      ctx.body = {
        success: true,
        data: {
          rendered_prompt: renderedPrompt,
          variable_analysis: variableAnalysis,
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
   * 与AI交互测试提示词
   */
  public async testPromptWithAI() {
    const { ctx } = this;
    const { content, variables, test_input, model = 'gpt-3.5-turbo' } = ctx.request.body;
    
    try {
      // 解析变量
      const parsedVariables = typeof variables === 'string' ? JSON.parse(variables) : variables;
      
      // 变量值
      const variableValues = typeof test_input === 'string' ? JSON.parse(test_input) : test_input;
      
      // 渲染提示词
      const renderedPrompt = await ctx.service.prompt.renderTemplate(content, parsedVariables, variableValues);
      
      // 使用AI模型测试
      const aiResponse = await ctx.service.ai.generate({
        prompt: renderedPrompt,
        model,
        provider: 'openai',
        temperature: 0.7,
      });
      
      ctx.body = {
        success: true,
        data: {
          rendered_prompt: renderedPrompt,
          ai_response: aiResponse,
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
   * 生成新版本号
   */
  private generateNewVersion(currentVersion: string): string {
    const versionParts = currentVersion.split('.');
    if (versionParts.length !== 3) {
      // 非标准版本号，返回新的
      return '1.0.0';
    }
    
    // 增加次要版本号
    const minor = parseInt(versionParts[1], 10) + 1;
    return `${versionParts[0]}.${minor}.0`;
  }
} 
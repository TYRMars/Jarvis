import { Service } from 'egg';
import { PromptTemplate } from '@langchain/core/prompts';

interface VariableDefinition {
  name: string;
  description: string;
  default?: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
}

interface PromptExample {
  variables: Record<string, any>;
  result: string;
  description?: string;
}

export default class PromptService extends Service {
  /**
   * 获取提示模板
   */
  public async getPromptById(id: number) {
    return await this.ctx.model.Prompt.findByPk(id);
  }

  /**
   * 渲染提示模板
   */
  public async renderTemplate(template: string, variables: Record<string, any> = {}) {
    try {
      // 使用 LangChain 的 PromptTemplate 进行渲染
      const promptTemplate = PromptTemplate.fromTemplate(template);
      const renderedPrompt = await promptTemplate.format(variables);
      return renderedPrompt;
    } catch (error) {
      this.ctx.logger.error('渲染提示模板失败:', error);
      throw new Error(`渲染提示模板失败: ${error.message}`);
    }
  }

  /**
   * 获取Agent的完整提示词
   */
  public async getAgentPrompt(agentId: number) {
    const agent = await this.ctx.model.Agent.findByPk(agentId);
    if (!agent) {
      throw new Error('Agent not found');
    }

    // 如果有自定义提示词，优先使用
    if (agent.custom_prompt) {
      return agent.custom_prompt;
    }

    // 如果有关联的提示模板，则渲染模板
    if (agent.prompt_id) {
      const prompt = await this.getPromptById(agent.prompt_id);
      if (prompt) {
        let variables = {};
        try {
          if (agent.prompt_variables) {
            variables = JSON.parse(agent.prompt_variables);
          }
        } catch (e) {
          this.ctx.logger.error('解析提示模板变量失败:', e);
        }

        return await this.renderTemplate(prompt.content, variables);
      }
    }

    // 默认使用系统提示词
    return agent.system_prompt || '';
  }

  /**
   * 验证提示模板变量
   */
  public validateTemplateVariables(content: string, variables: Record<string, any> = {}) {
    // 提取模板中的变量
    const regex = /\{([a-zA-Z0-9_]+)\}/g;
    const matches = content.match(regex) || [];
    const templateVars = [...new Set(matches.map(m => m.slice(1, -1)))];

    // 检查是否所有变量都有提供
    const missingVars = templateVars.filter(v => !(v in variables));
    return {
      isValid: missingVars.length === 0,
      templateVars,
      missingVars,
    };
  }

  /**
   * 分析提示模板
   */
  public analyzeTemplate(content: string) {
    const regex = /\{([a-zA-Z0-9_]+)\}/g;
    const matches = content.match(regex) || [];
    const variables = [...new Set(matches.map(m => m.slice(1, -1)))];

    // 计算字符数和估计token数
    const charCount = content.length;
    const tokenEstimate = Math.ceil(charCount / 4);

    return {
      variables,
      variableCount: variables.length,
      charCount,
      tokenEstimate,
    };
  }

  /**
   * 创建默认提示模板
   */
  public async createDefaultTemplates() {
    const defaultTemplates = [
      {
        name: '基础助手',
        description: '一个基础的AI助手模板',
        content: `你是一个有用的AI助手。你会提供有用、安全、简洁、准确的回答。

当用户提出问题时，请遵循以下原则:
1. 提供客观、准确的信息
2. 如果不确定，请说明你不知道
3. 避免提供错误或误导性信息
4. 保持回答简洁明了
5. 始终保持礼貌和专业

用户名称: {user_name}
当前日期: {current_date}
情境背景: {context}`,
        category: 'system',
        tags: '基础,通用',
        variables: JSON.stringify([
          {
            name: 'user_name',
            description: '用户名称',
            default: '用户',
            type: 'string',
            required: false,
          },
          {
            name: 'current_date',
            description: '当前日期',
            type: 'string',
            required: false,
          },
          {
            name: 'context',
            description: '情境背景',
            type: 'string',
            required: false,
          },
        ]),
        is_public: true,
        version: '1.0.0',
        created_by: 'system',
      },
      {
        name: 'RAG知识库助手',
        description: '适用于知识库检索的助手模板',
        content: `你是一个知识库助手，名为"{assistant_name}"。你的主要职责是基于给定的知识库内容回答用户问题。

回答问题时，请遵循以下原则:
1. 只基于提供的上下文信息回答问题
2. 如果上下文中没有相关信息，请诚实地说明你不知道
3. 不要编造事实或信息
4. 保持回答简洁和结构化
5. 使用markdown格式化你的回答以提高可读性

知识库信息:
{knowledge_context}

用户问题: {query}`,
        category: 'rag',
        tags: '知识库,检索',
        variables: JSON.stringify([
          {
            name: 'assistant_name',
            description: '助手名称',
            default: 'RAG助手',
            type: 'string',
            required: false,
          },
          {
            name: 'knowledge_context',
            description: '知识库上下文',
            type: 'string',
            required: true,
          },
          {
            name: 'query',
            description: '用户查询',
            type: 'string',
            required: true,
          },
        ]),
        is_public: true,
        version: '1.0.0',
        created_by: 'system',
      },
      {
        name: '工具使用专家',
        description: '适用于需要使用工具的场景',
        content: `你是一个擅长使用工具的AI助手。你有能力使用各种工具来完成用户的请求。

可用工具列表:
{tools_description}

使用工具时请遵循以下流程:
1. 理解用户需求
2. 确定需要使用的工具
3. 准备工具所需的输入参数
4. 使用工具并获取结果
5. 基于结果回答用户问题

始终保持专业和有帮助。如果无法使用工具解决问题，请说明原因。

用户请求: {user_request}`,
        category: 'tools',
        tags: '工具,function,api',
        variables: JSON.stringify([
          {
            name: 'tools_description',
            description: '工具描述列表',
            type: 'string',
            required: true,
          },
          {
            name: 'user_request',
            description: '用户请求',
            type: 'string',
            required: true,
          },
        ]),
        is_public: true,
        version: '1.0.0',
        created_by: 'system',
      },
    ];

    // 检查模板是否已存在
    for (const template of defaultTemplates) {
      const existing = await this.ctx.model.Prompt.findOne({
        where: {
          name: template.name,
          created_by: 'system',
        },
      });

      if (!existing) {
        await this.ctx.model.Prompt.create(template);
      }
    }

    return {
      success: true,
      message: '默认提示模板创建完成',
    };
  }

  /**
   * 分析提示词模板中的变量
   */
  public async analyzeVariables(content: string, variables: any) {
    try {
      if (!content) {
        return {
          all_variables: [],
          undefined_variables: [],
          defined_variables: [],
        };
      }

      // 查找模板中所有的变量
      const variableRegex = /\{([^{}]+)\}/g;
      const matches = content.match(variableRegex) || [];
      const allVariables = matches.map(match => match.slice(1, -1).trim());
      
      // 去重
      const uniqueVars = [...new Set(allVariables)];
      
      // 获取已定义的变量
      const definedVars = variables ? 
        (typeof variables === 'string' ? JSON.parse(variables) : variables) : 
        [];
      
      const definedVarNames = Array.isArray(definedVars) ? 
        definedVars.map(v => v.name) : 
        Object.keys(definedVars);
      
      // 查找未定义的变量
      const undefinedVars = uniqueVars.filter(v => !definedVarNames.includes(v));
      
      return {
        all_variables: uniqueVars,
        undefined_variables: undefinedVars,
        defined_variables: definedVarNames,
      };
    } catch (error: any) {
      this.ctx.logger.error('[PromptService] analyzeVariables error:', error);
      throw new Error(`分析变量失败: ${error.message}`);
    }
  }

  /**
   * 生成提示词示例
   */
  public async generateExamples(promptId: number, count = 3) {
    try {
      const prompt = await this.ctx.model.Prompt.findByPk(promptId);
      if (!prompt) {
        throw new Error('提示模板不存在');
      }
      
      // 解析变量
      const variables = prompt.variables ? JSON.parse(prompt.variables) : [];
      
      // 使用AI生成示例变量值
      const exampleValues = await this.generateExampleValues(prompt.content, variables, count);
      
      // 保存到提示模板中
      await prompt.update({
        examples: JSON.stringify(exampleValues),
      });
      
      return exampleValues;
    } catch (error: any) {
      this.ctx.logger.error('[PromptService] generateExamples error:', error);
      throw new Error(`生成示例失败: ${error.message}`);
    }
  }

  /**
   * 生成示例变量值
   */
  private async generateExampleValues(content: string, variables: any, count: number) {
    // 分析模板中的变量
    const variableAnalysis = await this.analyzeVariables(content, variables);
    
    // 如果没有变量，返回空数组
    if (variableAnalysis.all_variables.length === 0) {
      return [];
    }
    
    // 使用AI生成变量值
    const prompt = `
请生成${count}组提示词模板变量的值。提示词模板包含以下变量：
${JSON.stringify(variableAnalysis.all_variables)}

变量定义：
${JSON.stringify(variables)}

请返回格式化的JSON数组，每个元素是一个示例，包含所有变量的值。例如：
[
  {
    "变量1": "示例值1",
    "变量2": "示例值2"
  },
  {
    "变量1": "示例值3",
    "变量2": "示例值4"
  }
]
`;

    const response = await this.ctx.service.ai.generate({
      prompt,
      model: 'gpt-4',
      provider: 'openai',
      temperature: 0.8,
    });
    
    try {
      // 提取JSON部分
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('无法解析示例值');
      }
      
      return JSON.parse(jsonMatch[0]);
    } catch (error: any) {
      this.ctx.logger.error('[PromptService] 解析示例值失败:', error);
      throw new Error(`解析示例值失败: ${error.message}`);
    }
  }
} 
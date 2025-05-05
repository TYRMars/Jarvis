import { Service } from 'egg';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ChatQianfan } from 'langchain/chat_models/qianfan';
import { ChatZhipuAI } from 'langchain/chat_models/zhipu';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';

export default class AiService extends Service {
  /**
   * 获取LLM实例
   */
  public async getLLM(modelOptions: any = {}) {
    const { model = 'gpt-3.5-turbo', provider = 'openai', temperature = 0.7, provider_config_id } = modelOptions;
    const config = this.app.config.ai || {};
    
    // 获取自定义提供商配置
    let customConfig = null;
    if (provider_config_id) {
      try {
        const providerConfig = await this.ctx.model.LlmProviderConfig.findByPk(provider_config_id);
        if (providerConfig && providerConfig.status === 1) {
          customConfig = {
            provider: providerConfig.provider,
            apiKey: providerConfig.api_key,
            baseURL: providerConfig.base_url,
            secretKey: providerConfig.secret_key,
          };
        }
      } catch (error) {
        this.ctx.logger.error('Failed to load custom provider config:', error);
      }
    }
    
    // 使用自定义配置或系统默认配置
    const providerType = customConfig ? customConfig.provider : provider;
    
    switch (providerType.toLowerCase()) {
      case 'openai':
        return new ChatOpenAI({
          modelName: model,
          openAIApiKey: customConfig ? customConfig.apiKey : config.openai?.apiKey,
          basePath: customConfig?.baseURL || config.openai?.baseURL,
          temperature,
          ...modelOptions,
        });
        
      case 'anthropic':
        return new ChatAnthropic({
          modelName: model || 'claude-3-haiku-20240307',
          anthropicApiKey: customConfig ? customConfig.apiKey : config.anthropic?.apiKey,
          temperature,
          ...modelOptions,
        });
        
      case 'google':
        return new GoogleGenerativeAI({
          modelName: model || 'gemini-pro',
          apiKey: customConfig ? customConfig.apiKey : config.google?.apiKey,
          temperature,
          ...modelOptions,
        });
        
      case 'qianfan':
        return new ChatQianfan({
          modelName: model || 'ERNIE-Bot-4',
          qianfanApiKey: customConfig ? customConfig.apiKey : config.qianfan?.apiKey,
          qianfanSecretKey: customConfig ? customConfig.secretKey : config.qianfan?.secretKey,
          temperature,
          ...modelOptions,
        });
        
      case 'zhipu':
        return new ChatZhipuAI({
          modelName: model || 'glm-4',
          apiKey: customConfig ? customConfig.apiKey : config.zhipu?.apiKey,
          temperature,
          ...modelOptions,
        });
        
      default:
        throw new Error(`不支持的LLM提供商: ${provider}`);
    }
  }

  /**
   * 生成文本
   */
  public async generate(options: any) {
    const { prompt, system_prompt, history = [], model, provider, temperature } = options;
    
    try {
      const modelOptions = {
        model,
        provider,
        temperature: temperature ?? 0.7,
      };
      
      const llm = await this.getLLM(modelOptions);
      
      const messages = [];
      
      // 添加系统消息
      if (system_prompt) {
        messages.push(new SystemMessage(system_prompt));
      }
      
      // 添加历史消息
      if (Array.isArray(history) && history.length > 0) {
        for (const msg of history) {
          if (msg.role === 'user') {
            messages.push(new HumanMessage(msg.content));
          } else if (msg.role === 'assistant') {
            messages.push(new AIMessage(msg.content));
          } else if (msg.role === 'system') {
            messages.push(new SystemMessage(msg.content));
          }
        }
      }
      
      // 添加当前提示
      if (prompt) {
        messages.push(new HumanMessage(prompt));
      }
      
      const response = await llm.invoke(messages);
      return response.content;
    } catch (error: any) {
      this.ctx.logger.error('[AiService] generate error:', error);
      throw new Error(`生成失败: ${error.message}`);
    }
  }

  /**
   * 获取可用模型列表
   */
  public async getAvailableModels() {
    return {
      openai: [
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'OpenAI GPT-4o Mini模型' },
        { id: 'gpt-4o', name: 'GPT-4o', description: 'OpenAI GPT-4o模型' },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', description: 'OpenAI GPT-4 Turbo模型' },
        { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', description: 'OpenAI GPT-3.5 Turbo模型' },
      ],
      anthropic: [
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', description: 'Anthropic Claude 3 Opus模型' },
        { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet', description: 'Anthropic Claude 3 Sonnet模型' },
        { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', description: 'Anthropic Claude 3 Haiku模型' },
      ],
      google: [
        { id: 'gemini-pro', name: 'Gemini Pro', description: 'Google Gemini Pro模型' },
        { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', description: 'Google Gemini 1.5 Pro模型' },
      ],
      qianfan: [
        { id: 'ERNIE-Bot', name: 'ERNIE-Bot', description: '百度文心一言基础版' },
        { id: 'ERNIE-Bot-4', name: 'ERNIE-Bot-4', description: '百度文心一言4.0' },
        { id: 'ERNIE-Bot-8k', name: 'ERNIE-Bot-8k', description: '百度文心一言8k上下文' },
      ],
      zhipu: [
        { id: 'glm-3-turbo', name: 'GLM-3-Turbo', description: '智谱GLM-3-Turbo模型' },
        { id: 'glm-4', name: 'GLM-4', description: '智谱GLM-4模型' },
      ],
    };
  }

  /**
   * 批量生成文本
   */
  public async batchGenerate(modelName: string, prompts: string[], params: any = {}) {
    const model = await this.getLLM({
      model: modelName,
      temperature: params.temperature || 0.7,
    });
    
    const responses = await model.batch(prompts.map(p => ({ content: p })));
    return responses.map(r => r.content);
  }

  /**
   * 使用模板生成
   */
  public async generateFromTemplate(modelName: string, template: string, variables: Record<string, any>, params: any = {}) {
    const promptTemplate = PromptTemplate.fromTemplate(template);
    const prompt = await promptTemplate.format(variables);
    
    return this.generate({
      prompt,
      model: modelName,
      temperature: params.temperature || 0.7,
    });
  }

  /**
   * 自动生成知识库摘要
   */
  public async summarizeKnowledgeBase(knowledgeBaseId: number) {
    const kb = await this.ctx.model.KnowledgeBase.findByPk(knowledgeBaseId);
    if (!kb) {
      throw new Error('Knowledge base not found');
    }
    
    const config = JSON.parse(kb.config);
    let content = '';
    
    if (kb.type === 'text') {
      content = config.texts.join('\n\n');
    } else {
      // 为其他类型的知识库，我们需要加载向量存储
      const vectorStore = await this.ctx.service.vectorStore.load(`kb_${knowledgeBaseId}`);
      
      // 获取所有文档
      const docs = await vectorStore.similaritySearch('', 100);
      content = docs.map(d => d.pageContent).join('\n\n');
    }
    
    // 使用大模型生成摘要
    const summary = await this.generate({
      prompt: `
请为以下内容生成一个简洁的摘要，不超过300字：

${content.substring(0, 8000)}
      `,
      model: 'gpt-3.5-turbo',
      temperature: 0.7,
    });
    
    // 更新知识库描述
    await kb.update({
      description: summary,
    });
    
    return summary;
  }

  /**
   * 自动提取知识库关键概念
   */
  public async extractKeyConcepts(knowledgeBaseId: number, limit = 10) {
    const kb = await this.ctx.model.KnowledgeBase.findByPk(knowledgeBaseId);
    if (!kb) {
      throw new Error('Knowledge base not found');
    }
    
    const config = JSON.parse(kb.config);
    let content = '';
    
    if (kb.type === 'text') {
      content = config.texts.join('\n\n');
    } else {
      // 为其他类型的知识库，我们需要加载向量存储
      const vectorStore = await this.ctx.service.vectorStore.load(`kb_${knowledgeBaseId}`);
      
      // 获取所有文档
      const docs = await vectorStore.similaritySearch('', 100);
      content = docs.map(d => d.pageContent).join('\n\n');
    }
    
    // 使用大模型提取关键概念
    const conceptsText = await this.generate({
      prompt: `
请从以下内容中提取最重要的${limit}个关键概念或术语，并给出简短解释，格式为JSON：
[
  {
    "concept": "概念名称1",
    "explanation": "概念解释1"
  },
  ...
]

内容：
${content.substring(0, 8000)}
      `,
      model: 'gpt-3.5-turbo',
      temperature: 0.7,
    });
    
    try {
      const concepts = JSON.parse(conceptsText);
      return concepts;
    } catch (e) {
      this.ctx.logger.error('Failed to parse concepts JSON:', conceptsText);
      return [];
    }
  }

  /**
   * 从知识库生成问题
   */
  public async generateQuestions(knowledgeBaseId: number, count = 5) {
    const kb = await this.ctx.model.KnowledgeBase.findByPk(knowledgeBaseId);
    if (!kb) {
      throw new Error('Knowledge base not found');
    }
    
    const config = JSON.parse(kb.config);
    let content = '';
    
    if (kb.type === 'text') {
      content = config.texts.join('\n\n');
    } else {
      // 为其他类型的知识库，我们需要加载向量存储
      const vectorStore = await this.ctx.service.vectorStore.load(`kb_${knowledgeBaseId}`);
      
      // 获取所有文档
      const docs = await vectorStore.similaritySearch('', 100);
      content = docs.map(d => d.pageContent).join('\n\n');
    }
    
    // 使用大模型生成问题
    const questionsText = await this.generate({
      prompt: `
根据以下内容，生成${count}个可能会被问到的问题，这些问题应该能够测试对内容的理解程度。格式为JSON：
[
  "问题1",
  "问题2",
  ...
]

内容：
${content.substring(0, 8000)}
      `,
      model: 'gpt-3.5-turbo',
      temperature: 0.7,
    });
    
    try {
      const questions = JSON.parse(questionsText);
      return questions;
    } catch (e) {
      this.ctx.logger.error('Failed to parse questions JSON:', questionsText);
      return [];
    }
  }

  /**
   * 知识库内容优化
   */
  public async optimizeKnowledgeContent(content: string, options: any = {}) {
    const {
      format = 'text',
      style = 'concise',
      target = 'general',
    } = options;
    
    // 使用大模型优化内容
    const optimizedContent = await this.generate({
      prompt: `
请优化以下内容，使其更加${style === 'concise' ? '简洁清晰' : '详细全面'}，面向${target === 'general' ? '一般用户' : '专业人士'}。
${format === 'markdown' ? '使用Markdown格式输出。' : ''}

原内容：
${content}
      `,
      model: 'gpt-4',
      temperature: 0.7,
    });
    
    return optimizedContent;
  }

  /**
   * 自动问答对生成
   */
  public async generateQAPairs(knowledgeBaseId: number, count = 10) {
    const kb = await this.ctx.model.KnowledgeBase.findByPk(knowledgeBaseId);
    if (!kb) {
      throw new Error('Knowledge base not found');
    }
    
    // 先生成问题
    const questions = await this.generateQuestions(knowledgeBaseId, count);
    
    // 加载向量存储
    const vectorStore = await this.ctx.service.vectorStore.load(`kb_${knowledgeBaseId}`);
    
    // 为每个问题生成答案
    const qaPairs = [];
    for (const question of questions) {
      // 检索相关文档
      const docs = await vectorStore.similaritySearch(question, 3);
      const context = docs.map(d => d.pageContent).join('\n\n');
      
      // 使用大模型生成答案
      const answer = await this.generate({
        prompt: `
基于以下信息，回答问题：

信息：
${context}

问题：${question}

答案：
        `,
        model: 'gpt-3.5-turbo',
        temperature: 0.7,
      });
      
      qaPairs.push({
        question,
        answer,
      });
    }
    
    return qaPairs;
  }

  /**
   * 测试LLM提供商配置
   */
  public async testProviderConfig(configOptions: any) {
    const { provider, api_key, base_url, secret_key, model } = configOptions;
    
    try {
      let llm;
      
      switch (provider.toLowerCase()) {
        case 'openai':
          llm = new ChatOpenAI({
            modelName: model || 'gpt-3.5-turbo',
            openAIApiKey: api_key,
            basePath: base_url,
            temperature: 0.7,
          });
          break;
          
        case 'anthropic':
          llm = new ChatAnthropic({
            modelName: model || 'claude-3-haiku-20240307',
            anthropicApiKey: api_key,
            temperature: 0.7,
          });
          break;
          
        case 'google':
          llm = new GoogleGenerativeAI({
            modelName: model || 'gemini-pro',
            apiKey: api_key,
            temperature: 0.7,
          });
          break;
          
        case 'qianfan':
          llm = new ChatQianfan({
            modelName: model || 'ERNIE-Bot-4',
            qianfanApiKey: api_key,
            qianfanSecretKey: secret_key,
            temperature: 0.7,
          });
          break;
          
        case 'zhipu':
          llm = new ChatZhipuAI({
            modelName: model || 'glm-4',
            apiKey: api_key,
            temperature: 0.7,
          });
          break;
          
        default:
          throw new Error(`不支持的LLM提供商: ${provider}`);
      }
      
      // 发送测试消息
      const response = await llm.invoke('请回复一句"配置测试成功"用于验证连接正常');
      
      return {
        success: true,
        model: model,
        provider: provider,
        response: response.content,
      };
    } catch (error: any) {
      this.ctx.logger.error('Provider config test failed:', error);
      throw new Error(`提供商配置测试失败: ${error.message}`);
    }
  }
} 
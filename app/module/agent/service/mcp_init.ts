import { Service } from 'egg';
import { ChatOpenAI } from '@langchain/openai';

export default class McpInitService extends Service {
  public async init() {
    this.ctx.logger.info('[MCP Init] 开始初始化MCP服务...');
    
    try {
      // 注册内置模型
      await this.registerModels();
      
      // 注册内置工具
      await this.registerTools();
      
      // 初始化ReactAgent与MCP集成
      await this.initReactAgentMcpIntegration();
      
      this.ctx.logger.info('[MCP Init] MCP服务初始化完成');
    } catch (error) {
      this.ctx.logger.error('[MCP Init] MCP服务初始化失败', error);
    }
  }
  
  private async registerModels() {
    const { ctx } = this;
    
    // 获取配置的模型列表
    const configuredModels = this.app.config.ai?.models || [];
    
    for (const modelConfig of configuredModels) {
      // 创建OpenAI模型
      if (modelConfig.provider === 'openai') {
        const model = new ChatOpenAI({
          modelName: modelConfig.id,
          temperature: 0.7,
          openAIApiKey: this.app.config.ai?.openai?.apiKey,
        });
        
        // 注册到MCP主机
        ctx.service.mcpHost.registerModel(modelConfig.id, model);
        ctx.logger.info(`[MCP Init] 已注册模型: ${modelConfig.id}`);
      }
      
      // 可以添加其他模型提供商的支持
    }
  }
  
  private async registerTools() {
    const { ctx } = this;
    
    // 注册内置工具
    const tools = await ctx.model.Tool.findAll({
      where: {
        status: 1,
      },
    });
    
    for (const tool of tools) {
      try {
        const config = JSON.parse(tool.config);
        let handler;
        
        switch (tool.type) {
          case 'api':
            handler = async (params: any) => {
              const response = await ctx.curl(config.url, {
                method: config.method,
                data: params,
                headers: config.headers,
                contentType: 'json',
                dataType: 'json',
              });
              return JSON.stringify(response.data);
            };
            break;
            
          case 'function':
            handler = async (params: any) => {
              return await eval(config.function)(params);
            };
            break;
            
          case 'database':
            handler = async (params: any) => {
              const result = await ctx.model.query(params.query, {
                replacements: params.params,
              });
              return JSON.stringify(result);
            };
            break;
            
          case 'search':
            handler = async (params: any) => {
              const results = await ctx.service.search.search(params.query, params.limit);
              return JSON.stringify(results);
            };
            break;
            
          default:
            continue; // 跳过不支持的工具类型
        }
        
        // 注册工具到MCP主机
        ctx.service.mcpHost.registerTool(tool.name, handler);
        ctx.logger.info(`[MCP Init] 已注册工具: ${tool.name}`);
      } catch (error) {
        ctx.logger.error(`[MCP Init] 注册工具失败: ${tool.name}`, error);
      }
    }
  }
  
  private async initReactAgentMcpIntegration() {
    const { ctx } = this;
    
    // 注册一个特殊的ReactAgent工具，允许将ReactAgent暴露为MCP工具
    ctx.service.mcpHost.registerTool('reactAgent', async (params: any) => {
      const { agentId, message, sessionId = 'mcp-session' } = params;
      
      if (!agentId) {
        throw new Error('缺少必要参数: agentId');
      }
      
      const result = await ctx.service.reactAgent.chat(agentId, sessionId, message);
      return JSON.stringify(result);
    });
    
    ctx.logger.info('[MCP Init] 已注册ReactAgent MCP工具');
  }
} 
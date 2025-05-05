import { Controller } from 'egg';

export default class AgentController extends Controller {
  public async create() {
    const { ctx } = this;
    const { 
      name, 
      description, 
      system_prompt, 
      tools, 
      knowledge_base_ids,
      prompt_id,
      prompt_variables,
      custom_prompt,
      model_name,
      model_parameters
    } = ctx.request.body;

    const agent = await ctx.model.Agent.create({
      name,
      description,
      system_prompt,
      tools: JSON.stringify(tools),
      knowledge_base_ids: JSON.stringify(knowledge_base_ids),
      prompt_id,
      prompt_variables: typeof prompt_variables === 'object' ? JSON.stringify(prompt_variables) : prompt_variables,
      custom_prompt,
      model_name,
      model_parameters: typeof model_parameters === 'object' ? JSON.stringify(model_parameters) : model_parameters,
    });

    ctx.body = {
      success: true,
      data: agent,
    };
  }

  public async update() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { 
      name, 
      description, 
      system_prompt, 
      tools, 
      knowledge_base_ids,
      prompt_id,
      prompt_variables,
      custom_prompt,
      model_name,
      model_parameters
    } = ctx.request.body;

    const agent = await ctx.model.Agent.findByPk(id);
    if (!agent) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: 'Agent not found',
      };
      return;
    }

    await agent.update({
      name,
      description,
      system_prompt,
      tools: JSON.stringify(tools),
      knowledge_base_ids: JSON.stringify(knowledge_base_ids),
      prompt_id,
      prompt_variables: typeof prompt_variables === 'object' ? JSON.stringify(prompt_variables) : prompt_variables,
      custom_prompt,
      model_name,
      model_parameters: typeof model_parameters === 'object' ? JSON.stringify(model_parameters) : model_parameters,
    });

    ctx.body = {
      success: true,
      data: agent,
    };
  }

  public async delete() {
    const { ctx } = this;
    const id = ctx.params.id;

    const agent = await ctx.model.Agent.findByPk(id);
    if (!agent) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: 'Agent not found',
      };
      return;
    }

    await agent.destroy();

    ctx.body = {
      success: true,
    };
  }

  public async chat() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { session_id, message, use_react = false, stream = false } = ctx.request.body;

    try {
      // 如果请求流式输出
      if (stream) {
        return await this.streamChat(id, session_id, message, use_react);
      }
      
      let response;
      
      if (use_react) {
        // 使用ReAct Agent
        response = await ctx.service.reactAgent.chat(Number(id), session_id, message);
      } else {
        // 使用RAG Agent
        response = await ctx.service.ragAgent.chatWithHistory(Number(id), session_id, message);
      }
      
      ctx.body = {
        success: true,
        data: response,
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
   * 流式对话处理
   */
  private async streamChat(id: string, sessionId: string, message: string, useReact: boolean) {
    const { ctx } = this;
    
    try {
      // 设置SSE头部
      ctx.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      
      // 保持连接
      ctx.res.flushHeaders();
      
      // 定义发送事件的函数
      const sendEvent = (event: string, data: string) => {
        ctx.res.write(`event: ${event}\ndata: ${data}\n\n`);
        ctx.res.flushHeaders();
      };
      
      // 开始流式生成
      try {
        let streamGenerator;
        
        if (useReact) {
          // 目前React Agent未实现流式输出，仍使用同步方式
          const response = await ctx.service.reactAgent.chat(Number(id), sessionId, message);
          
          // 发送开始事件
          sendEvent('start', JSON.stringify({ success: true }));
          
          // 发送单个整体结果
          sendEvent('chunk', JSON.stringify({ 
            content: response,
          }));
          
          // 发送完成事件
          sendEvent('done', JSON.stringify({ success: true }));
        } else {
          // 使用RAG Agent的流式输出
          streamGenerator = await ctx.service.ragAgent.chatWithHistoryStream(Number(id), sessionId, message);
          
          // 发送开始事件
          sendEvent('start', JSON.stringify({ success: true }));
          
          // 处理流式输出
          for await (const chunk of streamGenerator) {
            sendEvent('chunk', JSON.stringify({ 
              content: chunk,
            }));
          }
          
          // 发送完成事件
          sendEvent('done', JSON.stringify({ success: true }));
        }
      } catch (error: any) {
        // 发送错误事件
        sendEvent('error', JSON.stringify({ 
          success: false, 
          message: error.message,
        }));
      }
      
      // 结束响应
      ctx.res.end();
    } catch (error: any) {
      // 如果在设置SSE过程中发生错误，则返回常规错误响应
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }

  public async getById() {
    const { ctx } = this;
    const id = ctx.params.id;

    const agent = await ctx.model.Agent.findByPk(id);
    if (!agent) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: 'Agent not found',
      };
      return;
    }

    // 如果有关联提示模板ID，获取提示模板详情
    if (agent.prompt_id) {
      const prompt = await ctx.model.Prompt.findByPk(agent.prompt_id);
      if (prompt) {
        const agentData = agent.toJSON();
        agentData.prompt = prompt;
        ctx.body = {
          success: true,
          data: agentData,
        };
        return;
      }
    }

    ctx.body = {
      success: true,
      data: agent,
    };
  }

  public async list() {
    const { ctx } = this;
    const { page = 1, pageSize = 10 } = ctx.query;

    const { count, rows } = await ctx.model.Agent.findAndCountAll({
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

  public async searchKnowledge() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { query, limit = 5 } = ctx.request.body;

    try {
      const results = await ctx.service.ragAgent.searchKnowledgeBase(Number(id), query, Number(limit));
      
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

  public async clearSession() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { session_id } = ctx.request.body;

    try {
      await ctx.service.ragAgent.clearSession(Number(id), session_id);
      
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

  public async getPrompt() {
    const { ctx } = this;
    const id = ctx.params.id;

    try {
      const prompt = await ctx.service.prompt.getAgentPrompt(Number(id));
      
      ctx.body = {
        success: true,
        data: prompt,
      };
    } catch (error: any) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }

  public async setCustomPrompt() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { custom_prompt } = ctx.request.body;

    const agent = await ctx.model.Agent.findByPk(id);
    if (!agent) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: 'Agent not found',
      };
      return;
    }

    await agent.update({
      custom_prompt
    });

    ctx.body = {
      success: true,
      data: agent,
    };
  }

  public async setPromptTemplate() {
    const { ctx } = this;
    const id = ctx.params.id;
    const { prompt_id, prompt_variables } = ctx.request.body;

    const agent = await ctx.model.Agent.findByPk(id);
    if (!agent) {
      ctx.status = 404;
      ctx.body = {
        success: false,
        message: 'Agent not found',
      };
      return;
    }

    // 检查prompt_id是否存在
    if (prompt_id) {
      const prompt = await ctx.model.Prompt.findByPk(prompt_id);
      if (!prompt) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: '提示模板不存在',
        };
        return;
      }
    }

    await agent.update({
      prompt_id,
      prompt_variables: typeof prompt_variables === 'object' ? JSON.stringify(prompt_variables) : prompt_variables,
    });

    ctx.body = {
      success: true,
      data: agent,
    };
  }

  /**
   * 批量创建Agent
   */
  public async batchCreate() {
    const { ctx } = this;
    const { agents } = ctx.request.body;

    try {
      if (!Array.isArray(agents) || agents.length === 0) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: 'Agent数据格式不正确或为空',
        };
        return;
      }

      const createdAgents = [];
      const errors = [];

      // 批量创建Agent
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        try {
          // 基本数据验证
          if (!agent.name) {
            errors.push({ index: i, message: 'Agent名称不能为空' });
            continue;
          }

          // 创建Agent
          const createdAgent = await ctx.model.Agent.create({
            name: agent.name,
            description: agent.description,
            system_prompt: agent.system_prompt,
            tools: JSON.stringify(agent.tools || []),
            knowledge_base_ids: JSON.stringify(agent.knowledge_base_ids || []),
            prompt_id: agent.prompt_id,
            prompt_variables: typeof agent.prompt_variables === 'object' ? 
              JSON.stringify(agent.prompt_variables) : agent.prompt_variables,
            custom_prompt: agent.custom_prompt,
            model_name: agent.model_name || 'gpt-3.5-turbo',
            model_parameters: typeof agent.model_parameters === 'object' ? 
              JSON.stringify(agent.model_parameters) : agent.model_parameters,
          });

          createdAgents.push(createdAgent);
        } catch (error: any) {
          errors.push({ index: i, message: error.message });
        }
      }

      ctx.body = {
        success: true,
        data: {
          total: createdAgents.length,
          created: createdAgents,
          errors: errors.length > 0 ? errors : null,
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
   * 从模板批量创建Agent
   */
  public async batchCreateFromTemplates() {
    const { ctx } = this;
    const { template_id, variations } = ctx.request.body;

    try {
      if (!template_id) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: '模板ID不能为空',
        };
        return;
      }

      if (!Array.isArray(variations) || variations.length === 0) {
        ctx.status = 400;
        ctx.body = {
          success: false,
          message: '变量数据格式不正确或为空',
        };
        return;
      }

      // 获取模板Agent
      const templateAgent = await ctx.model.Agent.findByPk(template_id);
      if (!templateAgent) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          message: '模板Agent不存在',
        };
        return;
      }

      const createdAgents = [];
      const errors = [];

      // 批量创建基于模板的Agent
      for (let i = 0; i < variations.length; i++) {
        const variation = variations[i];
        try {
          // 基本数据验证
          if (!variation.name) {
            errors.push({ index: i, message: 'Agent名称不能为空' });
            continue;
          }

          // 创建Agent
          const agentData = {
            ...templateAgent.toJSON(),
            id: undefined, // 不复制ID
            name: variation.name,
            created_at: undefined,
            updated_at: undefined,
          };

          // 应用变量覆盖
          if (variation.overrides) {
            Object.assign(agentData, variation.overrides);
          }

          const createdAgent = await ctx.model.Agent.create(agentData);
          createdAgents.push(createdAgent);
        } catch (error: any) {
          errors.push({ index: i, message: error.message });
        }
      }

      ctx.body = {
        success: true,
        data: {
          total: createdAgents.length,
          created: createdAgents,
          errors: errors.length > 0 ? errors : null,
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
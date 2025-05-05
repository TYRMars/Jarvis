import { Controller } from 'egg';

export default class WorkflowController extends Controller {
  // 创建工作流
  public async create() {
    const { ctx } = this;
    const { name, description, workflow_type, config } = ctx.request.body;
    const user_id = ctx.user.id;

    try {
      const workflow = await ctx.service.workflow.createWorkflow({
        user_id,
        name,
        description,
        workflow_type,
        config,
      });
      ctx.body = workflow;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  }

  // 创建工作流节点
  public async createNode() {
    const { ctx } = this;
    const { workflow_id, node_type, name, config, position, edges } = ctx.request.body;

    try {
      const node = await ctx.service.workflow.createNode({
        workflow_id,
        node_type,
        name,
        config,
        position,
        edges,
      });
      ctx.body = node;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  }

  // 执行工作流
  public async execute() {
    const { ctx } = this;
    const { workflow_id } = ctx.params;
    const { input } = ctx.request.body;

    try {
      const result = await ctx.service.workflow.executeWorkflow(workflow_id, input);
      ctx.body = result;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  }

  // 获取工作流列表
  public async list() {
    const { ctx } = this;
    const user_id = ctx.user.id;

    try {
      const workflows = await ctx.model.AgentWorkflow.findAll({
        where: { user_id },
        include: [{
          model: ctx.model.AgentWorkflowNode,
          as: 'nodes',
        }],
      });
      ctx.body = workflows;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  }

  // 获取工作流详情
  public async getById() {
    const { ctx } = this;
    const { id } = ctx.params;
    const user_id = ctx.user.id;

    try {
      const workflow = await ctx.model.AgentWorkflow.findOne({
        where: { id, user_id },
        include: [{
          model: ctx.model.AgentWorkflowNode,
          as: 'nodes',
        }],
      });
      if (!workflow) {
        ctx.status = 404;
        ctx.body = { error: '工作流不存在' };
        return;
      }
      ctx.body = workflow;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error.message };
    }
  }
} 
import { Controller } from 'egg';

export default class McpServerController extends Controller {
  public async create() {
    const { ctx } = this;
    const data = ctx.request.body;

    try {
      const server = await ctx.service.mcpServer.create(data);
      ctx.body = {
        success: true,
        data: server,
      };
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }

  public async update() {
    const { ctx } = this;
    const { id } = ctx.params;
    const data = ctx.request.body;

    try {
      const server = await ctx.service.mcpServer.update(Number(id), data);
      ctx.body = {
        success: true,
        data: server,
      };
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }

  public async delete() {
    const { ctx } = this;
    const { id } = ctx.params;

    try {
      await ctx.service.mcpServer.delete(Number(id));
      ctx.body = {
        success: true,
      };
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }

  public async get() {
    const { ctx } = this;
    const { id } = ctx.params;

    try {
      const server = await ctx.service.mcpServer.getById(Number(id));
      if (!server) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          message: 'MCP Server not found',
        };
        return;
      }
      ctx.body = {
        success: true,
        data: server,
      };
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }

  public async list() {
    const { ctx } = this;

    try {
      const servers = await ctx.service.mcpServer.list();
      ctx.body = {
        success: true,
        data: servers,
      };
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }

  public async testConnection() {
    const { ctx } = this;
    const { id } = ctx.params;

    try {
      const result = await ctx.service.mcpServer.testConnection(Number(id));
      ctx.body = {
        success: true,
        data: result,
      };
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }

  public async executeCommand() {
    const { ctx } = this;
    const { id } = ctx.params;
    const { command, params } = ctx.request.body;

    try {
      const result = await ctx.service.mcpServer.executeCommand(Number(id), command, params);
      ctx.body = {
        success: true,
        data: result,
      };
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: error.message,
      };
    }
  }
} 
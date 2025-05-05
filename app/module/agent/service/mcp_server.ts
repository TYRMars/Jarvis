import { Service } from 'egg';
import { McpServer } from '../model/mcp_server';

export default class McpServerService extends Service {
  public async create(data: Partial<McpServer>) {
    return await this.ctx.model.McpServer.create(data);
  }

  public async update(id: number, data: Partial<McpServer>) {
    const server = await this.ctx.model.McpServer.findByPk(id);
    if (!server) {
      throw new Error('MCP Server not found');
    }
    return await server.update(data);
  }

  public async delete(id: number) {
    const server = await this.ctx.model.McpServer.findByPk(id);
    if (!server) {
      throw new Error('MCP Server not found');
    }
    return await server.destroy();
  }

  public async getById(id: number) {
    return await this.ctx.model.McpServer.findByPk(id);
  }

  public async list() {
    return await this.ctx.model.McpServer.findAll({
      where: {
        status: 1,
      },
    });
  }

  public async testConnection(id: number) {
    const server = await this.getById(id);
    if (!server) {
      throw new Error('MCP Server not found');
    }

    try {
      const url = `${server.protocol}://${server.host}:${server.port}/health`;
      const result = await this.ctx.curl(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${server.api_key}`,
        },
        timeout: 5000,
      });

      return {
        success: result.status === 200,
        status: result.status,
        data: result.data,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  public async executeCommand(id: number, command: string, params: any = {}) {
    const server = await this.getById(id);
    if (!server) {
      throw new Error('MCP Server not found');
    }

    try {
      const url = `${server.protocol}://${server.host}:${server.port}/execute`;
      const result = await this.ctx.curl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${server.api_key}`,
        },
        data: {
          command,
          params,
        },
        timeout: 30000,
      });

      return {
        success: result.status === 200,
        status: result.status,
        data: result.data,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
} 
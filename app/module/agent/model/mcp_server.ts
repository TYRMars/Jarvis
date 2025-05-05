import { Application } from 'egg';

export default (app: Application) => {
  const { STRING, INTEGER, TEXT, DATE } = app.Sequelize;

  const McpServer = app.model.define('mcp_server', {
    id: {
      type: INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: STRING(100),
      allowNull: false,
      comment: 'MCP Server名称',
    },
    description: {
      type: TEXT,
      allowNull: true,
      comment: 'MCP Server描述',
    },
    host: {
      type: STRING(100),
      allowNull: false,
      comment: '服务器地址',
    },
    port: {
      type: INTEGER,
      allowNull: false,
      comment: '服务器端口',
    },
    protocol: {
      type: STRING(20),
      allowNull: false,
      defaultValue: 'http',
      comment: '协议类型：http/https',
    },
    api_key: {
      type: STRING(100),
      allowNull: true,
      comment: 'API密钥',
    },
    config: {
      type: TEXT,
      allowNull: true,
      comment: '额外配置，JSON格式',
    },
    status: {
      type: INTEGER,
      allowNull: false,
      defaultValue: 1,
      comment: '状态：1-启用，0-禁用',
    },
    created_at: {
      type: DATE,
      allowNull: false,
    },
    updated_at: {
      type: DATE,
      allowNull: false,
    },
  }, {
    tableName: 'mcp_servers',
    timestamps: true,
    underscored: true,
  });

  return McpServer;
}; 
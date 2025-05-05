import { Application } from 'egg';

export default (app: Application) => {
  const { STRING, INTEGER, TEXT, DATE } = app.Sequelize;

  const Conversation = app.model.define('conversation', {
    id: {
      type: INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: INTEGER,
      allowNull: false,
      comment: '用户ID',
    },
    agent_id: {
      type: INTEGER,
      allowNull: false,
      comment: '关联的Agent ID',
    },
    session_id: {
      type: STRING(100),
      allowNull: false,
      comment: '会话ID',
    },
    user_input: {
      type: TEXT,
      allowNull: false,
      comment: '用户输入',
    },
    agent_response: {
      type: TEXT,
      allowNull: false,
      comment: 'Agent响应',
    },
    tools_used: {
      type: TEXT,
      allowNull: true,
      comment: '使用的工具，JSON格式',
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
    tableName: 'conversations',
    timestamps: true,
    underscored: true,
  });

  // 添加关联关系
  Conversation.associate = function() {
    app.model.Conversation.belongsTo(app.model.User, { foreignKey: 'user_id' });
    app.model.Conversation.belongsTo(app.model.Agent, { foreignKey: 'agent_id' });
  };

  return Conversation;
}; 
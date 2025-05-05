import { Application } from 'egg';

export default (app: Application) => {
  const { STRING, INTEGER, TEXT, DATE, JSON } = app.Sequelize;

  const AgentWorkflow = app.model.define('agent_workflow', {
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
    name: {
      type: STRING(100),
      allowNull: false,
      comment: '工作流名称',
    },
    description: {
      type: TEXT,
      allowNull: true,
      comment: '工作流描述',
    },
    workflow_type: {
      type: STRING(50),
      allowNull: false,
      defaultValue: 'intent_classification',
      comment: '工作流类型：intent_classification-意图识别, task_routing-任务路由, etc',
    },
    config: {
      type: JSON,
      allowNull: false,
      comment: '工作流配置',
    },
    state: {
      type: JSON,
      allowNull: true,
      comment: '工作流状态',
    },
    status: {
      type: INTEGER,
      allowNull: false,
      defaultValue: 1,
      comment: '状态：0-禁用，1-启用',
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
    tableName: 'agent_workflows',
    timestamps: true,
    underscored: true,
  });

  // 添加关联关系
  AgentWorkflow.associate = function() {
    app.model.AgentWorkflow.belongsTo(app.model.User, { foreignKey: 'user_id' });
    app.model.AgentWorkflow.hasMany(app.model.AgentWorkflowNode, { foreignKey: 'workflow_id' });
  };

  return AgentWorkflow;
}; 
import { Application } from 'egg';

export default (app: Application) => {
  const { STRING, INTEGER, TEXT, DATE, JSON } = app.Sequelize;

  const AgentWorkflowNode = app.model.define('agent_workflow_node', {
    id: {
      type: INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    workflow_id: {
      type: INTEGER,
      allowNull: false,
      comment: '工作流ID',
    },
    node_type: {
      type: STRING(50),
      allowNull: false,
      comment: '节点类型：intent_classifier-意图分类器, tool_executor-工具执行器, rag_retriever-RAG检索器, etc',
    },
    name: {
      type: STRING(100),
      allowNull: false,
      comment: '节点名称',
    },
    config: {
      type: JSON,
      allowNull: false,
      comment: '节点配置',
    },
    position: {
      type: JSON,
      allowNull: false,
      comment: '节点在工作流中的位置',
    },
    edges: {
      type: JSON,
      allowNull: true,
      comment: '节点连接关系',
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
    tableName: 'agent_workflow_nodes',
    timestamps: true,
    underscored: true,
  });

  // 添加关联关系
  AgentWorkflowNode.associate = function() {
    app.model.AgentWorkflowNode.belongsTo(app.model.AgentWorkflow, { foreignKey: 'workflow_id' });
  };

  return AgentWorkflowNode;
}; 
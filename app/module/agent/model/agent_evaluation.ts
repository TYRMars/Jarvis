import { Model, DataTypes } from 'sequelize';

export default class AgentEvaluation extends Model {
  public id!: number;
  public agent_id!: number;
  public user_query!: string;
  public agent_response!: string;
  public evaluator_model!: string;
  public accuracy_score!: number;
  public relevance_score!: number;
  public helpfulness_score!: number;
  public toxicity_score!: number;
  public overall_score!: number;
  public evaluation_feedback!: string;
  public suggested_improvements!: string;
  public evaluated_at!: Date;
  public created_at!: Date;
  public updated_at!: Date;

  static associate(models: any) {
    // 评估关联到Agent
    AgentEvaluation.belongsTo(models.Agent, {
      foreignKey: 'agent_id',
    });
  }
}

export const schema = {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  agent_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'Agent ID',
  },
  user_query: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '用户查询',
  },
  agent_response: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: 'Agent响应',
  },
  evaluator_model: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '评估使用的模型',
  },
  accuracy_score: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: '准确性得分(0-10)',
  },
  relevance_score: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: '相关性得分(0-10)',
  },
  helpfulness_score: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: '有用性得分(0-10)',
  },
  toxicity_score: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: '无害性得分(0-10，越高越安全)',
  },
  overall_score: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: '总体得分(0-10)',
  },
  evaluation_feedback: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '评估反馈',
  },
  suggested_improvements: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '建议改进',
  },
  evaluated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    comment: '评估时间',
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}; 
import { Model, DataTypes } from 'sequelize';

export default class ConversationAnalysis extends Model {
  public id!: number;
  public agent_id!: number;
  public session_id!: string;
  public conversation_length!: number;
  public topic!: string;
  public key_points!: string;
  public sentiment_score!: number;
  public user_satisfaction!: number;
  public questions_asked!: number;
  public issues_resolved!: number;
  public analysis_summary!: string;
  public created_at!: Date;
  public updated_at!: Date;

  static associate(models: any) {
    // 分析关联到Agent
    ConversationAnalysis.belongsTo(models.Agent, {
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
  session_id: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '会话ID',
  },
  conversation_length: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: '对话轮次',
  },
  topic: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: '主题',
  },
  key_points: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '关键点，JSON格式',
  },
  sentiment_score: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: '情感得分(-1到1)',
  },
  user_satisfaction: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: '用户满意度(0-10)',
  },
  questions_asked: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: '提问数量',
  },
  issues_resolved: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: '解决的问题数量',
  },
  analysis_summary: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '分析摘要',
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
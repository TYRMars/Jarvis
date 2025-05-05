import { Model, DataTypes } from 'sequelize';

export default class KnowledgeBase extends Model {
  public id!: number;
  public name!: string;
  public description!: string;
  public type!: string;
  public config!: string;
  public status!: number;
  public embedding_model!: string;
  public last_updated!: Date;
  public created_at!: Date;
  public updated_at!: Date;

  static associate(models: any) {
    // 知识库可以被多个Agent使用
    KnowledgeBase.belongsToMany(models.Agent, {
      through: 'agent_knowledge_bases',
      foreignKey: 'knowledge_base_id',
      otherKey: 'agent_id',
    });
  }
}

export const schema = {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '知识库名称',
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '知识库描述',
  },
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '知识库类型：file, text, database, api',
  },
  config: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '知识库配置，JSON格式',
  },
  status: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: '状态：0-禁用，1-启用',
  },
  embedding_model: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'text-embedding-3-small',
    comment: '使用的嵌入模型',
  },
  last_updated: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: '最后更新时间',
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
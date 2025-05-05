import { Model, DataTypes } from 'sequelize';

export default class Tool extends Model {
  public id!: number;
  public name!: string;
  public description!: string;
  public type!: string;
  public config!: string;
  public status!: number;
  public category!: string;
  public version!: string;
  public tags!: string;
  public created_at!: Date;
  public updated_at!: Date;

  static associate(models: any) {
    // 工具可以被多个Agent使用
    Tool.belongsToMany(models.Agent, {
      through: 'agent_tools',
      foreignKey: 'tool_id',
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
    comment: '工具名称',
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '工具描述',
  },
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '工具类型：api, function, database, file, search, ai, workflow, mcp',
  },
  config: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '工具配置，JSON格式',
  },
  status: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: '状态：0-禁用，1-启用',
  },
  category: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '工具分类：system, custom, integration',
  },
  version: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: '1.0.0',
    comment: '工具版本',
  },
  tags: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: '工具标签，逗号分隔',
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
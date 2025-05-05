import { Model, DataTypes } from 'sequelize';

export default class Prompt extends Model {
  public id!: number;
  public name!: string;
  public description!: string;
  public content!: string;
  public category!: string;
  public tags!: string;
  public variables!: string;
  public examples!: string;
  public version!: string;
  public is_public!: boolean;
  public created_by!: string;
  public created_at!: Date;
  public updated_at!: Date;

  static associate(models: any) {
    // Prompt可以被多个Agent使用
    Prompt.hasMany(models.Agent, {
      foreignKey: 'prompt_id',
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
    comment: '提示名称',
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '提示描述',
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '提示内容模板',
  },
  category: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '提示分类：system, user, assistant, function',
  },
  tags: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: '标签，逗号分隔',
  },
  variables: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '变量列表，JSON格式，包含变量名、描述、默认值等',
  },
  examples: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '使用示例，JSON格式',
  },
  version: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: '1.0.0',
    comment: '版本号',
  },
  is_public: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    comment: '是否公开：true-公开，false-私有',
  },
  created_by: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: '创建者',
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
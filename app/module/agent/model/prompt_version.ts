import { Model, DataTypes } from 'sequelize';

export default class PromptVersion extends Model {
  public id!: number;
  public prompt_id!: number;
  public content!: string;
  public variables!: string;
  public version!: string;
  public changelog!: string;
  public created_by!: string;
  public created_at!: Date;
  public updated_at!: Date;

  static associate(models: any) {
    // 版本关联到提示模板
    PromptVersion.belongsTo(models.Prompt, {
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
  prompt_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '提示模板ID',
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '提示内容模板',
  },
  variables: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '变量列表，JSON格式，包含变量名、描述、默认值等',
  },
  version: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '版本号',
  },
  changelog: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '变更日志',
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
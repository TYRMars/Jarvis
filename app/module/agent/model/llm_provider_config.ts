import { Model, DataTypes } from 'sequelize';

export default class LlmProviderConfig extends Model {
  public id!: number;
  public user_id!: number;
  public provider!: string;
  public name!: string;
  public api_key!: string;
  public base_url!: string;
  public secret_key!: string;
  public default_model!: string;
  public status!: number;
  public created_at!: Date;
  public updated_at!: Date;

  static associate(models: any) {
    // 可以关联到用户模型（如果有的话）
  }
}

export const schema = {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '用户ID',
  },
  provider: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '提供商代码：openai, anthropic, google, qianfan, zhipu',
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '配置名称',
  },
  api_key: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: 'API密钥',
  },
  base_url: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: '自定义API地址',
  },
  secret_key: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '附加密钥（如百度文心API的secret_key）',
  },
  default_model: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: '默认使用的模型',
  },
  status: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: '状态：0-禁用，1-启用',
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
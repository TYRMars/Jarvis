import { Model, DataTypes } from 'sequelize';

export default class Agent extends Model {
  public id!: number;
  public name!: string;
  public description!: string;
  public system_prompt!: string;
  public tools!: string;
  public knowledge_base_ids!: string;
  public prompt_id!: number;
  public prompt_variables!: string;
  public custom_prompt!: string;
  public model_name!: string;
  public model_parameters!: string;
  public provider!: string;
  public provider_config_id!: number;
  public status!: number;
  public created_at!: Date;
  public updated_at!: Date;
  public workflow_type!: string;
  public user_id!: number;

  static associate(models: any) {
    // Agent可以使用多个工具
    Agent.belongsToMany(models.Tool, {
      through: 'agent_tools',
      foreignKey: 'agent_id',
      otherKey: 'tool_id',
    });

    // Agent可以使用多个知识库
    Agent.belongsToMany(models.KnowledgeBase, {
      through: 'agent_knowledge_bases',
      foreignKey: 'agent_id',
      otherKey: 'knowledge_base_id',
    });

    // Agent可以关联一个提示模板
    Agent.belongsTo(models.Prompt, {
      foreignKey: 'prompt_id',
    });
    
    // Agent可以关联LLM提供商配置
    Agent.belongsTo(models.LlmProviderConfig, {
      foreignKey: 'provider_config_id',
    });

    // Agent可以关联用户
    Agent.belongsTo(models.User, { foreignKey: 'user_id' });

    // Agent可以关联多个对话
    Agent.hasMany(models.Conversation, { foreignKey: 'agent_id' });
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
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '名称',
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '描述',
  },
  system_prompt: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '系统提示词',
  },
  tools: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '工具ID列表，JSON格式',
  },
  knowledge_base_ids: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '知识库ID列表，JSON格式',
  },
  prompt_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: '提示模板ID',
  },
  prompt_variables: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '提示模板变量值，JSON格式',
  },
  custom_prompt: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '自定义提示词，优先级高于系统提示词和模板',
  },
  model_name: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'gpt-3.5-turbo',
    comment: '使用的模型名称',
  },
  model_parameters: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '模型参数，JSON格式',
  },
  provider: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'openai',
    comment: 'LLM提供商：openai, anthropic, google, qianfan, zhipu',
  },
  provider_config_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'LLM提供商配置ID，为空则使用系统默认配置',
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
  workflow_type: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: 'simple',
    comment: '工作流类型: simple, conversation, graph',
  },
}; 
import { Model, DataTypes } from 'sequelize';

export default class Memory extends Model {
  public id!: number;
  public agent_id!: number;
  public key!: string;
  public value!: string;
  public importance!: number;
  public last_accessed!: Date;
  public created_at!: Date;
  public updated_at!: Date;

  static associate(models: any) {
    // Memory属于某个Agent
    Memory.belongsTo(models.Agent, {
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
  key: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '记忆标识键',
  },
  value: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '记忆内容',
  },
  importance: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0.5,
    comment: '重要性评分(0-1)',
  },
  last_accessed: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    comment: '最后访问时间',
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
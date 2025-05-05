import { Application } from 'egg';

export default (app: Application) => {
  const { STRING, INTEGER, TEXT, DATE, JSON } = app.Sequelize;

  const Intent = app.model.define('intent', {
    id: {
      type: INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: INTEGER,
      allowNull: false,
      comment: '用户ID',
    },
    name: {
      type: STRING(100),
      allowNull: false,
      comment: '意图名称',
    },
    description: {
      type: TEXT,
      allowNull: true,
      comment: '意图描述',
    },
    type: {
      type: STRING(50),
      allowNull: false,
      defaultValue: 'classification',
      comment: '意图类型：classification-分类, extraction-抽取, etc',
    },
    config: {
      type: JSON,
      allowNull: false,
      comment: '意图分类器配置',
    },
    training_data: {
      type: JSON,
      allowNull: true,
      comment: '训练数据',
    },
    model_info: {
      type: JSON,
      allowNull: true,
      comment: '模型信息',
    },
    status: {
      type: INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: '状态：0-未训练，1-训练中，2-已训练，3-训练失败',
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
    tableName: 'intents',
    timestamps: true,
    underscored: true,
  });

  // 添加关联关系
  Intent.associate = function() {
    app.model.Intent.belongsTo(app.model.User, { foreignKey: 'user_id' });
    app.model.Intent.hasMany(app.model.IntentExample, { foreignKey: 'intent_id' });
  };

  return Intent;
}; 
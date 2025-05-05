import { Application } from 'egg';

export default (app: Application) => {
  const { STRING, INTEGER, TEXT, DATE, JSON } = app.Sequelize;

  const IntentExample = app.model.define('intent_example', {
    id: {
      type: INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    intent_id: {
      type: INTEGER,
      allowNull: false,
      comment: '意图ID',
    },
    text: {
      type: TEXT,
      allowNull: false,
      comment: '示例文本',
    },
    entities: {
      type: JSON,
      allowNull: true,
      comment: '实体信息',
    },
    metadata: {
      type: JSON,
      allowNull: true,
      comment: '元数据',
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
    tableName: 'intent_examples',
    timestamps: true,
    underscored: true,
  });

  // 添加关联关系
  IntentExample.associate = function() {
    app.model.IntentExample.belongsTo(app.model.Intent, { foreignKey: 'intent_id' });
  };

  return IntentExample;
}; 
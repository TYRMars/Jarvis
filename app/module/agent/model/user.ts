import { Application } from 'egg';

export default (app: Application) => {
  const { STRING, INTEGER, DATE, TEXT } = app.Sequelize;

  const User = app.model.define('user', {
    id: {
      type: INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    username: {
      type: STRING(50),
      allowNull: false,
      unique: true,
      comment: '用户名',
    },
    email: {
      type: STRING(100),
      allowNull: false,
      unique: true,
      comment: '邮箱',
    },
    password: {
      type: STRING(100),
      allowNull: false,
      comment: '密码',
    },
    nickname: {
      type: STRING(50),
      allowNull: true,
      comment: '昵称',
    },
    avatar: {
      type: STRING(255),
      allowNull: true,
      comment: '头像URL',
    },
    status: {
      type: INTEGER,
      allowNull: false,
      defaultValue: 1,
      comment: '状态：0-禁用，1-启用',
    },
    last_login_at: {
      type: DATE,
      allowNull: true,
      comment: '最后登录时间',
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
    tableName: 'users',
    timestamps: true,
    underscored: true,
  });

  return User;
}; 
import { EggAppConfig, EggAppInfo, PowerPartial } from 'egg';

export default (appInfo: EggAppInfo) => {
  const config = {} as PowerPartial<EggAppConfig>;

  // override config from framework / plugin
  // use for cookie sign key, should change to your own and keep security
  config.keys = appInfo.name + '_1746203174813_1439';

  // add your egg config in here
  config.middleware = [];

  // change multipart mode to file
  // @see https://github.com/eggjs/multipart/blob/master/src/config/config.default.ts#L104
  config.multipart = {
    mode: 'file',
  };

  // add your special config in here
  // Usage: `app.config.bizConfig.sourceUrl`
  const bizConfig = {
    sourceUrl: `https://github.com/eggjs/examples/tree/master/${appInfo.name}`,
  };

  // 数据库配置
  config.sequelize = config.sequelize = {
    dialect: 'sqlite',
    storage: 'path/to/database.sqlite'
  };;

  // 跨域配置
  config.cors = {
    origin: '*',
    allowMethods: 'GET,HEAD,PUT,POST,DELETE,PATCH',
  };

  // 安全配置
  config.security = {
    csrf: {
      enable: false,
    },
  };

  // // AI模型配置
  // config.ai = {
  //   openai: {
  //     apiKey: 'YOUR_OPENAI_API_KEY',
  //     baseURL: 'https://api.openai.com/v1', // 可选，自定义API地址
  //   },
  //   anthropic: {
  //     apiKey: 'YOUR_ANTHROPIC_API_KEY',
  //   },
  //   google: {
  //     apiKey: 'YOUR_GOOGLE_API_KEY',
  //   },
  //   qianfan: {
  //     apiKey: 'YOUR_QIANFAN_API_KEY',
  //     secretKey: 'YOUR_QIANFAN_SECRET_KEY',
  //   },
  //   zhipu: {
  //     apiKey: 'YOUR_ZHIPU_API_KEY',
  //   },
  // };

  // 插件配置
  // config.redis = {
  //   client: {
  //     port: 6379,
  //     host: '127.0.0.1',
  //     password: '',
  //     db: 0,
  //   },
  // };

  // the return config will combines to EggAppConfig
  return {
    ...config,
    ...bizConfig,
  };
};

import { EggPlugin } from 'egg';

const plugin: EggPlugin = {
  tegg: {
    enable: true,
    package: '@eggjs/tegg-plugin',
  },
  teggConfig: {
    enable: true,
    package: '@eggjs/tegg-config',
  },
  teggController: {
    enable: true,
    package: '@eggjs/tegg-controller-plugin',
  },
  teggSchedule: {
    enable: true,
    package: '@eggjs/tegg-schedule-plugin',
  },
  eventbusModule: {
    enable: true,
    package: '@eggjs/tegg-eventbus-plugin',
  },
  aopModule: {
    enable: true,
    package: '@eggjs/tegg-aop-plugin',
  },
  tracer: {
    enable: true,
    package: '@eggjs/tracer',
  },
  // 数据库插件
  sequelize: {
    enable: true,
    package: 'egg-sequelize',
  },
  // 跨域插件
  cors: {
    enable: true,
    package: 'egg-cors',
  },
  // Redis插件
  redis: {
    enable: true,
    package: 'egg-redis',
  },
};

export default plugin;

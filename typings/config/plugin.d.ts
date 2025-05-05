// This file is created by egg-ts-helper@3.1.1
// Do not modify this file!!!!!!!!!
/* eslint-disable */

import 'egg';
import '@eggjs/onerror';
import '@eggjs/session';
import '@eggjs/i18n';
import '@eggjs/watcher';
import '@eggjs/multipart';
import '@eggjs/security';
import '@eggjs/development';
import '@eggjs/logrotator';
import '@eggjs/schedule';
import '@eggjs/static';
import '@eggjs/jsonp';
import '@eggjs/view';
import '@eggjs/tegg-plugin';
import '@eggjs/tegg-config';
import '@eggjs/tegg-controller-plugin';
import '@eggjs/tegg-schedule-plugin';
import '@eggjs/tegg-eventbus-plugin';
import '@eggjs/tegg-aop-plugin';
import '@eggjs/tracer';
import 'egg-sequelize';
import 'egg-cors';
import 'egg-redis';
import { EggPluginItem } from 'egg';
declare module 'egg' {
  interface EggPlugin {
    onerror?: EggPluginItem;
    session?: EggPluginItem;
    i18n?: EggPluginItem;
    watcher?: EggPluginItem;
    multipart?: EggPluginItem;
    security?: EggPluginItem;
    development?: EggPluginItem;
    logrotator?: EggPluginItem;
    schedule?: EggPluginItem;
    static?: EggPluginItem;
    jsonp?: EggPluginItem;
    view?: EggPluginItem;
    tegg?: EggPluginItem;
    teggConfig?: EggPluginItem;
    teggController?: EggPluginItem;
    teggSchedule?: EggPluginItem;
    eventbusModule?: EggPluginItem;
    aopModule?: EggPluginItem;
    tracer?: EggPluginItem;
    sequelize?: EggPluginItem;
    cors?: EggPluginItem;
    redis?: EggPluginItem;
  }
}
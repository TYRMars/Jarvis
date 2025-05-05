import { Application } from 'egg';

export default class AppBootHook {
  private app: Application;

  constructor(app: Application) {
    this.app = app;
  }

  async didLoad() {
    // 在应用启动阶段初始化
    this.app.logger.info('[App] 应用正在加载...');
  }

  async willReady() {
    // 所有的插件都已启动，但是应用整体还未 ready
    // 可以做一些数据初始化等操作
    this.app.logger.info('[App] 应用即将就绪...');
  }

  async didReady() {
    // 应用已经启动完毕
    const ctx = this.app.createAnonymousContext();
    
    // 初始化MCP服务
    try {
      await ctx.service.mcpInit.init();
      this.app.logger.info('[App] MCP服务初始化成功');
    } catch (error) {
      this.app.logger.error('[App] MCP服务初始化失败', error);
    }
    
    this.app.logger.info('[App] 应用已就绪');
  }

  async serverDidReady() {
    // http / https server 已启动，开始接受外部请求
    // 此时可以从 app.server 拿到 server 的实例
    this.app.logger.info('[App] 服务器已就绪，开始接受请求');
  }
} 
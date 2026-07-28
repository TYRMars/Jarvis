# 移动端连接 + 本机对外 DDNS(Remote Access)

**Status:** Implemented (P1 — 服务端基座 + iOS 客户端补齐 + Web 配对页 + 桌面壳「暴露到局域网」开关)。

> 分支:`feat/mobile-ios-ddns`。本提案落地了「移动端连接电脑上的 service」+「本机对外
> DDNS 配置能力」两件事。

## 背景 / 目标

此前 Jarvis 只有一个客户端(Web SPA),且服务端**无任何鉴权**——只在 loopback/可信
局域网下安全。`apps/jarvis-ios` 已有一个较完整的 SwiftUI 聊天客户端(会话列表、流式
`AgentEvent`、工具卡片、审批、计划、子代理),但缺两块:

1. **连接电脑上的 service**:只有手填地址 + `/health`,没有发现 / 扫码 / **令牌鉴权**。
2. **对外 DDNS 配置**:完全没有。

目标:让原生 iOS App 在局域网内零配置连上家里的 Jarvis,并能直接在手机上配置本机的
动态 DNS(+ 尽力 UPnP 端口映射),从而在外网也能连回——这一切以一道鉴权门为前提。

## 已落地

### 服务端基座(Node `packages/*`)

- **Bearer 鉴权**(`packages/server/src/auth.ts`):`JARVIS_ACCESS_TOKEN` 配置后,
  注册 `onRequest` 钩子——**loopback 直接放行**(本地 Web / 桌面窗口照旧免令牌),
  非 loopback 的 `/v1`/WS 请求必须带 `Authorization: Bearer <token>`(WS 也接受
  `?token=`),否则 401。`/health` + SPA 静态资源始终开放。**未配置令牌 = 维持现状**(无鉴权)。
- **`@jarvis/ddns` 包**:可插拔 `DdnsProvider`(Cloudflare / DuckDNS / 通用 dyndns2 /
  阿里云 DNS / DNSPod)、公网+局域网 IP 探测、**零依赖 UPnP IGD**(dgram SSDP + SOAP)
  端口映射、`DdnsRuntime`(周期更新 + 0600 落盘的配置,密钥永不回显)。
- **工具 + 路由**:`ddns.{status,update,configure}`(后两者审批门控);
  `GET/PUT /v1/ddns/config`(GET 脱敏)、`POST /v1/ddns/update`、`POST /v1/ddns/upnp/test`、
  `GET /v1/ddns/status`、`GET /v1/remote/info`、**loopback-only** `GET /v1/remote/pairing`
  (返回令牌 + `jarvis://pair` 链接,远端 403)。
- **mDNS**:`JARVIS_MDNS=1` 时经可选依赖 `bonjour-service` 广播 `_jarvis._tcp`(缺依赖则
  优雅降级 no-op,扫码/手填仍可用)。

### iOS 客户端补齐(`apps/jarvis-ios`,集成进既有 App)

- `ServerConfig` 增加令牌解析(`serverToken` / `JARVIS_ACCESS_TOKEN` / plist);
  `JarvisAPI` + `ChatSocket` 自动带 `Authorization: Bearer`(loopback 服务器留空即免鉴权)。
- **发现/配对**:`DiscoveryService`(NWBrowser 浏览 `_jarvis._tcp`)、`QRScannerView`
  (VisionKit 扫 `jarvis://pair`)、`onOpenURL` 深链、设置页令牌字段。
- **DDNS 配置页**(`DDNSView`):服务商选择 + 凭据表单(按服务商动态)+ 域名/端口/UPnP
  开关 → `PUT /v1/ddns/config`;状态展示(公网 IP、上次更新、UPnP、可达性);立即更新 / 测试 UPnP。
- `JarvisAPI` 新增 `remoteInfo / ddnsStatus / ddnsConfig / putDdnsConfig / ddnsUpdate / upnpTest`。

### Web 家端配对页

Settings → **远程访问**:读 `/v1/remote/info` + `/v1/remote/pairing`,展示局域网/外网
origin、是否需令牌,并为每个 origin 渲染 `jarvis://pair` 二维码(`qrcode.react`)+ 复制链接/令牌。
DDNS 的*编辑*放在手机端(按需求)。

## 连接流程

1. 电脑跑 `jarvis serve`(默认 `0.0.0.0:7001`),设 `JARVIS_ACCESS_TOKEN`(+ 可选 `JARVIS_MDNS=1`)。
2. 手机与电脑同 Wi-Fi → App 发现服务器,或在电脑 Settings·远程访问扫码 → 自动填入 origin+令牌。
3. (可选)手机 App 内配置 DDNS(域名 + 凭据 + UPnP)→ 服务端更新记录、尽力开端口。
4. 之后在外网用 DDNS 域名 + 令牌即可连回。

## 安全模型(务必满足)

- **对外暴露(DDNS / UPnP / 非 loopback 绑定)必须配令牌**;否则启动时打印醒目 WARNING。
- DDNS 凭据落盘 `0600`,任何 GET 都不回显(只回 `credential_keys`)。
- 令牌只在配对时下发(loopback-only `/v1/remote/pairing`),可换发(改 env 重启)。
- 常量时间比较令牌;`/v1/remote/pairing` 即使带正确 bearer 的远端也拒绝(避免泄露密钥)。

## 验证

- Node:`pnpm -r typecheck && pnpm lint && pnpm -r test`(新增 `@jarvis/ddns` 9 例、
  `auth` 7 例、`ddns-routes` 6 例)。
- 实跑:`0.0.0.0` 绑定 + 令牌,经局域网 IP 验证 401(无/错令牌)/ 200(bearer / `?token=`),
  `/health` 常开,`/v1/remote/info` 列出局域网地址。
- iOS:`apps/jarvis-ios` 经 `swift build` 编译 `JarvisKit`(此环境无完整 Xcode);
  Foundation-only 层经 `Tests/run-contract-smoke.sh` 跑 35 例金样断言(含 DDNS/RemoteInfo/
  Pairing/令牌);整工程 App 由 `xcodegen generate` + 完整 Xcode 构建运行(真机/模拟器)。

## 待办

- ~~**桌面壳「暴露到局域网」开关**~~:已实现——`packages/desktop` 设置页(远程访问)
  的开关经 `setLanExposure` IPC 重启内嵌 server:绑 `0.0.0.0`、优先稳定端口
  (`prefs.lanPort`,默认 7001,被占则退化临时端口)、自动生成并以 0600 持久化
  访问令牌注入 `JARVIS_ACCESS_TOKEN`,同时启动 Bonjour 广播(serve 子命令在
  main.ts 里做的事,内嵌路径在 server-manager 里补上);窗口始终走 loopback,
  配对二维码页因此可解锁。
- iOS 自动重连时在 WS `resume` 上补带令牌(已带 header,逻辑上已覆盖,待真机回归)。
- DDNS provider 的更细错误分类 / 多记录(AAAA)同步。

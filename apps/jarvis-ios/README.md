# jarvis-ios

Jarvis 的 iPhone 客户端(SwiftUI,iOS 17+)。连接一台运行 `jarvis serve` 的服务器,
提供:会话列表(`/v1/conversations`)、流式聊天(`/v1/chat/ws` WebSocket,渲染
`AgentEvent`)、工具调用卡片、敏感工具审批(approve / deny)、计划清单
(`plan_update`)、子代理时间线(`sub_agent_event`)、token 用量(`usage`)、
断线自动重连(指数退避 + `resume { after_seq }` 事件补放)。

## 生成 Xcode 工程

工程由 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 描述(`project.yml`),
`.xcodeproj` 不入库:

```bash
brew install xcodegen
cd apps/jarvis-ios
xcodegen generate
open JarvisiOS.xcodeproj
```

真机调试需在 Xcode 的 Signing & Capabilities 里选择你的 Team(或在
`project.yml` 的 `settings.base` 中加 `DEVELOPMENT_TEAM`)。

## 连接服务器

1. 在 Mac 上启动服务器(需要先开启写/执行工具才能看到审批流程):

   ```bash
   JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_SHELL_EXEC=1 \
     node --experimental-strip-types packages/jarvis-app/src/main.ts serve
   ```

2. App 内左上角 ⚙ 打开设置,填服务器地址:
   - 模拟器:`http://localhost:7001`
   - 真机:`http://<Mac 局域网 IP>:7001`(`JARVIS_ADDR` 默认监听 `0.0.0.0:7001`)
3. 「测试连接」走 `GET /health` 验证连通性。

Rust `harness-server` 与 Node `@jarvis/jarvis-app serve` 说同一套 `/v1`、同在 7001,
所以默认地址两者通用。

### base URL 切换(P7.10)

`ServerConfig.resolve` 的优先级(高→低,iOS 版的 `VITE_BACKEND_URL` + 运行时覆盖):

1. UserDefaults `serverURL` —— 设置页编辑的运行时覆盖,最高优先级;
2. `JARVIS_SERVER_URL` 环境变量 —— 启动/CI/开发期默认(Xcode scheme 的 Run
   environment 或无头驱动模拟器时设),不入构建;
3. Info.plist `JarvisServerURL` —— 构建期默认,可让某个构建出厂即指向特定后端;
4. `http://localhost:7001` —— 兜底。

## /v1 契约冒烟测试(P7.10)

客户端模型(`Sources/Models/*` + `Networking/{ServerConfig,JarvisAPI}`)是纯
Foundation,所以契约冒烟测试用宿主 `swiftc` 直接编译运行——**无需 Xcode 工程或
模拟器**:

```bash
cd apps/jarvis-ios
./Tests/run-contract-smoke.sh                                   # 离线黄金样本(门禁)
JARVIS_SMOKE_BASE_URL=http://localhost:7001 ./Tests/run-contract-smoke.sh   # + 实测诊断
```

离线模式用「黄金样本」校验 iOS Codable 模型能否解出服务端 `/v1` 线格式(会话列表/
详情/providers/WS `AgentEvent` 帧/HITL/DDNS),黄金样本对齐 **Node `@jarvis/server`
的契约**(Rust 退役后的权威基线;`packages/server/src/server.test.ts` 的 WS 协议
测试与这些金样互为镜像)。CI 见 `.github/workflows/ios-contract.yml`。

> 迁移期发现:Node 服务端 `GET /v1/conversations` 曾把数组包进 `{conversations:[…]}`
> (已在本次随 P7.10 修回裸数组,补 `conversations-routes.test.ts` 锁定);另
> `GET /v1/providers`(只读目录)Node 端尚未实现(仅 `POST` + `GET /:name`),
> 会话列表也缺 `title`/`source` 富化——留待 P8.1「Node 独立成服务」补齐。

ATS 已按商店口径收紧:仅 `NSAllowsLocalNetworking`(局域网明文 http/ws 可用),
**外网(DDNS)访问必须 https**——给服务器加一层 TLS 反代(如 Caddy/nginx),或开发期
临时在 `project.yml` 加回 `NSAllowsArbitraryLoads: true`(提审前务必移除)。

## 与服务端协议的对应关系

| 客户端 | 服务端 |
|---|---|
| `Sources/Models/ChatMessage.swift` | `harness-core::Message`(`role` 外部标签) |
| `Sources/Models/ServerEvent.swift` | `harness-core::AgentEvent`(`type` 标签,snake_case)+ WS 簿记帧(`started`/`resumed`/`tail_replay_*`/`resume_error`/`approval_pending`/`permission_mode`/`configured`/`plan_proposed`/`interrupted`/`error`…) |
| `Sources/Models/PlanItem.swift` | `harness-core::plan::PlanItem`(`plan_update` 全量快照) |
| `Sources/Models/SubagentFrame.swift` | `harness-core::subagent::SubAgentFrame`(`sub_agent_event`,`kind` 标签) |
| `Sources/Models/ProviderInfo.swift` | `harness-server::ProviderInfo`(`GET /v1/providers`) |
| `Sources/Networking/ChatSocket.swift` | Node `packages/server/src/chat-routes.ts` 的 WS 帧:`start_turn` / `user` / `resume {after_seq}` / `approve` / `deny` / `interrupt` / `configure` / `hitl_response`(`set_mode` / `accept_plan` / `refine_plan` 已在客户端实现,待服务端 Plan Mode 落地) |
| `Sources/Models/Hitl.swift` + `Views/HitlCardView.swift` | `@jarvis/core` `HitlRequest`(`hitl_request` 事件 → 问答卡,回 `hitl_response`) |
| `Sources/Networking/JarvisAPI.swift` | `/v1/conversations` CRUD + `/v1/providers` + `/health` |

会话流程:新会话首条消息发 `start_turn {mode:"new", id:<uuid>, content}`(服务端
据此建持久化会话);打开旧会话先用 REST 拉历史,socket 一连上即发
`resume {id, after_seq}` 进入持久化模式(若该会话有进行中的 run,服务端回
`resumed {live:true}` 并补放漏掉的事件),此后统一用 `user` 帧。
未识别的服务端帧一律降级为 `ignored`,服务端加新事件不会导致客户端崩溃。

断线重连:socket 掉线后指数退避(0.5s 起、上限 10s)自动重连,App 回前台立即
重连;重连后凭客户端维护的 `seq` 高水位发 `resume { after_seq }` 只补放漏掉的
事件。`tail_replay_start.first_seq` 出现缺口或收到 `resume_error {evicted}` 时
退化为 REST 全量重载;`resumed {live:false}` 且本地仍在 streaming,说明 run 在
掉线期间已结束,同样走全量重载。重连后服务端会用 `approval_pending` 重发仍在
阻塞的审批,客户端再次弹出审批页。

审批:收到 `approval_request` / `approval_pending` 弹出审批页(工具名 + 参数
JSON),用户选择后回 `approve {tool_call_id}` 或 `deny {tool_call_id, reason?}`;
deny 的原因会作为 `tool denied: <reason>` 回馈给模型。

事件渲染:`plan_update` 在输入栏上方渲染为可折叠计划清单(完成数/总数 + 当前
进行项);`usage` 在输入栏上方显示「模型 · ↑prompt ↓completion · 缓存」;
`sub_agent_event` 渲染为原地更新的子代理卡片(状态/任务/输出尾部/工具计数);
`memory_compacted`(非 no_op)与 `provider_fallback` 渲染为居中提示行。

## 远程访问:鉴权 / 配对 / DDNS

详见 `docs/proposals/mobile-ddns.zh-CN.md`。

- **访问令牌**:服务器设了 `JARVIS_ACCESS_TOKEN` 后,非 loopback 请求必须带
  `Authorization: Bearer`。设置页填「访问令牌」(或扫码自动带入),`JarvisAPI` /
  `ChatSocket` 会自动附加;loopback 服务器留空即免鉴权。
- **扫码配对**:设置页「扫码配对」用相机扫电脑「远程访问」页生成的二维码
  (`jarvis://pair?origin=…&token=…&name=…`),自动填入地址+令牌;同样的链接被点击/
  AirDrop 时经 `onOpenURL` 深链处理。
- **局域网发现**:设置页经 Bonjour 浏览 `_jarvis._tcp`(电脑端设 `JARVIS_MDNS=1` 广播),
  列出同网服务器作为提示。
- **远程访问 / DDNS**:设置 → 「远程访问 / DDNS」配置本机的动态 DNS——选服务商
  (Cloudflare / DuckDNS / 通用 dyndns2 / 阿里云 / DNSPod)、填域名 + 凭据 + UPnP 开关,
  写入 `/v1/ddns/config` 并立即更新;状态区显示公网 IP、上次结果、UPnP 映射、可达性。
  之后用 DDNS 域名 + 令牌即可在外网连回。

## 发布到 App Store

工程侧已备齐:App 图标(`Assets.xcassets/AppIcon`,1024 无透明通道)、隐私清单
(`PrivacyInfo.xcprivacy`:无追踪、无数据收集、UserDefaults 声明 CA92.1)、出口合规
(`ITSAppUsesNonExemptEncryption: false`,标准 TLS 豁免)、收紧的 ATS(见上)、
版本号(`MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`,在 `project.yml`)。

在装有完整 Xcode 的机器上:

1. **前置**:加入 Apple Developer Program;在 App Store Connect → Identifiers 注册
   你自己的 bundle id,并把 `project.yml` 的 `PRODUCT_BUNDLE_IDENTIFIER` 改成它,
   `settings.base` 加 `DEVELOPMENT_TEAM: <你的TeamID>`。
2. `xcodegen generate && open JarvisiOS.xcodeproj`。
3. 版本:每次提审前在 `project.yml` 递增 `MARKETING_VERSION`(用户可见)与
   `CURRENT_PROJECT_VERSION`(构建号,同版本内每次上传都要 +1),重新 generate。
4. **Archive**:目标选 `Any iOS Device (arm64)` → Product → Archive → Organizer →
   Distribute App → App Store Connect。出口合规问题已由 plist 键回答,不会再弹。
5. **App Store Connect**:新建 App(绑定 bundle id)→ 填元数据/截图(6.7" 与 6.5"
   两组必需)→ 隐私问卷选「不收集数据」(与 PrivacyInfo 一致)→ 先发 TestFlight
   内测,再提交审核。
6. **审核注意**:这是一个连接**用户自有服务器**的客户端,审核可能要求可用的演示
   环境——在 App Review 备注里提供一个公网 https 测试服务器地址 + 访问令牌
   (扫码配对链接同样可填),说明 App 本身不含服务端、无账号体系。

## 目录结构

```
project.yml              # XcodeGen 工程描述(含相机/Bonjour 用途串 + jarvis:// scheme)
Sources/
  JarvisApp.swift        # @main 入口(+ jarvis:// 深链)
  Models/                # JSONValue / ChatMessage / Conversation / ServerEvent
                         #   / PlanItem / SubagentFrame / Ddns / Pairing
  Networking/            # ServerConfig(URL+令牌)/ JarvisAPI(REST,含 /v1/ddns/*)
                         #   / ChatSocket(WS,带令牌)/ Discovery(Bonjour)
  ViewModels/            # ChatViewModel / ConversationListViewModel(@Observable)
  Views/                 # 会话列表 / 聊天 / 审批弹窗 / 设置 / 计划卡片 / 子代理卡片
                         #   / QRScannerView(扫码)/ DDNSView(远程访问配置)
Tests/                   # run-contract-smoke.sh + ContractSmoke(swiftc,无需 Xcode)
```

> `Sources/Models/*` + `Networking/{ServerConfig,JarvisAPI}` 是 Foundation-only,由
> `Tests/run-contract-smoke.sh` 用 `swiftc` 直接编译并跑金样断言(含 DDNS / RemoteInfo /
> Pairing / 令牌解析),无需完整 Xcode。

## 已知边界

- ~~Plan Mode 等待服务端~~:**已打通**。Node 服务端实现了每 socket 的权限模式
  (连接即发 `permission_mode`)、Plan Mode 的结构性工具过滤(只暴露 read 类工具 +
  `exit_plan`)、`exit_plan` 终止本轮并发 `plan_proposed`,以及
  `accept_plan {post_mode}`(切模式 + 把计划作为执行简报回灌)/`refine_plan {feedback}`
  (留在 Plan Mode 重规划)。iOS 的模式菜单与计划卡片现在是实际可用功能。
- `configure` 仅支持**同 provider 切模型**;切 provider 需要服务端第二 provider
  运行时(暂拒绝)。`fork`(编辑重跑)、`set_workspace` 未实现。
- `workspace_changed`、`skill_activated` 等事件暂被忽略(降级为 `ignored`)。
- 工程文件:`JarvisiOS.xcodeproj` 与 `Generated/` 为生成产物,建议加入 `.gitignore`。

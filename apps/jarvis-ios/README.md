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
   JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_SHELL_EXEC=1 cargo run -p jarvis
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
详情/providers/WS `AgentEvent` 帧),黄金样本对齐 **Rust `harness-server` 的契约**
(权威基线)。CI 见 `.github/workflows/ios-contract.yml`。

> 迁移期发现:Node 服务端 `GET /v1/conversations` 曾把数组包进 `{conversations:[…]}`
> (已在本次随 P7.10 修回裸数组,补 `conversations-routes.test.ts` 锁定);另
> `GET /v1/providers`(只读目录)Node 端尚未实现(仅 `POST` + `GET /:name`),
> 会话列表也缺 `title`/`source` 富化——留待 P8.1「Node 独立成服务」补齐。

开发期 Info.plist 设置了 `NSAllowsArbitraryLoads` 以允许局域网明文
http/ws;正式分发前应收紧 ATS 并改用 TLS。

## 与服务端协议的对应关系

| 客户端 | 服务端 |
|---|---|
| `Sources/Models/ChatMessage.swift` | `harness-core::Message`(`role` 外部标签) |
| `Sources/Models/ServerEvent.swift` | `harness-core::AgentEvent`(`type` 标签,snake_case)+ WS 簿记帧(`started`/`resumed`/`tail_replay_*`/`resume_error`/`approval_pending`/`permission_mode`/`configured`/`plan_proposed`/`interrupted`/`error`…) |
| `Sources/Models/PlanItem.swift` | `harness-core::plan::PlanItem`(`plan_update` 全量快照) |
| `Sources/Models/SubagentFrame.swift` | `harness-core::subagent::SubAgentFrame`(`sub_agent_event`,`kind` 标签) |
| `Sources/Models/ProviderInfo.swift` | `harness-server::ProviderInfo`(`GET /v1/providers`) |
| `Sources/Networking/ChatSocket.swift` | `harness-server` 的 `WsClientMessage`:`start_turn` / `user` / `resume` / `approve` / `deny` / `interrupt` / `configure` / `set_mode` / `accept_plan` / `refine_plan` |
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

## 目录结构

```
project.yml              # XcodeGen 工程描述
Sources/
  JarvisApp.swift        # @main 入口
  Models/                # JSONValue / ChatMessage / Conversation / ServerEvent
                         #   / PlanItem / SubagentFrame
  Networking/            # ServerConfig / JarvisAPI(REST) / ChatSocket(WS)
  ViewModels/            # ChatViewModel / ConversationListViewModel(@Observable)
  Views/                 # 会话列表 / 聊天 / 审批弹窗 / 设置 / 计划卡片 / 子代理卡片
```

## 已知边界

- 未渲染的事件:`plan_proposed` / `mode_changed`(Plan Mode 的 accept/refine 流程)、
  `hitl_request`(`ask.*` 工具)、`workspace_changed`、`skill_activated` 等暂被
  忽略;Plan Mode 下的会话在 iOS 端无法接受计划。
- 单 socket 单会话:未实现 `configure`(切模型/provider)、`fork`(编辑重跑)、
  `set_workspace`。
- 工程文件:`JarvisiOS.xcodeproj` 与 `Generated/` 为生成产物,建议加入 `.gitignore`。

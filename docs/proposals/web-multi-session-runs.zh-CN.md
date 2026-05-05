# Web 多会话并行与异步运行

Status: **Proposed**

Owner: Jarvis

Related: [tauri-desktop-client.zh-CN.md](tauri-desktop-client.zh-CN.md), [session-execution-context.zh-CN.md](session-execution-context.zh-CN.md), [new-session-resource-manager.zh-CN.md](new-session-resource-manager.zh-CN.md)

## 背景

Jarvis Web 目前是单会话运行模型：

- `apps/jarvis-web/src/services/socket.ts` 是 singleton WebSocket。
- `appStore.inFlight` 是全局布尔。
- `resumeConversation` / `newConversation` 会拒绝在 in-flight 时切换或新建。
- `messages`、`toolBlocks`、`approvals`、`hitls`、`proposedPlan`、`subAgentRuns` 都是当前可见会话的单份状态。

这让单会话体验简单，但阻止了用户在 Web 页面中同时运行多个会话。用户想要的是：

- A 会话运行中，可以切到 B 会话继续提问。
- A / B / C 可以同时跑。
- 切回 A 时能看到 A 的实时进展。
- A 等待审批时，不阻塞 B。
- 刷新页面或断线后，可以重新接上仍在运行的会话。

因此多会话并行不是桌面端专属能力，Web 页面本身也必须支持。

## 目标

1. Web 页面支持多个 conversation 同时 active run。
2. 同一个 conversation 默认只允许一个 active run，避免 history 竞争写。
3. 不同 conversation 可以并行 run。
4. 用户切换会话、打开项目页、打开设置页，不中断后台会话。
5. Sidebar 展示每个会话的运行状态。
6. 当前会话输入区只受当前会话 run 状态影响，不受其他会话影响。
7. Web 与桌面端共用同一套 async run API；桌面不是特殊实现。

## 非目标

- 第一版不支持同一个 conversation 中排队多个用户 turn。
- 第一版不做跨浏览器 tab 的协同锁；多个 tab 可同时订阅，但冲突启动由 server 409 防住。
- 第一版不要求 server 重启后恢复 running run。
- 不把 agent loop 搬到前端。

## 总体方案

分两步落地：

1. **Web 前端先拆 singleton 状态。**
   - 把 `inFlight` 从全局改为 per-conversation / per-run。
   - 把 socket 管理从 singleton 改为可多路。
   - Sidebar 和 composer 开始按会话状态渲染。
2. **Server 引入 async run registry 后，Web 切换为后台 run API。**
   - 启动 run：`POST /v1/conversations/:id/runs`
   - 订阅 run：`GET /v1/runs/:run_id/events?after=<seq>`
   - 审批/中断：按 `run_id` 调 REST

短期可以用“每个运行会话一个 foreground WS”实现多会话并行；长期统一到 server-side run registry。

## 当前约束

### Singleton Socket

`services/socket.ts` 当前只有一个模块级 `socket`：

```ts
let socket: WebSocket | null = null;
```

因此所有 frame 都进入同一个 `handleFrame`，没有 conversation/run 路由上下文。

### Global In-Flight

很多入口读 `store.inFlight`：

- 新建会话时阻止
- 恢复会话时阻止
- 删除会话时阻止
- 配置模型时阻止
- Esc interrupt 只中断全局当前 turn

多会话并行后必须替换为：

```ts
runStateByConversation[conversationId]
```

### Visible-Only Chat State

当前 chat slice 只保存一份可见消息列表。多会话运行时，非当前会话也会收到 delta/tool/approval frame。它们不能丢，也不能错误写进当前会话。

## Web State 设计

新增 normalized runtime state：

```ts
type ConversationRunStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_hitl"
  | "completed"
  | "failed"
  | "cancelled";

interface ConversationRuntime {
  conversationId: string;
  activeRunId: string | null;
  status: ConversationRunStatus;
  provider: string | null;
  model: string | null;
  workspacePath: string | null;
  projectId: string | null;
  lastSeq: number;
  unreadEvents: number;
  pendingApprovals: string[];
  pendingHitls: string[];
  lastError: string | null;
  updatedAt: string;
}

interface RunRuntime {
  runId: string;
  conversationId: string;
  status: ConversationRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  lastSeq: number;
  eventConnection: "connecting" | "connected" | "reconnecting" | "disconnected";
}
```

保留当前可见会话的 `messages/toolBlocks/hitls/approvals/...`，但新增一个 per-conversation cache：

```ts
interface ConversationSurfaceSnapshot {
  messages: UiMessage[];
  toolBlocks: Record<string, ToolBlockEntry>;
  approvals: ApprovalEntry[];
  hitls: HitlEntry[];
  tasks: TaskRailEntry[];
  proposedPlan: Plan | null;
  subAgentRuns: Record<string, SubAgentRun>;
}

surfaceByConversation: Record<string, ConversationSurfaceSnapshot>;
```

切换会话时：

1. 保存当前 visible surface 到 `surfaceByConversation[activeId]`。
2. 如果目标会话有 snapshot，直接恢复。
3. 如果没有 snapshot，从 `GET /v1/conversations/:id` 加载 persisted history。
4. 如果目标会话有 active run，attach event stream 并从 `lastSeq` 补帧。

## 短期实现：多 WebSocket 会话

在 async run registry 未落地前，可先实现 `ConversationSocketManager`：

```ts
class ConversationSocketManager {
  sockets: Map<string, ConversationSocket>;

  startRun(conversationId, content, opts): void;
  resume(conversationId): void;
  send(conversationId, frame): boolean;
  interrupt(conversationId): void;
  close(conversationId): void;
}
```

每个 active conversation socket：

1. 打开 `/v1/chat/ws`
2. 发送 `resume { id }`
3. 发送 `user { content, provider, model, workspace_path? }`
4. frame handler 带上 `conversationId` 路由进对应 surface snapshot

限制：

- 浏览器同时开很多 WS 会有资源成本；第一版可限制 active foreground sockets 数量，例如 6。
- 页面刷新后 foreground WS run 仍可能丢事件；这只是过渡方案。
- Approval 只能发回对应 conversation socket。

这个阶段能快速解锁“Web 同时跑多个会话”，但不是最终异步模型。

## 长期实现：后台 Run API

与桌面端共用 server-side run registry：

| Endpoint | Web 用途 |
|---|---|
| `POST /v1/conversations/:id/runs` | 当前会话提交新 run |
| `GET /v1/runs?status=active` | 页面启动时恢复所有 active runs |
| `GET /v1/runs/:run_id` | 获取 run 快照 |
| `GET /v1/runs/:run_id/events?after=<seq>` | SSE 订阅并补帧 |
| `POST /v1/runs/:run_id/interrupt` | 中断指定 run |
| `POST /v1/runs/:run_id/approve` | 审批指定 run 的工具调用 |
| `POST /v1/runs/:run_id/deny` | 拒绝指定 run 的工具调用 |
| `POST /v1/runs/:run_id/hitl` | 响应指定 run 的 HITL |

Web 页面启动时：

1. 拉取 conversation list。
2. 拉取 active runs。
3. 为每个 active run 建立 SSE subscription。
4. 将 run 状态合并到 sidebar。
5. 当前可见会话如果有 active run，恢复输入区上方执行上下文条。

## Frame 路由

当前 `handleFrame(frame)` 缺少上下文。多会话后改为：

```ts
handleFrame({
  conversationId,
  runId,
  frame,
});
```

或者对于后台 run event：

```ts
handleRunEvent({
  seq,
  run_id,
  conversation_id,
  event,
});
```

处理规则：

- 如果 `conversation_id === activeId`，更新 visible surface。
- 否则更新 `surfaceByConversation[conversation_id]`，并增加 unread/status badge。
- terminal event 后刷新 conversation list，并按需刷新 persisted history。

## UI 设计

### Sidebar

每个会话 row 增加运行态：

- running：小转动/脉冲点
- waiting approval：强调色点 + `需要审批`
- waiting HITL：`等待输入`
- failed：错误点
- completed：短暂显示完成后淡出

Row 右侧可显示当前 tool 摘要：

```text
Jarvis Desktop Spec        running · shell.exec
优化输入框                 waiting approval
```

### 当前会话输入区

输入区上方 `ComposerShoulder` / `SessionExecutionShoulder` 显示当前会话 run：

- run status
- current tool
- pending approval count
- elapsed time
- provider/model
- interrupt button

如果当前会话正在 run：

- 第一版禁用发送新消息，提示“当前会话正在运行”。
- 其他会话不受影响。

### 全局 Running 面板

新增一个全局面板，列出所有 active runs：

```text
Running
  Jarvis Desktop Spec      01:32   shell.exec
  Memory Rules             00:48   waiting approval
  Web UI Polish            03:10   reading files
```

点击 row 跳转到对应会话并 attach。

## Store 改造清单

### `coreSlice`

- `inFlight: boolean` 迁移为 `runStateByConversation`。
- `connection` 保留 server-level 连接状态，但 active run 连接状态放入 `RunRuntime`。
- `socketWorkspace` 从 per-socket 改为 per-conversation runtime / draft context。

### `chatSlice`

- 增加 surface snapshot 保存/恢复。
- `clearMessages` 只清当前 active conversation surface。
- `appendDelta` / `finalizeAssistant` 接受可选 `conversationId`，默认 active。

### `approvalSlice` / `hitlSlice`

- approval / hitl entry 增加 `conversationId` 和 `runId`。
- approve / deny 调用按 `runId` 或 conversation socket 路由。

### `services/socket.ts`

短期拆成：

```text
services/
  socket/
    serverSocket.ts          # 当前全局 fanout/requirements/todos 可保留
    conversationSocket.ts    # per conversation foreground run
    conversationSocketManager.ts
```

长期新增：

```text
services/
  runs.ts                    # REST run API
  runEvents.ts               # SSE subscription + reconnect
```

## Server 改造清单

为了让 Web 真正异步，`harness-server` 需要提供后台 run registry。详见 [tauri-desktop-client.zh-CN.md](tauri-desktop-client.zh-CN.md) 的“多会话与异步运行”章节。

Web 相关额外要求：

- `GET /v1/runs?status=active` 要足够轻，页面启动会调用。
- run event 必须带 `conversation_id`，不能只带 `run_id`。
- terminal event 后 conversation store 已保存，Web 可以立即 refetch history。
- 同 conversation active run 冲突返回 `409 Conflict`，body 包含现有 `run_id`。

## 分阶段

### Phase 0：状态解耦

- 引入 `ConversationRuntime` / `RunRuntime` 类型。
- Sidebar 可展示每个会话的 runtime 状态。
- `inFlight` 逻辑替换为 `isConversationRunning(activeId)`。
- 当前会话运行时禁用当前 composer；其他会话可切换。

验收：

- A 会话 running 时，用户能切到 B。
- B 的 composer 不因为 A running 被禁用。

### Phase 1：多 foreground socket

- 新增 `ConversationSocketManager`。
- 每个运行会话一条 WS。
- frame 带 conversation context 路由。
- Approval / HITL / interrupt 路由到对应 socket。

验收：

- A/B 两个会话可同时运行。
- A 等待审批时，B 可以继续流式输出。
- 切回 A 能看到 A 的实时消息。

### Phase 2：后台 run API

- Server 落地 `SessionRunRegistry`。
- Web 新增 `services/runs.ts` / `services/runEvents.ts`。
- 默认提交走 `POST /v1/conversations/:id/runs`。
- 页面启动恢复 active runs。

验收：

- 刷新页面后仍能 attach active run。
- 断线重连能按 seq 补帧。
- 关闭浏览器 tab 后，server run 继续到 terminal。

### Phase 3：体验完善

- Running 面板。
- Sidebar tool/status 摘要。
- 会话完成/等待审批系统通知。
- 多 tab BroadcastChannel：广播 run 状态，减少重复订阅。

验收：

- 用户能清楚知道哪些会话在跑、哪些等待自己处理。
- 多 tab 不会造成重复启动 run；冲突提示可理解。

## 风险

| 风险 | 应对 |
|---|---|
| 前端 store 改造大 | 先只 snapshot active/in-flight conversations，不一次性 normalized 全 history |
| 多 WS 资源占用 | Phase 1 限制 foreground active sockets；Phase 2 改 SSE run subscription |
| 离屏会话 delta 丢失 | 每个 frame 路由到 surface snapshot；terminal 后 refetch persisted history |
| 同会话并发写 history | server 409；前端同会话禁用第二次发送 |
| 审批发错 run | approval entry 必带 `runId` / `conversationId` |
| 刷新后状态恢复复杂 | 依赖 `/v1/runs?status=active` + `events?after=seq` |

## 最小验收清单

- Web 页面内 A/B 两个会话可同时运行。
- A running 时，用户能切到 B 并发送消息。
- A 等待审批时，B 不受阻塞。
- Sidebar 能显示每个会话运行态。
- 当前会话的 interrupt 只中断当前会话 run。
- Approval / HITL 只响应对应 run。
- 刷新页面后能恢复 active run 状态。

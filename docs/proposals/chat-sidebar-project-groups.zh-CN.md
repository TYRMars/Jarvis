# Chat 左侧会话列表项目分组 Spec

## 背景

当前 Chat 左侧边栏已经支持按项目维度展示会话，但与 Codex 风格交互仍有差异。目标是还原参考截图中的信息层级、默认折叠策略、运行态展示、未读提示，以及“会话”与项目组的平级关系。

## 设计目标

1. 左侧会话列表优先服务“快速回到上下文”。
2. 用户能按项目扫描最近工作，而不是被大量历史会话淹没。
3. 运行中的会话保留在原本所属位置，不额外制造“运行中”分组。
4. 未读、运行中、自动化执行等状态要清晰但克制。
5. 列表密度接近 Codex：项目标题清晰，会话行紧凑，默认只露出最有用的部分。

## 整体结构

Chat 模式下左侧边栏包含：

```text
顶部导航/模式区

项目
  会话
    会话 1
    会话 2
    ...
  项目 A
    会话 1
    会话 2
    展开显示
  项目 B
    暂无对话
  项目 C
    会话 1
    ...
```

关键规则：

1. `项目` 是整个项目维度列表的 section title。
2. `会话` 是一个 group，不是底部独立分区。
3. `会话` group 固定展示在所有项目 group 之前。
4. `会话` group 内放置未绑定项目的普通 chat。
5. 项目 group 展示绑定到该项目的会话。
6. 所有 group 使用统一布局，仅 icon 和名称不同。

## 分组定义

### 会话组

- 名称：`会话`
- 内容：`project_id == null` 的会话。
- 位置：固定在所有项目组之前。
- 空态：如果没有普通会话，显示 `暂无对话`。
- 图标：建议使用 chat/list icon，或与项目组保持同样缩进但不使用 folder icon。

### 项目组

- 名称：项目名称。
- 内容：`project_id == project.id` 的会话。
- 图标：folder icon。
- 空态：项目没有会话时显示 `暂无对话`。
- 是否展示空项目：展示。这样用户能确认项目存在，只是没有对话。

## 分组排序

```text
1. 会话组固定第一
2. 有会话的项目组
3. 无会话的项目组
```

项目组排序规则：

1. 有会话项目：按该项目内最近会话更新时间倒序。
2. 无会话项目：按项目更新时间倒序，或保留当前项目列表排序。
3. 如果项目名称相同，不特殊处理，仍按 id 稳定排序兜底。

组内会话排序：

1. 按 `updated_at` 倒序。
2. 正在运行的会话不强制置顶。
3. 未读会话不强制置顶。
4. pinned 会话如果现有产品语义仍保留，则 pinned 在本组内优先于普通会话，但不跨组移动。

## 默认展示数量

每个 group 默认最多展示 5 条会话。

规则：

1. `visibleRows = expanded ? allRows : allRows.slice(0, 5)`
2. 当 `allRows.length > 5` 且未展开时，显示 `展开显示`。
3. 点击 `展开显示` 后展示该组全部会话。
4. 展开后显示 `收起显示`。
5. 点击 `收起显示` 后恢复只展示 5 条。
6. 展开状态按 group 独立维护。
7. 切换筛选、排序、刷新列表时，尽量保留展开状态。
8. 如果 group 消失再重新出现，可以重置为收起。

建议 group key：

```ts
const FREE_CHAT_GROUP = "__free__";
const projectGroupKey = project.id;
```

## 展开/收起交互

`展开显示` 行：

- 样式比会话行更弱。
- 左缩进与会话标题对齐。
- 不显示时间。
- 不显示 hover 操作按钮。
- 鼠标 hover 有轻微文字颜色变化。
- 点击区域整行可点。

文案：

- 未展开：`展开显示`
- 已展开：`收起显示`

如果需要显示数量，可后续扩展为 `展开显示 7 条更多`。当前版本先按截图保持简洁。

## 会话行布局

单行结构：

```text
[title / optional automation label]                    [time | loading | unread]
```

推荐 DOM 语义：

```tsx
<li className="convo-row">
  <button className="convo-main">
    <span className="convo-title-zone">
      <span className="automation-chip">自动化</span>
      <span className="convo-title">优化 Chat 左侧会话列表...</span>
      <span className="unread-dot" />
    </span>

    <span className="convo-trailing">
      <Spinner />
      或 21 分
      或 unread badge
    </span>
  </button>

  <div className="convo-actions">...</div>
</li>
```

视觉规则：

1. 行高：约 32-36px。
2. 当前选中行：浅色背景，圆角 pill。
3. 标题超长省略。
4. 右侧时间固定宽度或最大宽度，避免 hover/actions 时抖动。
5. hover 显示操作按钮，但不改变行高、不挤压标题。
6. 操作按钮浮在右侧区域上方；hover 时可以隐藏时间，但不能导致 layout shift。
7. 当前选中行不需要一直展示操作按钮，除非 hover/focus。
8. keyboard focus 要有可见 focus ring。

## 会话行点击

- 点击主区域恢复会话。
- 点击操作按钮不恢复会话。
- 编辑标题时，主点击禁用，避免误跳转。
- 支持键盘 Tab 到会话行，Enter/Space 激活。

## 运行中状态

运行中会话不再进入单独的 `running-section`。

规则：

1. 删除或隐藏“运行中”分组。
2. 运行中会话仍显示在原本所属 group 中：
   - 未绑定项目：在 `会话` group。
   - 绑定项目：在对应项目 group。
3. 会话右侧显示 loading spinner。
4. loading spinner 优先级高于时间。
5. 如果会话运行中且未读：
   - 右侧显示 spinner。
   - 标题附近保留未读小点。
6. spinner 尺寸约 14-16px。
7. spinner 不改变行宽，不挤压文字。
8. 多个运行中会话可同时显示 spinner。

状态判断：

```ts
const isRunning =
  status === "running" ||
  status === "waiting_approval" ||
  status === "waiting_hitl";
```

展示建议：

- `running`：spinner。
- `waiting_approval`：spinner + 可选状态色，或右侧短文案 `审批`。
- `waiting_hitl`：spinner + 可选状态色，或右侧短文案 `输入`。

如果要严格贴近截图，右侧统一用 spinner，不额外显示文案。

## 自动化执行标签

自动化标签必须保留。

自动化会话定义：

```ts
const isAutomation = row.source === "requirement" || !!row.requirement_title;
```

展示规则：

1. 自动化标签显示在标题前或标题附近。
2. 标签文案建议：
   - 中文：`自动化`
   - 英文：`Auto`
3. 如果当前已有 `需求任务` / `Auto` 语义，可以保留，但视觉上要更紧凑。
4. 标签不能占用右侧时间/loading 区。
5. 标签过多时，不展示项目名，因为项目名已经由 group 表达。
6. 自动化会话仍按项目归组，不因为自动化单独分区。

推荐视觉：

```text
[自动化] 优化 Chat 左侧会话列表...       21 分
```

或更克制：

```text
优化 Chat 左侧会话列表...               21 分
```

标题前用小色点或小 chip 表达自动化。

## 未读提示

未读消息需要明确提示。

数据需求：

- 每个会话行需要一个 unread 状态。
- 最小可用字段：
  - `unread_count?: number`
  - 或 `has_unread?: boolean`
- 如果后端暂时没有，可先在前端 store 中维护本地状态。

展示优先级：

```text
1. running/loading
2. unread
3. time
```

具体规则：

1. 普通未读：
   - 右侧显示小圆点或数字 badge。
   - 时间可以隐藏，或保留在小圆点左侧。
2. 运行中 + 未读：
   - 右侧显示 spinner。
   - 标题后显示未读小点。
3. 选中会话：
   - 进入后清除未读状态。
4. 后台会话收到新消息：
   - 如果不是 active conversation，标记未读。
5. 当前 active conversation 收到消息：
   - 不标记未读。
6. 未读 badge 不参与排序。
7. 未读提示颜色建议使用 accent，但不要使用强红，避免和错误状态混淆。

推荐视觉：

```text
普通未读：标题后一个小实心点
有数量：右侧小 badge，例如 2
运行中未读：spinner + 标题小点
```

## 状态优先级

会话右侧 trailing 区域优先级：

```ts
if (isRunning) showSpinner();
else if (unreadCount > 0) showUnreadBadgeOrDot();
else showRelativeTime();
```

标题区辅助状态优先级：

```ts
if (isAutomation) showAutomationChip();
if (isUnread && isRunning) showUnreadDotNearTitle();
if (isArchived) dimRow();
if (isAbandoned) dimAndStrikeTitle();
```

## 空态

项目组没有会话：

```text
项目名
  暂无对话
```

样式：

- 与会话行标题左对齐。
- 文本颜色更浅。
- 不可点击。
- 行高接近普通行，但更轻。

`会话` 组没有普通对话：

- 也显示 `暂无对话`。
- 不隐藏该组，保持截图中的结构稳定。

## 筛选器交互

现有筛选器：

- 全部
- 自动
- 手动

在按项目展示下，筛选器作用于所有 group 内的会话。

规则：

1. `全部`：显示所有会话。
2. `自动`：每个 group 只显示自动化会话。
3. `手动`：每个 group 只显示非自动化会话。
4. 如果筛选后某个项目没有会话：
   - 仍显示项目 header。
   - 显示 `暂无对话`。
5. `会话` 组同样受筛选影响。
6. 展开数量基于筛选后的结果计算。

示例：

```ts
const filteredRowsByGroup = group.rows.filter(matchesAutoFilter);
const visibleRows = expanded
  ? filteredRowsByGroup
  : filteredRowsByGroup.slice(0, 5);
```

## 按日期展示兼容

如果用户切回“按日期”：

1. 保留原日期分组逻辑。
2. 不展示项目 header。
3. 不强制使用每组 5 条限制，除非产品希望所有 group 统一。
4. 正在运行会话仍不进入单独 running group。
5. 运行中仍在原日期位置显示 spinner。

建议：这次优先规范“按项目”模式。日期模式可只移除 running group，其他保持现状。

## 数据模型需求

当前需要或建议补充字段：

```ts
interface ConvoListRow {
  id: string;
  title: string;
  project_id?: string | null;
  source?: "chat" | "requirement" | string;
  requirement_title?: string | null;
  created_at: string;
  updated_at: string;
  lifecycle?: "active" | "archived" | "abandoned";
  unread_count?: number;
  has_unread?: boolean;
}
```

运行态来自现有：

```ts
conversationRuns[row.id]?.status;
```

项目来自现有：

```ts
projectsById[row.project_id];
projects;
```

新增前端 UI 状态：

```ts
expandedConvoGroups: Record<string, boolean>;
toggleConvoGroupExpanded(groupKey: string): void;
clearConversationUnread(id: string): void;
markConversationUnread(id: string): void;
```

如果暂时不加 store 持久化，展开状态可以先放在 `ConvoList` local state。

## 分组算法

输入：

- `rows`
- `projects`
- `projectsById`
- `convoAutoFilter`
- `expandedGroups`

输出：

```ts
type ConversationGroup = {
  key: string;
  label: string;
  icon: "chat" | "folder";
  kind: "free" | "project";
  rows: ConvoListRow[];
  visibleRows: ConvoListRow[];
  total: number;
  isExpanded: boolean;
  canExpand: boolean;
};
```

算法：

```ts
const freeRows = rows.filter((r) => !r.project_id);
const projectRows = groupRowsByProjectId(rows.filter((r) => r.project_id));

const freeGroup = {
  key: "__free__",
  label: t("conversationsGroupFree"),
  kind: "free",
  rows: applyFilter(freeRows),
};

const projectGroups = projects.map((project) => {
  const rows = applyFilter(projectRows[project.id] ?? []);
  return {
    key: project.id,
    label: project.name,
    kind: "project",
    rows,
  };
});

sortProjectGroups(projectGroups);

return [freeGroup, ...projectGroups].map(applyLimit);
```

Limit：

```ts
const isExpanded = !!expandedGroups[group.key];
const visibleRows = isExpanded ? group.rows : group.rows.slice(0, 5);
const canExpand = group.rows.length > 5;
```

## 操作按钮

保留现有会话操作：

- pin/unpin
- export
- rename
- abandon
- delete

交互规则：

1. hover/focus row 时显示。
2. 不 hover 时隐藏。
3. 在 touch 设备上可以常显。
4. 操作按钮区域绝对定位。
5. 操作按钮出现时，右侧时间/未读可淡出，但不改变布局。
6. 操作按钮必须有 `aria-label`。
7. 删除、废弃等高风险操作沿用现有确认逻辑。

## 视觉规格

侧边栏背景：

- 保持当前浅色背景。
- 避免重阴影、渐变、装饰性背景。

Section title `项目`：

- 字号 13-14px。
- 颜色 muted。
- 左缩进与 group header 对齐或略小。
- 上下留白清晰。

Group header：

- 高度约 32px。
- folder icon 16-18px。
- 项目名字号 15-16px。
- 颜色 muted，但比 section title 更强。
- 超长项目名省略。
- 不可点击，除非未来支持折叠整个项目。

Conversation row：

- 高度 32-36px。
- 左缩进比 group header 更深。
- 标题字号 14-15px。
- 时间字号 12-13px。
- 当前行背景：浅色 pill。
- 圆角 8px 左右。
- hover 背景略深。
- 不使用渐变。
- 不使用阴影。

Loading spinner：

- 直径 14-16px。
- 线宽 2px。
- 颜色 muted。
- 动画匀速旋转。
- `prefers-reduced-motion` 下停止动画，显示静态 spinner。

Unread：

- 小圆点 6-8px。
- 或数字 badge 高 16px。
- 颜色 accent。
- 不使用红色，除非代表错误。

## 可访问性

1. 会话行主操作使用 `<button>`。
2. group header 可用 `role="presentation"` 或普通 `li` 文本。
3. 列表使用 `<ul>` / `<li>`。
4. `展开显示` / `收起显示` 使用 `<button>`。
5. 当前会话行可加 `aria-current="page"` 或 `aria-pressed`，二选一。
6. loading spinner 装饰性使用 `aria-hidden="true"`；如需读屏状态，可在 row label 中包含 `运行中`。
7. unread 的 row label 包含 `未读` 或 `N 条未读`。
8. 自动化的 row label 包含 `自动化`。
9. hover-only 操作也必须能通过 keyboard focus 显示。

## i18n 文案

新增或确认以下 key：

```ts
projectSectionTitle: "项目" / "Projects";
conversationsGroupFree: "会话" / "Chats";
groupExpand: "展开显示" / "Show more";
groupCollapse: "收起显示" / "Show less";
groupEmpty: "暂无对话" / "No conversations";
unreadOne: "未读" / "Unread";
unreadCount: (n) => `${n} 条未读`;
automationTag: "自动化" / "Auto";
runningConversation: "运行中" / "Running";
```

现有可复用：

- `groupNoProject` 可替换为 `会话`，但建议新增更明确 key。
- `convoAutoFilterAll`
- `convoAutoFilterAuto`
- `convoAutoFilterManual`
- `convoStatusRunning`

## 边界情况

1. 项目被删除，但会话仍引用旧 `project_id`：
   - 放入 fallback group，名称用 project id 或 `未知项目`。
2. 会话没有 title：
   - 使用现有 `resolveTitle(row)` fallback。
3. 时间缺失：
   - 不显示右侧时间。
4. 所有 group 都为空：
   - 仍展示 `会话` group + `暂无对话`。
5. 筛选为“自动”后无自动化会话：
   - 每个 group 显示 `暂无对话`，或只在整体显示空态。
   - 建议第一版保持 group 结构，便于用户理解筛选结果。
6. 运行中会话不在 `rows` 中但存在于 `conversationRuns`：
   - 使用 fallback row，归入 `会话` group，直到服务端列表刷新。
7. 未读会话被删除：
   - 删除 unread 状态。
8. rename 时：
   - 输入框占据整行主区域。
   - 操作按钮可隐藏。
9. 当前 active 会话不在默认前 5 条内：
   - 该 group 应自动显示 active 行。
   - 更简单的第一版：active 所在 group 自动展开。
   - 推荐采用：active 所在 group 自动展开，因为最符合“当前上下文可见”。

## Active Group 展开规则

为了避免当前会话被默认 5 条隐藏：

1. 如果 active conversation 属于某个 group：
   - 该 group 渲染时视为 expanded。
2. 用户手动点击 `收起显示`：
   - 如果 active row 超过第 5 条，仍不能隐藏 active row。
3. 可实现为：

```ts
const effectiveExpanded = userExpanded || groupContainsActiveBeyondLimit;
```

4. 如果是因为 active 自动展开，仍显示 `收起显示`。
5. 点击收起后可回到默认展示，但 active row 需要保留可见。
6. 简化实现：active group 始终展开。

## 验收标准

### 功能验收

1. 按项目展示时，顶部 section 为 `项目`。
2. `会话` group 出现在所有项目 group 之前。
3. `会话` group 与项目 group 平级。
4. 每个项目 group 默认最多显示 5 条会话。
5. 超过 5 条时出现 `展开显示`。
6. 点击 `展开显示` 只展开当前 group。
7. 展开后出现 `收起显示`。
8. 项目无会话时显示 `暂无对话`。
9. 运行中会话不再进入独立“运行中”分组。
10. 运行中会话在原 group 中右侧显示 loading。
11. 自动化标签仍显示。
12. 未读会话有可见提示。
13. 点击会话后未读状态清除。
14. hover 操作按钮不造成行高变化。
15. 当前 active 会话可见，不会被默认 5 条隐藏。

### 视觉验收

1. 侧边栏没有重阴影和渐变。
2. 项目 header 与截图层级一致。
3. 会话行密度接近截图。
4. 当前选中行是浅色圆角背景。
5. loading、未读、时间三者不会重叠。
6. 中文长标题省略自然，不挤出容器。
7. 375px 宽度下无横向滚动。

### 技术验收

1. `npm test -- AppSidebar.test.tsx` 通过。
2. 新增分组逻辑有单元测试或组件测试覆盖。
3. `npm run build` 通过。
4. ESLint 通过。
5. 不破坏日期分组模式。
6. 不改动后端协议时，未读功能可先使用前端本地状态兜底；如果需要真实未读，再补后端字段。

## 建议实施拆分

第一步：结构与分组

- 移除 running section。
- 生成 `[会话, ...项目组]`。
- 默认每组 5 条。
- 加 `展开显示` / `收起显示`。

第二步：会话行状态

- running 在原 row 右侧显示 spinner。
- 自动化标签保留。
- hover actions 稳定布局。

第三步：未读

- 增加 unread 状态。
- 后台帧到达时标记未读。
- resume/active 时清除未读。

第四步：测试与视觉 QA

- AppSidebar tests 覆盖分组、展开、running、unread。
- 浏览器检查 375px、当前桌面宽度、长中文标题。

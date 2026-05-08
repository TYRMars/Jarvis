---
name: doc
description: 管理 Jarvis 的文档库（DocProject + DocDraft）—— 搜索文档、读取正文、新建、改元数据、保存草稿、归档/删除。当用户想通过自然语言增删改查 docs、笔记、草稿、研究报告、设计方案、指南时使用。
activation: both
keywords: [doc, docs, document, 文档, 笔记, note, draft, 草稿, research, report, design, guide, 写作]
version: "0.1.0"
---

# Doc：文档管理

文档分两层：**DocProject**（元数据：标题、kind、tags、置顶/归档）+
**DocDraft**（实际 markdown 内容，append-only 多版本，UI 默认展示最新一条）。
所有写操作都需要审批。

## 工具

- `doc.list { workspace?, archived?, pinned_only? }`
  列当前 workspace 下所有 DocProject。`workspace` 留空 = 用 agent 当前 pin 的
  根。`archived` 默认 false（不含归档）。
- `doc.search { query?, workspace?, archived?, limit? }`
  按标题、tags、kind、最新草稿正文搜索。用户用自然语言提到某篇文档但没给 id
  时，先用它定位候选；`query` 留空可看最近文档。
- `doc.get { id, with_draft? }`
  元数据 + 可选最新草稿（`with_draft: true` 时附带）。
- `doc.upsert { id?, title?, content?, kind?, tags?, pinned?, archived?, workspace? }`
  面向自然语言的一步创建/更新：有 `id` 就更新该文档；没 id 时用 workspace
  内的精确标题匹配，匹配不到则创建。`content` 会追加为最新 markdown 草稿。
  标题匹配到多篇会报错，此时改用 `doc.search` 找候选并让用户确认。
- `doc.create { title, kind?, tags?, pinned?, workspace? }`
  创建空 DocProject。`kind` ∈ {`note`, `research`, `report`, `design`, `guide`}，
  缺省 `note`。
- `doc.update { id, title?, kind?, tags?, pinned?, archived? }`
  改元数据。要切换 archived/pinned 显式传 bool。
- `doc.delete { id }` —— 硬删除，**级联删掉所有 draft**，不可逆。
- `doc.draft.get { project_id }` —— 取最新草稿。
- `doc.draft.save { project_id, content, format? }`
  追加新草稿。**不会覆盖旧版本**，UI 自动取最新。`format` 默认 `markdown`。

## 行为约定

1. **写一篇文档**：优先 `doc.upsert { title, content, kind?, tags? }`，一次完成元数据
   + 正文；需要精细控制时再拆成 `doc.create` → `doc.draft.save`。
2. **查一篇文档**：用户没给 id 时先 `doc.search`，候选唯一再 `doc.get { with_draft:
   true }` 或 `doc.draft.get`。
3. **修改正文** = `doc.search`/`doc.get` 定位 → `doc.draft.get` 当起点 → 改完 →
   `doc.upsert { id, content }` 或 `doc.draft.save` 提新版本。
   不要试图"原地改" —— 草稿是 append-only。
4. **kind 选型**：随手记 `note`、调研结论 `research`、对外汇报 `report`、
   方案设计 `design`、操作指南 `guide`。
5. 草稿单篇 ≤ 50KB；超长内容拆多篇 DocProject 互相引用。
6. **删除整篇前必须确认用户意图** —— 草稿历史会一并消失。
   用户不确定时，建议先 `doc.update { archived: true }` 而不是 delete。

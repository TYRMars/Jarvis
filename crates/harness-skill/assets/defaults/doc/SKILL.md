---
name: doc
description: 管理 Jarvis 的文档库（DocProject + DocDraft）—— 列出文档、新建、改元数据、保存草稿、删除。当用户提到"文档"、"笔记"、"写一篇"、"草稿"、"研究报告"、"设计方案"等场景时使用。
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
- `doc.get { id, with_draft? }`
  元数据 + 可选最新草稿（`with_draft: true` 时附带）。
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

1. **写一篇文档** = `doc.create` 拿到 id → `doc.draft.save` 写正文。两步审批。
2. **修改正文** = `doc.draft.get` 当起点 → 改完 → `doc.draft.save` 提新版本。
   不要试图"原地改" —— 草稿是 append-only。
3. **kind 选型**：随手记 `note`、调研结论 `research`、对外汇报 `report`、
   方案设计 `design`、操作指南 `guide`。
4. 草稿单篇 ≤ 50KB；超长内容拆多篇 DocProject 互相引用。
5. **删除整篇前必须确认用户意图** —— 草稿历史会一并消失。
   用户不确定时，建议先 `doc.update { archived: true }` 而不是 delete。

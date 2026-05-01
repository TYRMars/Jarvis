---
name: work
description: 管理 Jarvis 的项目（Projects）—— 列出、查看、新建、改名、归档、恢复、删除。当用户提到"项目"、"建个 project"、"归档项目"、"项目列表"、"工作空间组织"等场景时使用。
activation: both
keywords: [project, projects, 项目, 工程, kanban, archive, slug, work, workspace]
version: "0.1.0"
---

# Work：Project 管理

你可以通过下列工具管理用户的项目。所有写操作都会触发 ApprovalRequest，
等待用户在前端点击确认 —— 这是预期行为，不要因为"被拒绝"就放弃，把
`tool denied: <reason>` 当成"用户改主意了"。

## 工具

- `project.list { include_archived?: bool, limit?: u32 }`
  按 `updated_at` 倒序列出。`limit` 默认 50、上限 500。
- `project.get { id_or_slug: string }`
  按 id (UUID) 或 slug 查单条。
- `project.create { name, description?, instructions?, tags?, slug? }`
  `slug` 不传时按 `name` 派生（小写 + 连字符）。slug 全局唯一，撞了会报错。
- `project.update { id_or_slug, name?, description?, instructions?, tags?, slug? }`
  缺省字段保持不变。要清空 `description` 用空字符串。
- `project.archive { id }` —— 软删除，UI 仍能在"归档"分组看到。
- `project.restore { id }` —— 取消归档。
- `project.delete { id }` —— 硬删除，不可逆，会让历史会话失去 project 关联。

## 行为约定

1. **新建前先 list 一遍** —— 避免名字撞车。
2. **改属性用 update，不要 create 同名新项目**。
3. **用户说"删除"时优先建议 archive** —— 硬删除前必须显式确认。
4. `instructions` 是注入到该项目下会话 system-prompt 的片段，写得简短、
   行动导向（"用中文回复"、"以会议纪要格式输出"），不是项目描述。
5. 工具返回错误时把错误原因转述给用户而不是闷头重试。

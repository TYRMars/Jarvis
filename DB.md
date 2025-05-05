# 数据库表结构文档

## 1. Agent（智能体表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| id | INTEGER | 否 | 自增 | 主键 |
| user_id | INTEGER | 否 | - | 用户ID |
| name | STRING | 否 | - | 名称 |
| description | TEXT | 是 | - | 描述 |
| system_prompt | TEXT | 是 | - | 系统提示词 |
| tools | TEXT | 是 | - | 工具ID列表，JSON格式 |
| knowledge_base_ids | TEXT | 是 | - | 知识库ID列表，JSON格式 |
| prompt_id | INTEGER | 是 | - | 提示模板ID |
| prompt_variables | TEXT | 是 | - | 提示模板变量值，JSON格式 |
| custom_prompt | TEXT | 是 | - | 自定义提示词 |
| model_name | STRING | 否 | 'gpt-3.5-turbo' | 使用的模型名称 |
| model_parameters | TEXT | 是 | - | 模型参数，JSON格式 |
| provider | STRING | 否 | 'openai' | LLM提供商 |
| provider_config_id | INTEGER | 是 | - | LLM提供商配置ID |
| status | INTEGER | 否 | 1 | 状态：0-禁用，1-启用 |
| workflow_type | STRING | 是 | 'simple' | 工作流类型 |
| created_at | DATE | 否 | NOW() | 创建时间 |
| updated_at | DATE | 否 | NOW() | 更新时间 |

## 2. Conversation（对话表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| id | INTEGER | 否 | 自增 | 主键 |
| user_id | INTEGER | 否 | - | 用户ID |
| agent_id | INTEGER | 否 | - | 关联的Agent ID |
| session_id | STRING(100) | 否 | - | 会话ID |
| user_input | TEXT | 否 | - | 用户输入 |
| agent_response | TEXT | 否 | - | Agent响应 |
| tools_used | TEXT | 是 | - | 使用的工具，JSON格式 |
| created_at | DATE | 否 | - | 创建时间 |
| updated_at | DATE | 否 | - | 更新时间 |

## 3. AgentWorkflow（工作流表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| id | INTEGER | 否 | 自增 | 主键 |
| user_id | INTEGER | 否 | - | 用户ID |
| name | STRING(100) | 否 | - | 工作流名称 |
| description | TEXT | 是 | - | 工作流描述 |
| workflow_type | STRING(50) | 否 | 'intent_classification' | 工作流类型 |
| config | JSON | 否 | - | 工作流配置 |
| state | JSON | 是 | - | 工作流状态 |
| status | INTEGER | 否 | 1 | 状态：0-禁用，1-启用 |
| created_at | DATE | 否 | - | 创建时间 |
| updated_at | DATE | 否 | - | 更新时间 |

## 4. AgentWorkflowNode（工作流节点表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| id | INTEGER | 否 | 自增 | 主键 |
| workflow_id | INTEGER | 否 | - | 工作流ID |
| node_type | STRING(50) | 否 | - | 节点类型 |
| name | STRING(100) | 否 | - | 节点名称 |
| config | JSON | 否 | - | 节点配置 |
| position | JSON | 否 | - | 节点位置 |
| edges | JSON | 是 | - | 节点连接关系 |
| created_at | DATE | 否 | - | 创建时间 |
| updated_at | DATE | 否 | - | 更新时间 |

## 5. User（用户表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| id | INTEGER | 否 | 自增 | 主键 |
| name | STRING | 否 | - | 用户名 |
| email | STRING | 否 | - | 邮箱 |
| password | STRING | 否 | - | 密码 |
| status | INTEGER | 否 | 1 | 状态 |
| created_at | DATE | 否 | - | 创建时间 |
| updated_at | DATE | 否 | - | 更新时间 |

## 6. Prompt（提示模板表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| id | INTEGER | 否 | 自增 | 主键 |
| name | STRING | 否 | - | 模板名称 |
| content | TEXT | 否 | - | 模板内容 |
| variables | TEXT | 是 | - | 变量定义 |
| status | INTEGER | 否 | 1 | 状态 |
| created_at | DATE | 否 | - | 创建时间 |
| updated_at | DATE | 否 | - | 更新时间 |

## 7. LlmProviderConfig（LLM提供商配置表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| id | INTEGER | 否 | 自增 | 主键 |
| provider | STRING | 否 | - | 提供商名称 |
| config | TEXT | 否 | - | 配置信息 |
| status | INTEGER | 否 | 1 | 状态 |
| created_at | DATE | 否 | - | 创建时间 |
| updated_at | DATE | 否 | - | 更新时间 |

## 8. Tool（工具表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| id | INTEGER | 否 | 自增 | 主键 |
| name | STRING | 否 | - | 工具名称 |
| description | TEXT | 是 | - | 工具描述 |
| parameters | TEXT | 是 | - | 参数定义 |
| status | INTEGER | 否 | 1 | 状态 |
| created_at | DATE | 否 | - | 创建时间 |
| updated_at | DATE | 否 | - | 更新时间 |

## 9. KnowledgeBase（知识库表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| id | INTEGER | 否 | 自增 | 主键 |
| name | STRING | 否 | - | 知识库名称 |
| description | TEXT | 是 | - | 知识库描述 |
| status | INTEGER | 否 | 1 | 状态 |
| created_at | DATE | 否 | - | 创建时间 |
| updated_at | DATE | 否 | - | 更新时间 |

## 10. 关联表

### Agent_Tool（Agent工具关联表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| agent_id | INTEGER | 否 | - | Agent ID |
| tool_id | INTEGER | 否 | - | 工具 ID |

### Agent_KnowledgeBase（Agent知识库关联表）

| 字段名 | 类型 | 允许空 | 默认值 | 说明 |
|--------|------|--------|---------|------|
| agent_id | INTEGER | 否 | - | Agent ID |
| knowledge_base_id | INTEGER | 否 | - | 知识库 ID |
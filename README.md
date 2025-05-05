# tegg app

[Hacker News](https://news.ycombinator.com/) showcase using [tegg](https://github.com/eggjs/tegg)

## QuickStart

### Development

```bash
npm i
npm run dev
open http://localhost:7001/
```

Don't tsc compile at development mode, if you had run `tsc` then you need to `npm run clean` before `npm run dev`.

### Deploy

```bash
npm run tsc
npm start
```

### Npm Scripts

- Use `npm run lint` to check code style
- Use `npm test` to run unit test
- se `npm run clean` to clean compiled js at development mode once

### Requirement

- Node.js >= 18.x
- Typescript >= 5.x

## Agent记忆功能

系统支持Agent短期记忆和长期记忆功能，增强对话连贯性和个性化体验。

### 记忆类型

1. **短期记忆**：
   - 存储在内存中，针对当前会话
   - 用于维持会话上下文和临时状态
   - 随会话结束而清除

2. **长期记忆**：
   - 存储在数据库中，持久化保存
   - 用于记住用户偏好、事实和重要信息
   - 在会话中被检索并加入到对话上下文

### API接口

系统提供以下API接口管理Agent记忆：

- `GET /api/agent-memories` - 获取Agent的长期记忆
- `POST /api/agent-memories` - 添加或更新长期记忆
- `DELETE /api/agent-memories` - 删除长期记忆
- `POST /api/agent-memories/short-term/clear` - 清除短期记忆
- `POST /api/agent-memories/process` - 从对话中提取记忆

### 记忆处理流程

1. 用户发送消息时，系统检索相关长期记忆
2. 相关记忆和RAG检索结果一起加入到Agent的系统提示中
3. 对话完成后，系统自动分析对话内容，提取重要信息存入长期记忆
4. 记忆按重要性和最近访问时间排序，确保优先使用最相关的信息

### 技术实现

- 使用内存Map存储短期记忆
- 使用MySQL数据库存储长期记忆
- 通过LLM分析确定记忆的重要性和相关性
- 实现按需检索，只加载与当前对话相关的记忆

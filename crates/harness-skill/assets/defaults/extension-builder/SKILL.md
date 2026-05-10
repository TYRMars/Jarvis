---
name: extension-builder
description: 生成或修改 Jarvis 扩展：Skill、MCP server 配置、plugin.json 插件包。当用户想让 Jarvis 新增能力、封装工作流、接入外部工具/MCP、创建默认插件、搭建 examples/plugins 下的插件目录时使用。
activation: both
keywords: [skill, skills, mcp, plugin, plugins, extension, 扩展, 插件, 能力, 工具, 集成, 接入, 生成]
version: "0.1.0"
---

# Extension Builder：生成 Skill / MCP / Plugin

你负责按 Jarvis 仓库约定生成扩展。先判断用户要的是哪一类：

- **Skill**：只需要教 agent 一套领域工作流或工具使用方法；产物是 `SKILL.md`。
- **MCP server 接入**：已有外部 MCP server，需要让 Jarvis 通过 `mcp_servers` 注册工具。
- **Plugin**：要把 skills、MCP servers、channel adapters 等打包成可安装目录；产物是 `plugin.json` + 可选 `skills/`。

优先复用现有结构，不改 `harness-core`。只有新增 Rust 原生能力、store、路由或工具时，才建议新 crate / server route。

## 生成 Skill

位置：

- bundled 默认 skill：`crates/harness-skill/assets/defaults/<name>/SKILL.md`
- workspace skill：`.jarvis/skills/<name>/SKILL.md`
- user skill：`~/.config/jarvis/skills/<name>/SKILL.md`
- plugin 内 skill：`examples/plugins/<plugin>/skills/<name>/SKILL.md`

`SKILL.md` 必须是：

```markdown
---
name: kebab-case-name
description: 一句话说明何时使用这个 skill，要包含用户可能说出的触发词。
activation: both
keywords: [keyword1, keyword2]
version: "0.1.0"
---

# 简短标题

只写 agent 执行任务所需的流程、约束、工具选择和验证方式。
```

约定：

1. `name` 必须是 kebab-case，1 到 64 字符。
2. `description` 控制自动触发，写清“什么时候用”，不要写营销文案。
3. 正文保持短，避免复制大段 API 文档；长参考放到 `references/`，并在正文说明何时读取。
4. 不要额外创建 README / CHANGELOG / QUICKSTART，除非用户明确要。
5. 修改后用 `cargo test -p harness-skill` 或至少确认 frontmatter 可被 `parse_skill` 解析。

## 生成 MCP 接入

如果用户已有 MCP server，优先做成 plugin 的 `mcp_servers`，这样可通过 UI / CLI 安装卸载：

```json
{
  "name": "example-tools",
  "version": "0.1.0",
  "description": "Example MCP integration.",
  "skills": ["skills/example-workflow"],
  "mcp_servers": {
    "example": {
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "example-mcp-server"]
      },
      "env": {
        "EXAMPLE_TOKEN": "${env:EXAMPLE_TOKEN}"
      }
    }
  }
}
```

MCP 约定：

1. `mcp_servers` map key 是工具名前缀；远端工具会变成 `<prefix>.<tool>`。
2. prefix 用小写短名，避免和内置工具冲突。
3. secret 只通过环境变量传入，不写进 `plugin.json`。
4. 如果只是本机一次性配置，也可以建议写入 config 的 `mcp_servers`；但可分发能力优先 plugin。
5. 如果 MCP 需要额外使用说明，同时生成一个 companion skill。

## 生成 Plugin

Jarvis plugin 是一个本地目录，根目录必须有 `plugin.json`。示例位置：

```text
examples/plugins/<plugin-name>/
  plugin.json
  skills/<skill-name>/SKILL.md
```

最小 manifest：

```json
{
  "name": "plugin-name",
  "version": "0.1.0",
  "description": "What this plugin adds.",
  "author": "Jarvis Project",
  "license": "MIT",
  "skills": ["skills/plugin-workflow"]
}
```

带 MCP 的 manifest：

```json
{
  "name": "plugin-name",
  "version": "0.1.0",
  "description": "Skills plus MCP tools.",
  "author": "Jarvis Project",
  "license": "MIT",
  "skills": ["skills/plugin-workflow"],
  "mcp_servers": {
    "toolprefix": {
      "transport": {
        "type": "stdio",
        "command": "uvx",
        "args": ["some-mcp-server"]
      }
    }
  }
}
```

Plugin 约定：

1. `plugin.json` 的 `name` 必须是 kebab-case。
2. `skills` 路径相对 plugin 根目录，通常是 `skills/<name>`。
3. 不要在 plugin 中硬编码 token、workspace path、用户私有目录。
4. 如果加入默认 marketplace，更新 `crates/harness-server/src/plugin_routes.rs` 的 `/v1/plugins/marketplace` stub 和对应测试。
5. 安装路径可通过 `jarvis plugin install <path>` 或 Web 设置页安装。

## 选择策略

- 用户说“加一个工作流/规范/助手能力”：生成 Skill。
- 用户说“接入某个工具的 MCP”：生成 Plugin + `mcp_servers` + companion Skill。
- 用户说“做默认插件/可安装包”：生成 Plugin。
- 用户说“原生支持某个平台项目同步”：不要只生成 MCP；先设计 connector / store / route，再用 plugin 放 companion Skill。

## 验证

完成后至少做这些检查：

1. `SKILL.md` frontmatter 字段只使用 Jarvis 支持的字段：`name`、`description`、`license`、`allowed-tools`、`activation`、`keywords`、`version`。
2. `plugin.json` 能被 `harness-plugin` manifest 解析，路径都存在。
3. MCP command / args 是可执行的；secret 通过 env 注入。
4. 如果改了 bundled skills，运行 `cargo test -p harness-skill`。
5. 如果改了 plugin marketplace，运行相关 server route 测试或 `cargo test -p harness-server plugin_routes`.

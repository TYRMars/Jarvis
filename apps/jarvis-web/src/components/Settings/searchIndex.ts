// Search index for the settings page nav. Entries cover every
// section + every tab inside a super-section, plus a hand-curated
// list of field-level aliases per entry (e.g. "default model",
// "effort" → Layout tab) so users can type a setting name they
// remember without thinking about which Tab it's behind.
//
// Tokens are kept as a flat string array (English + Chinese mixed),
// all lowercased once at module load. The match function does a
// simple lowercase substring scan; ranking prefers earlier matches
// in the primary label over alias hits. This is intentionally
// dumb — fuzzy editing-distance would be overkill for ~60 tokens.

export interface SearchEntry {
  /// Section id (matches the hash segment used by SettingsPage).
  sectionId: string;
  /// Optional tab id within a super-section.
  tabId?: string;
  /// i18n key for the parent group's heading (used for breadcrumb display).
  groupKey: string;
  /// Fallback group label.
  groupFallback: string;
  /// i18n key for this entry's primary label (section name OR tab name).
  primaryKey: string;
  /// Fallback for the primary label.
  primaryFallback: string;
  /// i18n key for the parent section's name (for tab entries) — used
  /// in the breadcrumb so a tab hit reads "Capabilities · Models · Providers".
  /// Undefined for top-level section entries.
  parentSectionKey?: string;
  /// Fallback parent section name.
  parentSectionFallback?: string;
  /// Search tokens (lowercased): primary label + any synonyms. The
  /// first token is treated as the canonical name for ranking.
  tokens: string[];
}

/// Single source of truth for what's searchable in settings.
/// Order matters only for stable ranking ties.
export const SEARCH_ENTRIES: SearchEntry[] = [
  // ─────── General ───────
  {
    sectionId: "appearance-layout",
    groupKey: "settingsNavGroupGeneral",
    groupFallback: "General",
    primaryKey: "settingsNavAppearanceLayout",
    primaryFallback: "Appearance & Layout",
    tokens: ["appearance & layout", "外观与界面", "appearance", "外观", "layout", "界面布局"],
  },
  {
    sectionId: "appearance-layout",
    tabId: "appearance",
    groupKey: "settingsNavGroupGeneral",
    groupFallback: "General",
    parentSectionKey: "settingsNavAppearanceLayout",
    parentSectionFallback: "Appearance & Layout",
    primaryKey: "settingsTabAppearance",
    primaryFallback: "Appearance",
    tokens: [
      "appearance", "外观",
      "theme", "主题", "dark", "light", "暗色", "亮色", "深色", "浅色",
      "language", "语言", "english", "中文", "i18n", "lang",
    ],
  },
  {
    sectionId: "appearance-layout",
    tabId: "layout",
    groupKey: "settingsNavGroupGeneral",
    groupFallback: "General",
    parentSectionKey: "settingsNavAppearanceLayout",
    parentSectionFallback: "Appearance & Layout",
    primaryKey: "settingsTabLayout",
    primaryFallback: "Layout",
    tokens: [
      "layout", "界面布局", "preferences", "偏好",
      "default model", "默认模型", "default routing", "routing", "model",
      "effort", "思考强度",
      "sidebar", "侧栏", "workspace rail", "工作区面板",
      "plan card", "plan",
      "clear data", "清除数据", "reset", "清空",
    ],
  },
  {
    sectionId: "persona",
    groupKey: "settingsNavGroupGeneral",
    groupFallback: "General",
    primaryKey: "settingsNavPersona",
    primaryFallback: "Persona",
    tokens: [
      "persona", "人格", "jarvis 人格",
      "soul", "灵魂", "灵魂配置",
      "identity", "身份", "voice", "语气",
      "principles", "原则", "boundaries", "边界",
      "system prompt", "系统提示",
    ],
  },

  // ─────── Capabilities ───────
  {
    sectionId: "models",
    groupKey: "settingsNavGroupCapabilities",
    groupFallback: "Capabilities",
    primaryKey: "settingsNavModels",
    primaryFallback: "Models",
    tokens: ["models", "模型", "llm"],
  },
  {
    sectionId: "models",
    tabId: "providers",
    groupKey: "settingsNavGroupCapabilities",
    groupFallback: "Capabilities",
    parentSectionKey: "settingsNavModels",
    parentSectionFallback: "Models",
    primaryKey: "settingsTabProviders",
    primaryFallback: "Providers",
    tokens: [
      "providers", "供应商", "模型供应商",
      "openai", "anthropic", "google", "gemini", "kimi", "moonshot",
      "ollama", "codex", "chatgpt",
      "api key", "api 密钥", "base url", "endpoint", "凭证", "credential",
    ],
  },
  {
    sectionId: "models",
    tabId: "subagents",
    groupKey: "settingsNavGroupCapabilities",
    groupFallback: "Capabilities",
    parentSectionKey: "settingsNavModels",
    parentSectionFallback: "Models",
    primaryKey: "settingsTabSubagents",
    primaryFallback: "Subagents",
    tokens: [
      "subagents", "子智能体", "subagent",
      "agent profile", "agent profiles",
      "preset", "preset agent",
      "specialist", "专家",
    ],
  },
  {
    sectionId: "extensions",
    groupKey: "settingsNavGroupCapabilities",
    groupFallback: "Capabilities",
    primaryKey: "settingsNavExtensions",
    primaryFallback: "Extensions",
    tokens: ["extensions", "扩展"],
  },
  {
    sectionId: "extensions",
    tabId: "mcp",
    groupKey: "settingsNavGroupCapabilities",
    groupFallback: "Capabilities",
    parentSectionKey: "settingsNavExtensions",
    parentSectionFallback: "Extensions",
    primaryKey: "settingsTabMcp",
    primaryFallback: "MCP servers",
    tokens: [
      "mcp", "mcp 服务器", "mcp servers",
      "tool prefix", "前缀",
      "uvx", "stdio", "remote tools",
      "command line", "命令行",
    ],
  },
  {
    sectionId: "extensions",
    tabId: "skills",
    groupKey: "settingsNavGroupCapabilities",
    groupFallback: "Capabilities",
    parentSectionKey: "settingsNavExtensions",
    parentSectionFallback: "Extensions",
    primaryKey: "settingsTabSkills",
    primaryFallback: "Skills",
    tokens: [
      "skills", "技能", "skill",
      "skill pack", "skill.md",
      "frontmatter",
      "markdown",
    ],
  },
  {
    sectionId: "extensions",
    tabId: "plugins",
    groupKey: "settingsNavGroupCapabilities",
    groupFallback: "Capabilities",
    parentSectionKey: "settingsNavExtensions",
    parentSectionFallback: "Extensions",
    primaryKey: "settingsTabPlugins",
    primaryFallback: "Plugins",
    tokens: [
      "plugins", "插件", "plugin",
      "marketplace", "市场",
      "install", "安装", "uninstall", "卸载",
      "bundle", "包",
    ],
  },
  {
    sectionId: "permissions",
    groupKey: "settingsNavGroupCapabilities",
    groupFallback: "Capabilities",
    primaryKey: "settingsNavPermissions",
    primaryFallback: "Permissions",
    tokens: [
      "permissions", "权限",
      "deny", "拒绝", "allow", "允许", "ask", "询问",
      "rule", "规则", "rules",
      "approval", "审批", "approver",
      "default mode", "默认模式",
      "shell", "fs", "filesystem",
    ],
  },

  // ─────── Workspace ───────
  {
    sectionId: "projects",
    groupKey: "settingsNavGroupWorkspace",
    groupFallback: "Workspace",
    primaryKey: "settingsNavProjects",
    primaryFallback: "Projects",
    tokens: [
      "projects", "项目",
      "archive", "archived", "归档",
      "context", "上下文",
      "instructions", "指令",
    ],
  },
  {
    sectionId: "system",
    groupKey: "settingsNavGroupWorkspace",
    groupFallback: "Workspace",
    primaryKey: "settingsNavSystem",
    primaryFallback: "System",
    tokens: ["system", "系统"],
  },
  {
    sectionId: "system",
    tabId: "workspace",
    groupKey: "settingsNavGroupWorkspace",
    groupFallback: "Workspace",
    parentSectionKey: "settingsNavSystem",
    parentSectionFallback: "System",
    primaryKey: "settingsTabWorkspace",
    primaryFallback: "Workspace",
    tokens: [
      "workspace", "工作目录", "work dir",
      "root", "根目录",
      "git", "branch", "分支", "head", "dirty", "未提交",
      "vcs",
    ],
  },
  {
    sectionId: "system",
    tabId: "server",
    groupKey: "settingsNavGroupWorkspace",
    groupFallback: "Workspace",
    parentSectionKey: "settingsNavSystem",
    parentSectionFallback: "System",
    primaryKey: "settingsTabServer",
    primaryFallback: "Server",
    tokens: [
      "server", "服务端",
      "listen address", "监听地址",
      "runtime", "运行时",
      "config path", "配置文件路径",
      "persistence", "持久化",
    ],
  },
  {
    sectionId: "system",
    tabId: "api",
    groupKey: "settingsNavGroupWorkspace",
    groupFallback: "Workspace",
    parentSectionKey: "settingsNavSystem",
    parentSectionFallback: "System",
    primaryKey: "settingsTabApi",
    primaryFallback: "Connection",
    tokens: [
      "api", "connection", "后端连接",
      "origin", "源",
      "backend", "后端",
      "websocket", "ws",
      "reload", "刷新",
    ],
  },
  {
    sectionId: "system",
    tabId: "about",
    groupKey: "settingsNavGroupWorkspace",
    groupFallback: "Workspace",
    parentSectionKey: "settingsNavSystem",
    parentSectionFallback: "System",
    primaryKey: "settingsTabAbout",
    primaryFallback: "About",
    tokens: [
      "about", "关于",
      "version", "版本",
      "build", "构建",
      "documentation", "docs", "文档",
    ],
  },
];

// Lowercase the token table once. Doing it inline keeps the entries
// readable above (mixed case is fine for hand-edited synonyms).
const NORMALISED: { entry: SearchEntry; tokens: string[] }[] = SEARCH_ENTRIES.map(
  (entry) => ({
    entry,
    tokens: entry.tokens.map((t) => t.toLowerCase()),
  }),
);

export interface SearchHit {
  entry: SearchEntry;
  /// 0 = best (matched the primary token at position 0). Lower is better.
  score: number;
}

/// Returns hits ranked best-first. Empty array means "no matches".
/// Pass an empty/whitespace-only query to short-circuit to no hits;
/// the caller is expected to render the unfiltered nav in that case.
export function searchSettings(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: SearchHit[] = [];
  for (const { entry, tokens } of NORMALISED) {
    let best = -1;
    for (let i = 0; i < tokens.length; i++) {
      const idx = tokens[i].indexOf(q);
      if (idx === -1) continue;
      // Score: token-position * 100 + match-position. Earlier-listed
      // tokens dominate; within a token, earlier substring matches win.
      const score = i * 100 + idx;
      if (best === -1 || score < best) best = score;
    }
    if (best !== -1) {
      hits.push({ entry, score: best });
    }
  }
  hits.sort((a, b) => a.score - b.score);
  return hits;
}

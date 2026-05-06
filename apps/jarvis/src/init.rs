//! `jarvis init` — interactive onboarding wizard.
//!
//! Steps:
//!
//! 1. Pick interface language (English / 中文).
//! 2. Multi-select which model providers to enable. Today: any
//!    combination of openai / openai-responses / anthropic /
//!    google / codex / kimi / kimi-code.
//! 3. For each enabled provider: prompt for auth + pick a default
//!    model from the curated list.
//! 4. Pick which of the enabled providers handles "default-route"
//!    requests (no `provider` field, no model-prefix match).
//! 5. fs_root + tool toggles + persistence + memory + approval.
//!
//! Outputs:
//!
//! - `<config-dir>/config.json` — preferences (no secrets).
//! - `<config-dir>/auth/<provider>.json` — API key per provider,
//!   mode `0600` on unix.
//!
//! Anti-footgun: by default we refuse to overwrite an existing
//! `config.json`. Pass `--force` to opt in.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use dialoguer::{theme::ColorfulTheme, Confirm, Input, MultiSelect, Password, Select};

use crate::auth_store;
use crate::config::{
    ApprovalSection, Config, MemorySection, PersistenceSection, ProviderConfig, ServerSection,
    ToolsSection,
};
use crate::serve::default_jarvis_workspace_root;

/// Provider catalogue — ordered the way the wizard's MultiSelect
/// presents them. The description after `—` is what the user sees;
/// the leading id is what `jarvis serve` keys off.
const PROVIDERS: &[(&str, &str, &str)] = &[
    (
        "openai",
        "OpenAI Chat Completions (GA models)",
        "OpenAI 聊天补全 (GA 模型)",
    ),
    (
        "openai-responses",
        "OpenAI Responses API (reasoning + prompt cache)",
        "OpenAI Responses API (推理 + 缓存)",
    ),
    (
        "anthropic",
        "Anthropic Claude (Messages API)",
        "Anthropic Claude (Messages API)",
    ),
    ("google", "Google Gemini", "Google Gemini"),
    (
        "codex",
        "ChatGPT subscription via OAuth (flat-rate)",
        "ChatGPT 订阅 OAuth (包月)",
    ),
    (
        "kimi",
        "Moonshot Kimi platform (api.moonshot.cn, per-token)",
        "Moonshot 平台 (api.moonshot.cn, 按量计费)",
    ),
    (
        "kimi-code",
        "Kimi Code subscription (api.kimi.com, flat-rate)",
        "Kimi Code 订阅 (api.kimi.com, 包月)",
    ),
];

/// User-facing locale for wizard prompts. Persisted into
/// `config.json` so future tooling (web UI, re-prompts) can stay
/// in the same language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    Zh,
}

impl Locale {
    pub fn code(self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::Zh => "zh",
        }
    }

    fn from_code(code: &str) -> Self {
        match code {
            "zh" | "zh-CN" | "zh_CN" => Locale::Zh,
            _ => Locale::En,
        }
    }
}

/// Static localised string table. One method per prompt — keeps
/// translations colocated and lets the compiler catch missing
/// branches if a new prompt is added in only one locale.
struct Strings {
    locale: Locale,
}

impl Strings {
    fn new(locale: Locale) -> Self {
        Self { locale }
    }
    fn welcome(&self, path: &Path) -> String {
        match self.locale {
            Locale::En => format!(
                "Welcome to Jarvis. This wizard writes {} and credentials \
                 under the same directory.\n",
                path.display()
            ),
            Locale::Zh => format!(
                "欢迎使用 Jarvis。本向导会写入 {} 并把凭证保存在同一目录。\n",
                path.display()
            ),
        }
    }
    fn pick_language(&self) -> &'static str {
        // Always English+Chinese, regardless of current locale —
        // it's the very first prompt.
        "Choose interface language / 选择界面语言"
    }
    fn select_providers(&self) -> &'static str {
        match self.locale {
            Locale::En => "Select providers to enable (Space to toggle, Enter to confirm)",
            Locale::Zh => "选择要启用的 provider (空格切换，回车确认)",
        }
    }
    fn need_at_least_one_provider(&self) -> &'static str {
        match self.locale {
            Locale::En => "Pick at least one provider.",
            Locale::Zh => "至少选择一个 provider。",
        }
    }
    fn configuring(&self, name: &str) -> String {
        match self.locale {
            Locale::En => format!("\n=== Configuring {name} ==="),
            Locale::Zh => format!("\n=== 配置 {name} ==="),
        }
    }
    fn pick_default_model(&self) -> &'static str {
        match self.locale {
            Locale::En => "Default model",
            Locale::Zh => "默认模型",
        }
    }
    fn other_model_label(&self) -> &'static str {
        match self.locale {
            Locale::En => "Other (type a custom model name)",
            Locale::Zh => "其他 (手动输入模型名)",
        }
    }
    fn custom_model_prompt(&self) -> &'static str {
        match self.locale {
            Locale::En => "Custom model name",
            Locale::Zh => "自定义模型名",
        }
    }
    fn pick_default_provider(&self) -> &'static str {
        match self.locale {
            Locale::En => "Default provider (used when a request has no `provider` field)",
            Locale::Zh => "默认 provider (请求未指定 provider 时使用)",
        }
    }
    fn fs_root_prompt(&self) -> &'static str {
        match self.locale {
            Locale::En => "Workspace root for fs.* tools (cwd is fine for project-local agents)",
            Locale::Zh => "fs.* 工具的工作区根目录 (项目目录通常合适)",
        }
    }
    fn enable_fs_edit(&self) -> &'static str {
        match self.locale {
            Locale::En => "Enable fs.edit (precise string-replace on files in workspace)?",
            Locale::Zh => "启用 fs.edit (在工作区内做精确字符串替换)?",
        }
    }
    fn enable_shell(&self) -> &'static str {
        match self.locale {
            Locale::En => "Enable shell.exec (run commands inside workspace, no OS sandbox yet)?",
            Locale::Zh => "启用 shell.exec (在工作区内执行命令，暂无 OS 沙箱)?",
        }
    }
    fn persist_prompt(&self) -> &'static str {
        match self.locale {
            Locale::En => "Persist conversations across restarts?",
            Locale::Zh => "持久化对话(重启后保留)?",
        }
    }
    fn persist_help(&self, url: &str) -> String {
        match self.locale {
            Locale::En => format!(
                "  Using {url}\n  (Switch to sqlite / postgres / mysql later by editing \
                 persistence.url in config.json.)"
            ),
            Locale::Zh => format!(
                "  使用 {url}\n  (将来想换 sqlite / postgres / mysql，编辑 config.json 的 \
                 persistence.url 即可。)"
            ),
        }
    }
    fn memory_budget(&self) -> &'static str {
        match self.locale {
            Locale::En => "Memory budget in tokens (0 to disable)",
            Locale::Zh => "短期记忆 token 预算 (0 表示禁用)",
        }
    }
    fn memory_mode(&self) -> &'static str {
        match self.locale {
            Locale::En => "Memory mode",
            Locale::Zh => "记忆策略",
        }
    }
    fn memory_window(&self) -> &'static str {
        match self.locale {
            Locale::En => "window  — drop oldest turns when budget exceeded",
            Locale::Zh => "window  — 超预算时丢弃最早的对话回合",
        }
    }
    fn memory_summary(&self) -> &'static str {
        match self.locale {
            Locale::En => "summary — ask the LLM to summarise dropped turns (more LLM calls)",
            Locale::Zh => "summary — 让 LLM 汇总被丢弃的回合 (额外 LLM 调用)",
        }
    }
    fn approval_prompt(&self) -> &'static str {
        match self.locale {
            Locale::En => "Approval policy for write tools",
            Locale::Zh => "写工具的审批策略",
        }
    }
    fn approval_auto(&self) -> &'static str {
        match self.locale {
            Locale::En => "auto — always approve (audit-only via stream events)",
            Locale::Zh => "auto — 自动批准 (仅在事件流中记录)",
        }
    }
    fn approval_deny(&self) -> &'static str {
        match self.locale {
            Locale::En => "deny — always deny (WS clients can override interactively)",
            Locale::Zh => "deny — 默认拒绝 (WS 客户端可逐次交互覆盖)",
        }
    }
    fn enter_api_key(&self, env_var: &str) -> String {
        match self.locale {
            Locale::En => format!("Enter {env_var}"),
            Locale::Zh => format!("输入 {env_var}"),
        }
    }
    fn paste_hint(&self) -> &'static str {
        match self.locale {
            Locale::En => "  (paste then press Enter — input is shown to avoid IME issues)",
            Locale::Zh => "  (粘贴后回车；显示输入以避免输入法问题)",
        }
    }
    fn key_skipped(&self, env_var: &str) -> String {
        match self.locale {
            Locale::En => format!(
                "  (skipped — no key stored; set {env_var} or rerun \
                 `jarvis login --provider <name>` later)"
            ),
            Locale::Zh => format!(
                "  (跳过 — 没保存 key；之后 export {env_var} 或运行 \
                 `jarvis login --provider <name>` 再补)"
            ),
        }
    }
    fn key_already_in_env(&self, env_var: &str) -> String {
        match self.locale {
            Locale::En => format!(
                "{env_var} is already set in your environment — also save to disk? \
                 (Disk-stored values let `jarvis` start without env vars)"
            ),
            Locale::Zh => format!(
                "环境里已经有 {env_var} — 同时也保存到磁盘？\
                 (保存后 `jarvis` 启动时无需再 export)"
            ),
        }
    }
    fn wrote_config(&self, path: &Path) -> String {
        match self.locale {
            Locale::En => format!("\n✓ Wrote {}", path.display()),
            Locale::Zh => format!("\n✓ 已写入 {}", path.display()),
        }
    }
    fn run_jarvis(&self) -> &'static str {
        match self.locale {
            Locale::En => "\nRun `jarvis` to start the server.",
            Locale::Zh => "\n运行 `jarvis` 启动服务。",
        }
    }
}

/// Inputs the wizard collects from the user. Pure data — separable
/// from the IO so we can unit-test the build-config step without
/// touching stdin.
#[derive(Debug, Clone)]
pub struct InitAnswers {
    pub locale: Locale,
    pub providers: Vec<ProviderAnswer>,
    pub default_provider: String,
    pub fs_root: PathBuf,
    pub enable_fs_edit: bool,
    pub enable_shell_exec: bool,
    pub persist: Option<String>,
    pub memory: Option<MemoryAnswer>,
    pub approval: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderAnswer {
    pub name: String,
    pub default_model: String,
    /// Codex-only: the directory we'll read `auth.json` from.
    pub codex_home: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct MemoryAnswer {
    pub tokens: usize,
    pub mode: String, // "window" / "summary"
}

pub fn run(force: bool) -> Result<()> {
    let cfg_path = auth_store::config_file()?;
    if cfg_path.exists() && !force {
        bail!(
            "{} already exists.\n\
             Pass `--force` to overwrite, or edit the file directly.",
            cfg_path.display()
        );
    }

    let theme = ColorfulTheme::default();

    // ---- locale (always bilingual prompt) ----
    let locale_idx = Select::with_theme(&theme)
        .with_prompt(Strings::new(Locale::En).pick_language())
        .items(&["English", "中文"])
        .default(0)
        .interact()
        .context("language prompt")?;
    let locale = if locale_idx == 0 {
        Locale::En
    } else {
        Locale::Zh
    };
    let s = Strings::new(locale);

    eprintln!("{}", s.welcome(&cfg_path));

    // ---- multi-select providers ----
    let provider_labels: Vec<String> = PROVIDERS
        .iter()
        .map(|(id, en, zh)| {
            let desc = match locale {
                Locale::En => en,
                Locale::Zh => zh,
            };
            format!("{id:18} — {desc}")
        })
        .collect();
    let selected_indices = loop {
        let picks = MultiSelect::with_theme(&theme)
            .with_prompt(s.select_providers())
            .items(&provider_labels)
            .interact()
            .context("provider multi-select")?;
        if !picks.is_empty() {
            break picks;
        }
        eprintln!("  {}", s.need_at_least_one_provider());
    };

    // ---- per-provider auth + default model ----
    let mut providers: Vec<ProviderAnswer> = Vec::new();
    for idx in &selected_indices {
        let name = PROVIDERS[*idx].0.to_string();
        eprintln!("{}", s.configuring(&name));
        let codex_home = if let Some(env_var) = api_key_env_var(&name) {
            prompt_api_key(&theme, &s, &name, env_var)?;
            None
        } else if name == "codex" {
            Some(handle_codex_auth(&theme)?)
        } else {
            None
        };
        let default_model = pick_model(&theme, &s, &name)?;
        providers.push(ProviderAnswer {
            name,
            default_model,
            codex_home,
        });
    }

    // ---- pick default-route provider ----
    let default_provider = if providers.len() == 1 {
        providers[0].name.clone()
    } else {
        let labels: Vec<String> = providers
            .iter()
            .map(|p| format!("{} ({})", p.name, p.default_model))
            .collect();
        let idx = Select::with_theme(&theme)
            .with_prompt(s.pick_default_provider())
            .items(&labels)
            .default(0)
            .interact()
            .context("default provider prompt")?;
        providers[idx].name.clone()
    };

    // ---- fs_root ----
    let default_fs_root = default_jarvis_workspace_root();
    let fs_root_str: String = Input::with_theme(&theme)
        .with_prompt(s.fs_root_prompt())
        .default(default_fs_root.display().to_string())
        .interact_text()
        .context("fs_root prompt")?;
    let fs_root = PathBuf::from(fs_root_str);

    // ---- write tools ----
    let enable_fs_edit = Confirm::with_theme(&theme)
        .with_prompt(s.enable_fs_edit())
        .default(false)
        .interact()
        .context("fs.edit prompt")?;
    let enable_shell_exec = Confirm::with_theme(&theme)
        .with_prompt(s.enable_shell())
        .default(false)
        .interact()
        .context("shell.exec prompt")?;

    // ---- persistence ----
    let persist = if Confirm::with_theme(&theme)
        .with_prompt(s.persist_prompt())
        .default(true)
        .interact()
        .context("persist prompt")?
    {
        let default_url = default_persistence_url()?;
        eprintln!("{}", s.persist_help(&default_url));
        Some(default_url)
    } else {
        None
    };

    // ---- memory ----
    let memory_tokens: usize = Input::with_theme(&theme)
        .with_prompt(s.memory_budget())
        .default(8000usize)
        .interact_text()
        .context("memory budget prompt")?;
    let memory = if memory_tokens == 0 {
        None
    } else {
        let mode_idx = Select::with_theme(&theme)
            .with_prompt(s.memory_mode())
            .items(&[s.memory_window(), s.memory_summary()])
            .default(0)
            .interact()
            .context("memory mode prompt")?;
        let mode = if mode_idx == 0 { "window" } else { "summary" };
        Some(MemoryAnswer {
            tokens: memory_tokens,
            mode: mode.into(),
        })
    };

    // ---- approval ----
    let approval = if enable_fs_edit || enable_shell_exec {
        let idx = Select::with_theme(&theme)
            .with_prompt(s.approval_prompt())
            .items(&[s.approval_auto(), s.approval_deny()])
            .default(1) // deny by default when write tools are on
            .interact()
            .context("approval prompt")?;
        Some(if idx == 0 { "auto" } else { "deny" }.to_string())
    } else {
        None
    };

    let answers = InitAnswers {
        locale,
        providers,
        default_provider,
        fs_root,
        enable_fs_edit,
        enable_shell_exec,
        persist,
        memory,
        approval,
    };

    // ---- write ----
    let cfg = build_config(&answers);
    let json_text = cfg.to_json_string()?;
    write_config_file(&cfg_path, &json_text)?;

    eprintln!("{}", s.wrote_config(&cfg_path));
    for p in &answers.providers {
        if let Some(env_var) = api_key_env_var(&p.name) {
            if let Ok(path) = auth_store::auth_path(&p.name) {
                if path.is_file() {
                    eprintln!(
                        "✓ Stored {env_var} in {} (mode 0600 on unix)",
                        path.display()
                    );
                }
            }
        }
    }
    eprintln!("{}", s.run_jarvis());
    Ok(())
}

fn api_key_env_var(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" | "openai-responses" => Some("OPENAI_API_KEY"),
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "google" => Some("GOOGLE_API_KEY"),
        "kimi" | "moonshot" => Some("KIMI_API_KEY"),
        "kimi-code" => Some("KIMI_CODE_API_KEY"),
        _ => None,
    }
}

pub(crate) fn default_model_for(provider: &str) -> &'static str {
    match provider {
        "openai" | "openai-responses" => "gpt-4o-mini",
        "anthropic" => "claude-3-5-sonnet-latest",
        "google" => "gemini-1.5-flash",
        // Fast / cheap default for the ChatGPT-subscription Codex
        // path. Switch to `gpt-5.4` or `gpt-5.5` for harder problems.
        "codex" => "gpt-5.4-mini",
        // Latest Kimi K2 thinking model on the Moonshot CN platform.
        // `kimi-latest` would auto-route to whatever Moonshot picks as
        // the current flagship; pinning to a concrete id keeps
        // behaviour reproducible across upgrades.
        "kimi" | "moonshot" => "kimi-k2-thinking",
        // Kimi Code (flat-rate subscription) currently exposes one
        // model id; its display name is "Kimi-k2.6".
        "kimi-code" => "kimi-for-coding",
        _ => "gpt-4o-mini",
    }
}

/// Curated list of "you almost certainly want one of these" models per
/// provider, ordered by general suitability for coding/chat. The
/// first entry should always equal `default_model_for(provider)` so
/// "press enter on the picker" matches the documented default.
///
/// Empty for unknown providers — caller falls back to free-text input.
pub(crate) fn model_choices_for(provider: &str) -> &'static [&'static str] {
    match provider {
        "openai" => &[
            "gpt-4o-mini", // default — fast, cheap, good for tools
            "gpt-4o",
            "gpt-4-turbo",
            "gpt-3.5-turbo",
        ],
        "openai-responses" => &[
            "gpt-4o-mini", // default
            "o3-mini",     // reasoning, light
            "o3",          // reasoning, full
            "o1-mini",
            "o1",
        ],
        "anthropic" => &[
            "claude-3-5-sonnet-latest", // default — best balance
            "claude-3-5-haiku-latest",  // cheap + fast
            "claude-3-opus-latest",     // strongest
        ],
        "google" => &[
            "gemini-1.5-flash", // default
            "gemini-1.5-pro",
            "gemini-2.0-flash",
        ],
        // Models exposed on the ChatGPT-subscription Codex endpoint.
        // The list and the default need to match what the backend
        // actually accepts — the API-key path on api.openai.com has
        // a different (and broader) lineup.
        "codex" => &[
            "gpt-5.4-mini",  // default — small, fast, cheap; simple coding tasks
            "gpt-5.4",       // strong daily coding
            "gpt-5.5",       // strongest general; complex projects, research
            "gpt-5.3-codex", // coding-tuned older
            "gpt-5.2",       // long-running agent / professional work
        ],
        // Moonshot Kimi lineup — IDs as accepted by api.moonshot.cn.
        // The `kimi-k2-*` family is the flagship thinking model
        // generation; `moonshot-v1-*` are the older context-sized
        // variants; `kimi-latest` auto-routes to whatever Moonshot
        // currently exposes as their flagship.
        "kimi" | "moonshot" => &[
            "kimi-k2-thinking",      // default — latest K2 thinking
            "kimi-k2-turbo-preview", // turbo / cheaper K2
            "kimi-k2-0905-preview",  // pinned September 2025 K2 release
            "kimi-latest",           // auto-routes to current flagship
            "moonshot-v1-auto",      // legacy v1, auto-pick context size
            "moonshot-v1-128k",      // legacy v1, long context
            "moonshot-v1-32k",
            "moonshot-v1-8k",
        ],
        // Kimi Code subscription endpoint exposes one canonical
        // model id; treat the curated list as a single entry so
        // pickers don't pretend there's a choice. Its display
        // name on the kimi.com console is "Kimi-k2.6".
        "kimi-code" => &["kimi-for-coding"],
        _ => &[],
    }
}

fn pick_model(theme: &ColorfulTheme, s: &Strings, provider: &str) -> Result<String> {
    let default_model = default_model_for(provider);
    let choices = model_choices_for(provider);
    if choices.is_empty() {
        // Unknown provider — free-text fallback.
        return Input::with_theme(theme)
            .with_prompt(s.pick_default_model())
            .default(default_model.into())
            .interact_text()
            .context("model prompt");
    }
    let mut labels: Vec<String> = choices.iter().map(|m| (*m).to_string()).collect();
    let other_idx = labels.len();
    labels.push(s.other_model_label().to_string());

    let default_idx = choices
        .iter()
        .position(|m| *m == default_model)
        .unwrap_or(0);

    let idx = Select::with_theme(theme)
        .with_prompt(s.pick_default_model())
        .items(&labels)
        .default(default_idx)
        .interact()
        .context("model select")?;

    if idx == other_idx {
        Input::with_theme(theme)
            .with_prompt(s.custom_model_prompt())
            .default(default_model.into())
            .interact_text()
            .context("custom model prompt")
    } else {
        Ok(choices[idx].to_string())
    }
}

fn prompt_api_key(theme: &ColorfulTheme, s: &Strings, provider: &str, env_var: &str) -> Result<()> {
    // If the env var is already set, offer to also persist it.
    if let Ok(existing) = std::env::var(env_var) {
        let store = Confirm::with_theme(theme)
            .with_prompt(s.key_already_in_env(env_var))
            .default(false)
            .interact()
            .context("api key carry-over prompt")?;
        if store {
            auth_store::save_api_key(provider, &existing)?;
        }
        return Ok(());
    }
    eprintln!("{}", s.paste_hint());
    // Visible Input rather than hidden Password — paste / IME is
    // unreliable in many terminals when the input doesn't echo.
    let key: String = Input::with_theme(theme)
        .with_prompt(s.enter_api_key(env_var))
        .allow_empty(true)
        .interact_text()
        .or_else(|_| {
            Password::with_theme(theme)
                .with_prompt(s.enter_api_key(env_var))
                .allow_empty_password(true)
                .interact()
                .context("api key prompt")
        })?;
    let key = key.trim().to_string();
    if key.is_empty() {
        eprintln!("{}", s.key_skipped(env_var));
    } else {
        auth_store::save_api_key(provider, &key)?;
    }
    Ok(())
}

fn handle_codex_auth(_theme: &ColorfulTheme) -> Result<PathBuf> {
    // PR 2 only: detect the existing Codex CLI auth.json. PR 3
    // adds our own PKCE flow that bypasses the Codex CLI.
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")))
        .ok_or_else(|| anyhow!("can't locate $HOME — set CODEX_HOME explicitly"))?;
    let auth_json = codex_home.join("auth.json");
    if auth_json.is_file() {
        eprintln!(
            "  ✓ found existing Codex credentials at {}",
            auth_json.display()
        );
        eprintln!(
            "    (To re-authenticate: run `codex login`. \
             Native `jarvis login` lands in a future release.)"
        );
    } else {
        eprintln!("  ⚠ no Codex credentials found at {}.", auth_json.display());
        eprintln!("    Run `codex login` (from the OpenAI Codex CLI) before starting jarvis.");
    }
    Ok(codex_home)
}

/// Default persistence target — a directory of JSON files under the
/// XDG data home. JSON store has no external deps and the layout is
/// human-inspectable (`cat conversations/<id>.json`), so it's the
/// right default for "I just want it to work".
fn default_persistence_url() -> Result<String> {
    let dir = data_dir()?;
    let convos = dir.join("conversations");
    Ok(format!("json://{}", convos.display()))
}

fn data_dir() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("JARVIS_DATA_HOME") {
        return Ok(PathBuf::from(p));
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        return Ok(PathBuf::from(xdg).join("jarvis"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(PathBuf::from(home).join(".local/share/jarvis"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return Ok(PathBuf::from(appdata).join("jarvis"));
    }
    anyhow::bail!("can't locate a data home (set HOME or JARVIS_DATA_HOME)")
}

/// Pure: turn the answers into a `Config` struct. Tested standalone.
pub fn build_config(a: &InitAnswers) -> Config {
    let mut providers = std::collections::BTreeMap::new();
    for p in &a.providers {
        let models = model_choices_for(&p.name)
            .iter()
            .map(|s| (*s).to_string())
            .collect::<Vec<_>>();
        let mut entry = ProviderConfig {
            enabled: true,
            default_model: Some(p.default_model.clone()),
            models,
            ..ProviderConfig::default()
        };
        if p.name == "codex" {
            entry.home = p.codex_home.clone();
        }
        providers.insert(p.name.clone(), entry);
    }

    let tools = ToolsSection {
        fs_root: Some(a.fs_root.clone()),
        enable_fs_edit: Some(a.enable_fs_edit),
        enable_shell_exec: Some(a.enable_shell_exec),
        ..ToolsSection::default()
    };

    let memory = match &a.memory {
        Some(m) => MemorySection {
            tokens: Some(m.tokens),
            mode: Some(m.mode.clone()),
            model: None,
            ..MemorySection::default()
        },
        None => MemorySection::default(),
    };

    let persistence = match &a.persist {
        Some(url) => PersistenceSection {
            url: Some(url.clone()),
        },
        None => PersistenceSection::default(),
    };

    let approval = match &a.approval {
        Some(mode) => ApprovalSection {
            mode: Some(mode.clone()),
        },
        None => ApprovalSection::default(),
    };

    Config {
        server: ServerSection::default(),
        language: Some(a.locale.code().into()),
        default_provider: Some(a.default_provider.clone()),
        providers,
        agent: Default::default(),
        tools,
        memory,
        persistence,
        approval,
        mcp_servers: Default::default(),
    }
}

/// Read the persisted locale from a loaded `Config`. Falls back to
/// English when unset or unrecognised — call sites use this for
/// re-prompts (e.g. `jarvis login` could reuse the user's wizard
/// language). Today only `init.rs` reads it, but it lives at the
/// crate root so consumers don't need init's internals.
#[allow(dead_code)]
pub(crate) fn locale_from_config(cfg: &Config) -> Locale {
    cfg.language
        .as_deref()
        .map(Locale::from_code)
        .unwrap_or(Locale::En)
}

fn write_config_file(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("rename onto {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answers_for_codex() -> InitAnswers {
        InitAnswers {
            locale: Locale::En,
            providers: vec![ProviderAnswer {
                name: "codex".into(),
                default_model: "gpt-5-codex-mini".into(),
                codex_home: Some(PathBuf::from("/Users/me/.codex")),
            }],
            default_provider: "codex".into(),
            fs_root: PathBuf::from("/work"),
            enable_fs_edit: true,
            enable_shell_exec: false,
            persist: Some("sqlite://./db.sqlite".into()),
            memory: Some(MemoryAnswer {
                tokens: 8000,
                mode: "summary".into(),
            }),
            approval: Some("deny".into()),
        }
    }

    fn answers_for_openai() -> InitAnswers {
        InitAnswers {
            locale: Locale::En,
            providers: vec![ProviderAnswer {
                name: "openai".into(),
                default_model: "gpt-4o-mini".into(),
                codex_home: None,
            }],
            default_provider: "openai".into(),
            fs_root: PathBuf::from("/work"),
            enable_fs_edit: false,
            enable_shell_exec: false,
            persist: None,
            memory: None,
            approval: None,
        }
    }

    fn answers_multi_provider() -> InitAnswers {
        InitAnswers {
            locale: Locale::Zh,
            providers: vec![
                ProviderAnswer {
                    name: "kimi-code".into(),
                    default_model: "kimi-for-coding".into(),
                    codex_home: None,
                },
                ProviderAnswer {
                    name: "openai".into(),
                    default_model: "gpt-4o-mini".into(),
                    codex_home: None,
                },
            ],
            default_provider: "kimi-code".into(),
            fs_root: PathBuf::from("/work"),
            enable_fs_edit: false,
            enable_shell_exec: false,
            persist: None,
            memory: None,
            approval: None,
        }
    }

    #[test]
    fn build_config_codex_populates_codex_section() {
        let cfg = build_config(&answers_for_codex());
        assert_eq!(cfg.default_provider.as_deref(), Some("codex"));
        assert_eq!(cfg.language.as_deref(), Some("en"));
        let codex = cfg.providers.get("codex").expect("codex section present");
        assert!(codex.enabled);
        assert_eq!(codex.default_model.as_deref(), Some("gpt-5-codex-mini"));
        assert_eq!(codex.home.as_deref(), Some(Path::new("/Users/me/.codex")));
        assert!(!codex.models.is_empty(), "models list should be seeded");
        // Only the chosen provider gets a section — others are absent.
        assert!(!cfg.providers.contains_key("openai"));
        assert!(!cfg.providers.contains_key("anthropic"));
        assert_eq!(cfg.tools.enable_fs_edit, Some(true));
        assert_eq!(cfg.tools.enable_shell_exec, Some(false));
        assert_eq!(cfg.memory.tokens, Some(8000));
        assert_eq!(cfg.memory.mode.as_deref(), Some("summary"));
        assert_eq!(cfg.persistence.url.as_deref(), Some("sqlite://./db.sqlite"));
        assert_eq!(cfg.approval.mode.as_deref(), Some("deny"));
    }

    #[test]
    fn build_config_openai_minimal_skips_optionals() {
        let cfg = build_config(&answers_for_openai());
        let text = cfg.to_json_string().unwrap();
        assert!(text.contains("\"openai\""), "got:\n{text}");
        assert!(!text.contains("\"memory\""), "got:\n{text}");
        assert!(!text.contains("\"persistence\""), "got:\n{text}");
        assert!(!text.contains("\"approval\""), "got:\n{text}");
        assert!(!text.contains("\"codex\""), "got:\n{text}");
    }

    #[test]
    fn build_config_multi_provider_enables_each_and_picks_default() {
        let cfg = build_config(&answers_multi_provider());
        assert_eq!(cfg.default_provider.as_deref(), Some("kimi-code"));
        assert_eq!(cfg.language.as_deref(), Some("zh"));
        let kimi_code = cfg.providers.get("kimi-code").unwrap();
        assert!(kimi_code.enabled);
        assert_eq!(kimi_code.default_model.as_deref(), Some("kimi-for-coding"));
        let openai = cfg.providers.get("openai").unwrap();
        assert!(openai.enabled);
        assert_eq!(openai.default_model.as_deref(), Some("gpt-4o-mini"));
    }

    #[test]
    fn locale_round_trip_through_config() {
        let cfg = build_config(&answers_multi_provider());
        assert_eq!(locale_from_config(&cfg), Locale::Zh);
        let mut other = cfg.clone();
        other.language = None;
        assert_eq!(locale_from_config(&other), Locale::En);
    }

    #[test]
    fn model_choices_first_entry_matches_default() {
        // The contract: when the picker opens, "press enter" should
        // pick the same model the user would have had as the
        // free-text default.
        for provider in [
            "openai",
            "openai-responses",
            "anthropic",
            "google",
            "codex",
            "kimi",
            "kimi-code",
        ] {
            let choices = model_choices_for(provider);
            assert!(
                !choices.is_empty(),
                "expected curated list for {provider}, got empty"
            );
            assert!(
                choices.contains(&default_model_for(provider)),
                "default_model_for({provider}) = {} but choices = {:?}",
                default_model_for(provider),
                choices,
            );
        }
    }

    #[test]
    fn model_choices_for_unknown_provider_is_empty() {
        // Caller falls back to free-text input.
        assert!(model_choices_for("nonexistent").is_empty());
    }

    #[test]
    fn round_trip_through_disk() {
        // build_config → to_json_string → write → load_from_path
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");

        let cfg = build_config(&answers_for_codex());
        let text = cfg.to_json_string().unwrap();
        write_config_file(&path, &text).unwrap();

        let parsed = Config::load_from_path(&path).unwrap();
        assert_eq!(cfg, parsed);
    }
}

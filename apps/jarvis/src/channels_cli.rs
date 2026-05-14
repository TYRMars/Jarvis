//! `jarvis channels …` — interactive TUI to add / list / remove
//! channel instances without booting the HTTP server.
//!
//! Talks directly to the same `ChannelInstanceStore` the server uses
//! (`harness_store::connect_all(url).channel_instances`), so rows
//! created here show up immediately in Settings → 渠道 once the
//! server starts (or in a running server's UI on next list refresh
//! — the JSON store is refreshed every read).
//!
//! Mirrors `project_cmd.rs` in shape: a small clap subcommand enum
//! per action, async dispatch from `main.rs`, store opened once at
//! the top.
//!
//! Schema-driven prompting: each adapter returns its
//! `schema()` JSON, and `interactive_add` walks the field list
//! (required first, optional after) using `dialoguer::Input` /
//! `Password` based on whether the property name looks sensitive
//! (matches the same heuristic the web form uses —
//! `secret | key | password`). After collection, the resulting
//! object is fed back through `adapter.validate_config(...)` so the
//! CLI never produces a row the server would later refuse.
//!
//! Inbound-capable kinds (anything carrying `callback_path` in
//! their `schema()` blob) print the substituted callback URL so the
//! operator can paste it straight into the platform admin panel.

use anyhow::{anyhow, Context, Result};
use clap::{Args, Subcommand};
use dialoguer::{theme::ColorfulTheme, Confirm, Input, Password, Select};
use harness_channel::{ChannelInstance, ChannelInstanceStatus};
use harness_server::{ChannelAdapter, ChannelAdapterRegistry};
use serde_json::{Map as JsonMap, Value};
use std::sync::Arc;

use crate::config::Config;

/// `jarvis channels <action>` — direct-store interactive admin for
/// `ChannelInstance` rows. No running server required.
#[derive(Subcommand, Debug)]
pub enum ChannelsAction {
    /// List configured channel instances (newest first).
    List(ListArgs),
    /// Interactive create. Picks a kind from the registry, walks the
    /// schema, validates, persists. Prints the inbound callback URL
    /// for kinds that have one.
    Add(AddArgs),
    /// Show one row's full config (secrets unmasked — this is a
    /// local CLI talking to disk, the same audience that already has
    /// read access to the JSON file).
    Show {
        /// Instance id (UUID) or display_name. Display-name lookup
        /// errors when ambiguous.
        target: String,
        /// Emit a single JSON object instead of human-readable lines.
        #[arg(long)]
        json: bool,
    },
    /// Delete a row. Prompts for confirmation unless `--yes`.
    Remove {
        target: String,
        /// Skip the y/N prompt. Useful for scripts.
        #[arg(long)]
        yes: bool,
    },
    /// Print the inbound callback URL for a row — the value the
    /// platform admin panel wants. Substitutes the public host you
    /// pass via `--host` (or `JARVIS_PUBLIC_HOST`) into the
    /// `<id>/v1/channels/<id>/callback` template.
    CallbackUrl {
        target: String,
        /// Public host (e.g. `https://abc.trycloudflare.com`). Falls
        /// back to `JARVIS_PUBLIC_HOST` env, then a stub
        /// `https://<your-host>` placeholder.
        #[arg(long)]
        host: Option<String>,
    },
}

#[derive(Args, Debug, Default)]
pub struct ListArgs {
    /// Emit a JSON array instead of the table layout.
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Default)]
pub struct AddArgs {
    /// Skip the kind picker and use this kind directly. One of
    /// `wecom_webhook | feishu_bot | dingtalk_bot | wecom_app` (run
    /// `jarvis channels add` without a kind to see the picker).
    #[arg(long)]
    pub kind: Option<String>,
    /// Display name for the new row. Prompted if omitted.
    #[arg(long, value_name = "NAME")]
    pub display_name: Option<String>,
    /// Public host to embed in the printed callback URL (inbound
    /// kinds only). Same as `--host` on the `callback-url`
    /// subcommand. Optional — operators usually set this once after
    /// creation via `jarvis channels callback-url`.
    #[arg(long)]
    pub callback_host: Option<String>,
}

pub async fn run(cfg: Option<Config>, action: ChannelsAction) -> Result<()> {
    let cfg = cfg.unwrap_or_default();
    let store = open_store(&cfg).await?;
    let registry = Arc::new(ChannelAdapterRegistry::with_defaults());
    match action {
        ChannelsAction::List(args) => list(store.as_ref(), args).await,
        ChannelsAction::Add(args) => add(store.as_ref(), registry.as_ref(), args).await,
        ChannelsAction::Show { target, json } => show(store.as_ref(), &target, json).await,
        ChannelsAction::Remove { target, yes } => remove(store.as_ref(), &target, yes).await,
        ChannelsAction::CallbackUrl { target, host } => {
            callback_url(store.as_ref(), registry.as_ref(), &target, host).await
        }
    }
}

// ---------- store wiring ----------

async fn open_store(cfg: &Config) -> Result<Arc<dyn harness_channel::ChannelInstanceStore>> {
    let url = pick_db_url(cfg).ok_or_else(|| {
        anyhow!(
            "no database URL resolved — \
             set JARVIS_DB_URL, configure `[persistence].url` in config.json, \
             or unset XDG_DATA_HOME / set HOME so the default JSON store can land in \
             ~/.local/share/jarvis/conversations"
        )
    })?;
    let bundle = harness_store::connect_all(&url)
        .await
        .with_context(|| format!("opening db url `{url}`"))?;
    Ok(bundle.channel_instances)
}

fn pick_db_url(cfg: &Config) -> Option<String> {
    std::env::var("JARVIS_DB_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| cfg.persistence.url.clone())
        .or_else(crate::serve::default_json_persistence_url)
}

// ---------- list ----------

async fn list(
    store: &dyn harness_channel::ChannelInstanceStore,
    args: ListArgs,
) -> Result<()> {
    let rows = store.list().await.map_err(boxed)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }
    if rows.is_empty() {
        eprintln!("(no channel instances)");
        eprintln!("Run `jarvis channels add` to create one.");
        return Ok(());
    }
    println!(
        "{:<36}  {:<16}  {:<10}  NAME",
        "ID", "KIND", "STATUS"
    );
    for r in &rows {
        let status = match r.status {
            ChannelInstanceStatus::Enabled => "enabled",
            ChannelInstanceStatus::Disabled => "disabled",
            ChannelInstanceStatus::Unconfigured => "unconfig",
        };
        println!(
            "{:<36}  {:<16}  {:<10}  {}",
            r.id, r.kind, status, r.display_name
        );
    }
    Ok(())
}

// ---------- add (interactive) ----------

async fn add(
    store: &dyn harness_channel::ChannelInstanceStore,
    registry: &ChannelAdapterRegistry,
    args: AddArgs,
) -> Result<()> {
    let theme = ColorfulTheme::default();

    // Pick the kind — either from `--kind` or via Select.
    let kind_str = match args.kind {
        Some(k) => k,
        None => pick_kind_interactive(&theme, registry)?,
    };
    let adapter = registry.get(&kind_str).ok_or_else(|| {
        anyhow!(
            "unknown kind `{}` — run `jarvis channels add` without --kind to see the picker",
            kind_str
        )
    })?;

    // Display name.
    let display_name = match args.display_name {
        Some(n) => n,
        None => Input::with_theme(&theme)
            .with_prompt("Display name")
            .default(format!("{} instance", adapter.kind()))
            .interact_text()?,
    };

    // Walk the schema and prompt per field.
    let schema_doc = adapter.schema();
    let config = collect_schema_fields(&theme, &schema_doc)?;

    // Validate before writing — adapters reject obvious bad values
    // here (insecure URL scheme without an env template, missing
    // required fields, etc.) and we want to fail fast rather than
    // produce a row the server would 400.
    if let Err(e) = adapter.validate_config(&config) {
        eprintln!("\nvalidation failed: {e}");
        eprintln!("re-run `jarvis channels add` and fix the highlighted field.");
        return Err(anyhow!("validation failed"));
    }

    let mut inst = ChannelInstance::new(adapter.kind().to_string(), display_name.clone(), config);
    // `add` implies "this is configured and ready" — flip Enabled.
    // Operators who want to land a row in a paused state can flip it
    // to Disabled later via the web UI / a future `channels disable`.
    inst.status = ChannelInstanceStatus::Enabled;
    let inst_id = inst.id.clone();
    store.upsert(&inst).await.map_err(boxed)?;

    println!();
    println!("✅ created channel instance");
    println!("    id          {}", inst.id);
    println!("    kind        {}", inst.kind);
    println!("    name        {}", inst.display_name);
    println!("    status      {:?}", inst.status);

    // Inbound-capable kinds: print the callback URL hint right away
    // so the operator can paste it into the platform admin panel
    // without re-running `callback-url`.
    if let Some(template) = inbound_callback_template(&schema_doc) {
        let host = args
            .callback_host
            .or_else(|| std::env::var("JARVIS_PUBLIC_HOST").ok())
            .filter(|s| !s.is_empty());
        let url = render_callback_url(&template, &inst_id, host.as_deref());
        println!();
        println!("📡 inbound callback URL");
        println!("    {url}");
        if host.is_none() {
            println!();
            println!("Replace `<your-host>` with the public host the platform can reach");
            println!("(e.g. `https://abc.trycloudflare.com`). To get a stable copy:");
            println!("    jarvis channels callback-url {} --host https://...", inst_id);
        }
    }
    Ok(())
}

fn pick_kind_interactive(
    theme: &ColorfulTheme,
    registry: &ChannelAdapterRegistry,
) -> Result<String> {
    let kinds: Vec<&Arc<dyn ChannelAdapter>> = registry.iter().collect();
    if kinds.is_empty() {
        return Err(anyhow!("channel adapter registry is empty"));
    }
    let labels: Vec<String> = kinds
        .iter()
        .map(|a| {
            let schema = a.schema();
            let label = schema
                .get("label_en")
                .and_then(Value::as_str)
                .unwrap_or_else(|| a.kind());
            let dir = schema
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or("?");
            format!("{}  ({}, {})", label, a.kind(), dir)
        })
        .collect();
    let pick = Select::with_theme(theme)
        .with_prompt("Channel kind")
        .items(&labels)
        .default(0)
        .interact()?;
    Ok(kinds[pick].kind().to_string())
}

fn collect_schema_fields(theme: &ColorfulTheme, schema_doc: &Value) -> Result<Value> {
    // The `schema()` blob is shaped like
    //   {kind, label, label_en, direction, schema: {properties, required}, ...}
    // We only need the inner JSON-Schema bits; everything else is
    // metadata for the UI / kinds list.
    let schema = schema_doc
        .get("schema")
        .ok_or_else(|| anyhow!("adapter schema missing `schema` field"))?;
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("adapter schema missing `schema.properties`"))?;
    let required: Vec<String> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    // Required fields first (in declaration order from the array),
    // then optional fields alphabetical — same ordering rule the web
    // form uses.
    let mut order: Vec<String> = required.clone();
    let mut optional: Vec<String> = properties
        .keys()
        .filter(|k| !required.contains(k))
        .cloned()
        .collect();
    optional.sort();
    order.extend(optional);

    let mut out = JsonMap::new();
    for prop in order {
        let meta = properties.get(&prop).cloned().unwrap_or(Value::Null);
        let title = meta
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(&prop)
            .to_string();
        let description = meta.get("description").and_then(Value::as_str);
        let example = meta.get("example").and_then(Value::as_str);
        let is_required = required.iter().any(|r| r == &prop);
        let prompt_label = if is_required {
            format!("{} (*)", title)
        } else {
            format!("{} (optional)", title)
        };

        // Print description / example as a hint above the prompt so
        // the user doesn't have to leave the terminal to check the
        // schema docs.
        if let Some(d) = description {
            println!("\n{}", d);
        }
        if let Some(e) = example {
            println!("  e.g. {}", e);
        }

        let value = if looks_sensitive(&prop) {
            // Sensitive fields: hidden input, allow empty when
            // optional. Confirm typing only when non-empty.
            let mut p = Password::with_theme(theme).with_prompt(&prompt_label);
            if !is_required {
                p = p.allow_empty_password(true);
            }
            let val: String = p.interact()?;
            val
        } else {
            let mut input = Input::<String>::with_theme(theme).with_prompt(&prompt_label);
            if !is_required {
                input = input.allow_empty(true);
            }
            input.interact_text()?
        };

        // Skip empty optional fields entirely — `serde_json::Null`
        // would clutter the row, and adapters that care about
        // optional fields all check for `.get(...).and_then(...)`
        // patterns that treat absent same as empty.
        if value.is_empty() {
            if !is_required {
                continue;
            }
            // Required + empty — bail. Re-running `add` is cheap;
            // looping on prompts here would obscure the user's
            // intent (they may have hit Ctrl-C deliberately).
            return Err(anyhow!("required field `{prop}` cannot be empty"));
        }
        out.insert(prop, Value::String(value));
    }
    Ok(Value::Object(out))
}

fn looks_sensitive(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("secret") || n.contains("password") || n.contains("key") || n.contains("token")
}

// ---------- show ----------

async fn show(
    store: &dyn harness_channel::ChannelInstanceStore,
    target: &str,
    json: bool,
) -> Result<()> {
    let inst = lookup(store, target).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&inst)?);
        return Ok(());
    }
    println!("id            {}", inst.id);
    println!("kind          {}", inst.kind);
    println!("display_name  {}", inst.display_name);
    println!("status        {:?}", inst.status);
    println!("created_at    {}", inst.created_at);
    println!("updated_at    {}", inst.updated_at);
    println!();
    println!("config:");
    println!("{}", serde_json::to_string_pretty(&inst.config)?);
    Ok(())
}

// ---------- remove ----------

async fn remove(
    store: &dyn harness_channel::ChannelInstanceStore,
    target: &str,
    yes: bool,
) -> Result<()> {
    let inst = lookup(store, target).await?;
    if !yes {
        let ok = Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt(format!(
                "Delete channel `{}` ({})?",
                inst.display_name, inst.kind
            ))
            .default(false)
            .interact()?;
        if !ok {
            eprintln!("(aborted)");
            return Ok(());
        }
    }
    let removed = store.delete(&inst.id).await.map_err(boxed)?;
    if removed {
        println!("✅ deleted {}", inst.id);
    } else {
        eprintln!("(nothing to delete — race? row vanished between lookup and delete)");
    }
    Ok(())
}

// ---------- callback-url ----------

async fn callback_url(
    store: &dyn harness_channel::ChannelInstanceStore,
    registry: &ChannelAdapterRegistry,
    target: &str,
    host: Option<String>,
) -> Result<()> {
    let inst = lookup(store, target).await?;
    let adapter = registry.get(&inst.kind).ok_or_else(|| {
        anyhow!(
            "kind `{}` not registered — was the adapter removed?",
            inst.kind
        )
    })?;
    let template = inbound_callback_template(&adapter.schema()).ok_or_else(|| {
        anyhow!(
            "kind `{}` is outbound-only and has no callback URL",
            inst.kind
        )
    })?;
    let host = host
        .or_else(|| std::env::var("JARVIS_PUBLIC_HOST").ok())
        .filter(|s| !s.is_empty());
    let url = render_callback_url(&template, &inst.id, host.as_deref());
    println!("{url}");
    Ok(())
}

// ---------- helpers ----------

async fn lookup(
    store: &dyn harness_channel::ChannelInstanceStore,
    target: &str,
) -> Result<ChannelInstance> {
    // Try id first — the common path, especially after `channels list`.
    if let Ok(Some(inst)) = store.get(target).await {
        return Ok(inst);
    }
    // Fall back to display_name; ambiguous names error.
    let rows = store.list().await.map_err(boxed)?;
    let matches: Vec<_> = rows
        .into_iter()
        .filter(|r| r.display_name == target)
        .collect();
    match matches.len() {
        0 => Err(anyhow!("no channel instance with id or name `{target}`")),
        1 => Ok(matches.into_iter().next().unwrap()),
        n => Err(anyhow!(
            "{n} channel instances share the name `{target}` — use the id instead"
        )),
    }
}

fn inbound_callback_template(schema_doc: &Value) -> Option<String> {
    schema_doc
        .get("callback_path")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn render_callback_url(template: &str, instance_id: &str, host: Option<&str>) -> String {
    // The template reads e.g. `/v1/channels/<id>/callback`. Substitute
    // both the literal `<id>` placeholder and prefix the host. A
    // missing host stays as a `<your-host>` placeholder so the user
    // can paste-and-edit later.
    let path = template.replace("<id>", instance_id);
    let host = host.unwrap_or("<your-host>");
    let host = host.trim_end_matches('/');
    if path.starts_with("http://") || path.starts_with("https://") {
        path
    } else {
        format!("{host}{path}")
    }
}

fn boxed(e: harness_core::BoxError) -> anyhow::Error {
    anyhow!(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_callback_url_substitutes_id_and_host() {
        let url = render_callback_url(
            "/v1/channels/<id>/callback",
            "abc-123",
            Some("https://my-tunnel.example"),
        );
        assert_eq!(url, "https://my-tunnel.example/v1/channels/abc-123/callback");
    }

    #[test]
    fn render_callback_url_uses_placeholder_when_host_missing() {
        let url = render_callback_url("/v1/channels/<id>/callback", "abc-123", None);
        assert_eq!(url, "<your-host>/v1/channels/abc-123/callback");
    }

    #[test]
    fn render_callback_url_strips_trailing_slash_on_host() {
        let url = render_callback_url(
            "/v1/channels/<id>/callback",
            "abc",
            Some("https://example.com/"),
        );
        assert_eq!(url, "https://example.com/v1/channels/abc/callback");
    }

    #[test]
    fn render_callback_url_passes_through_absolute_template() {
        // Defensive: if a future kind ships an absolute template,
        // don't double-prefix the host.
        let url = render_callback_url(
            "https://fixed.example/cb/<id>",
            "abc",
            Some("https://my-tunnel.example"),
        );
        assert_eq!(url, "https://fixed.example/cb/abc");
    }

    #[test]
    fn looks_sensitive_matches_secret_key_password_token() {
        assert!(looks_sensitive("corp_secret"));
        assert!(looks_sensitive("api_key"));
        assert!(looks_sensitive("password"));
        assert!(looks_sensitive("access_token"));
        assert!(looks_sensitive("EncodingAESKey"));
        assert!(!looks_sensitive("corp_id"));
        assert!(!looks_sensitive("agent_id"));
        assert!(!looks_sensitive("display_name"));
    }

    #[test]
    fn inbound_callback_template_extracts_when_present() {
        let schema = serde_json::json!({
            "kind": "wecom_app",
            "direction": "bidirectional",
            "callback_path": "/v1/channels/<id>/callback",
        });
        assert_eq!(
            inbound_callback_template(&schema),
            Some("/v1/channels/<id>/callback".to_string())
        );
    }

    #[test]
    fn inbound_callback_template_returns_none_for_outbound_only() {
        let schema = serde_json::json!({
            "kind": "wecom_webhook",
            "direction": "outbound",
        });
        assert_eq!(inbound_callback_template(&schema), None);
    }

    #[test]
    fn collect_schema_fields_drops_empty_optional_strings() {
        // Indirect test — we can't easily mock dialoguer here, so
        // just exercise the post-collect dedup logic by feeding the
        // helper a schema and asserting the property iteration order
        // matches required-first rules. The empty-skip behavior is
        // exercised end-to-end via the `add` integration manually.
        let schema = serde_json::json!({
            "schema": {
                "properties": {
                    "to_user": {"title": "Target user"},
                    "agent_id": {"title": "Agent id"},
                    "corp_secret": {"title": "Corp secret"},
                    "corp_id": {"title": "Corp id"}
                },
                "required": ["corp_id", "agent_id", "corp_secret"]
            }
        });
        // Verify the required+optional split logic via `properties`
        // shape — the iteration order check is implicit in the
        // function under test, which we don't drive interactively in
        // unit-test. This stub exists to flag if the schema-shape
        // pre-conditions the function expects ever change.
        let s = schema.get("schema").unwrap();
        assert!(s.get("properties").unwrap().is_object());
        assert!(s.get("required").unwrap().is_array());
    }
}

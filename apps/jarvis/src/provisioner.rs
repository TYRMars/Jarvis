//! `apps/jarvis` impl of [`harness_server::ProviderAdmin`] — wires
//! the runtime registry, on-disk `config.json`, and per-provider
//! `auth_store` together so the Web UI's Settings → Providers panel
//! can do everything the CLI's `init` / `login` / config-file editing
//! can do, without restarting the server.
//!
//! Workflow for `provision` (create or replace):
//!
//! 1. Validate the wire shape (no blank `name`, no whitespace, etc.).
//! 2. If `allow_overwrite` is false and the registry already has the
//!    name, return `AlreadyExists` so `POST` is honest about
//!    duplicates (`PATCH` passes `true` to skip this gate).
//! 3. If the caller supplied an api_key, write it to
//!    `~/.config/jarvis/auth/<name>.json` BEFORE construction so the
//!    `resolve_api_key` lookup path inside `build_provider` finds it.
//!    A wrong key here means construction succeeds but the first
//!    real request fails — that's the same UX as boot today.
//! 4. Synthesise a temporary `Config` with the new `ProviderConfig`
//!    merged into the existing on-disk file, then call
//!    [`crate::serve::build_provider`] against it. On error map to
//!    `Construction`.
//! 5. Insert the freshly-built `Arc<dyn LlmProvider>` into the
//!    runtime registry under a write lock.
//! 6. Persist the updated `Config` back to `config.json` (atomic
//!    write via `Config::to_json_string` + `tempfile`-style swap).
//! 7. Return a [`ProviderSnapshot`] for the caller to echo to the
//!    client. The api_key is **never** echoed; only `has_api_key`.
//!
//! `unprovision` is the mirror: drop from registry, remove from
//! `config.json`, optionally wipe the auth-file. `set_default` is a
//! no-build operation (just registry + config tweak).

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use harness_server::{
    ProviderAdmin, ProviderDef, ProviderRegistry, ProviderSnapshot, ProvisionError,
};

use crate::auth_store;
use crate::config::{Config, ProviderConfig};

/// How the binary's runtime tracks the current Config: in memory
/// behind an `RwLock`, with the `path` (when `Some`) being the file
/// to write back to. When `path` is `None` (no config file was
/// loaded — env-only deployment), persistence calls return
/// `Persistence("no config_path configured")` and the operator has
/// to introduce a config file first.
pub struct Provisioner {
    pub config: Arc<RwLock<Config>>,
    pub config_path: Option<PathBuf>,
    pub registry: Arc<RwLock<ProviderRegistry>>,
}

impl Provisioner {
    pub fn new(
        config: Config,
        config_path: Option<PathBuf>,
        registry: Arc<RwLock<ProviderRegistry>>,
    ) -> Self {
        Self {
            config: Arc::new(RwLock::new(config)),
            config_path,
            registry,
        }
    }
}

fn validate(def: &ProviderDef) -> Result<(), ProvisionError> {
    let name = def.name.trim();
    if name.is_empty() {
        return Err(ProvisionError::Invalid("`name` must not be blank".into()));
    }
    // Disallow path-like and whitespace-y names since the auth_store
    // keys files off these. `auth/<name>.json` should land in one
    // directory unambiguously.
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(ProvisionError::Invalid(format!(
            "provider name `{name}` contains a path separator"
        )));
    }
    if def.kind.trim().is_empty() {
        return Err(ProvisionError::Invalid("`kind` must not be blank".into()));
    }
    if def.default_model.trim().is_empty() {
        return Err(ProvisionError::Invalid(
            "`default_model` must not be blank".into(),
        ));
    }
    Ok(())
}

fn merged_config_for_build(
    base: &Config,
    def: &ProviderDef,
) -> Config {
    let mut next = base.clone();
    let pc = ProviderConfig {
        enabled: true,
        default_model: Some(def.default_model.clone()),
        models: def.models.clone(),
        base_url: def.base_url.clone(),
        version: def.version.clone(),
        home: def.codex_home.as_ref().map(PathBuf::from),
        path: def.codex_path.clone(),
        originator: def.codex_originator.clone(),
        reasoning_summary: def.reasoning_summary.clone(),
        reasoning_effort: def.reasoning_effort.clone(),
        include_encrypted_reasoning: def.include_encrypted_reasoning,
        service_tier: def.service_tier.clone(),
    };
    next.providers.insert(def.name.clone(), pc);
    next
}

fn save_config(cfg: &Config, path: &PathBuf) -> Result<(), ProvisionError> {
    let body = cfg
        .to_json_string()
        .map_err(|e| ProvisionError::Persistence(format!("serialize config: {e}")))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ProvisionError::Persistence(format!("mkdir {}: {e}", parent.display())))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)
        .map_err(|e| ProvisionError::Persistence(format!("write {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| ProvisionError::Persistence(format!("rename {}: {e}", tmp.display())))?;
    Ok(())
}

fn snapshot_from_state(
    name: &str,
    registry: &ProviderRegistry,
    cfg: &Config,
) -> Option<ProviderSnapshot> {
    let info = registry.list().into_iter().find(|p| p.name == name)?;
    let section = cfg.provider(name);
    let kind = inferred_kind(&info.name, &section);
    let has_api_key = auth_store::load_api_key(name)
        .ok()
        .flatten()
        .is_some()
        || env_var_for_kind(&kind).is_some();
    Some(ProviderSnapshot {
        name: info.name,
        kind,
        has_api_key,
        default_model: info.default_model,
        models: info.models,
        is_default: info.is_default,
        base_url: section.base_url.clone(),
        version: section.version.clone(),
        reasoning_summary: section.reasoning_summary.clone(),
        reasoning_effort: section.reasoning_effort.clone(),
        include_encrypted_reasoning: section.include_encrypted_reasoning,
        service_tier: section.service_tier.clone(),
        codex_home: section.home.as_ref().map(|p| p.display().to_string()),
        codex_path: section.path.clone(),
        codex_originator: section.originator.clone(),
    })
}

/// Best-effort kind inference. The CLI / config don't currently
/// store kind separately from name, so for built-in names we use
/// the name itself; for unknown names we default to `"openai"`
/// (compatible HTTP). The Web UI's edit form lets the user
/// override this.
fn inferred_kind(name: &str, _section: &ProviderConfig) -> String {
    match name {
        "openai" | "openai-responses" | "anthropic" | "google" | "codex" | "kimi"
        | "kimi-code" | "ollama" => name.to_string(),
        _ => "openai".to_string(),
    }
}

/// Returns the env var name we'd consult if the user hadn't
/// supplied an api-key file. Used for `has_api_key` to avoid
/// reporting "no key" when the operator set one in their shell.
fn env_var_for_kind(kind: &str) -> Option<String> {
    let var = match kind {
        "openai" | "openai-responses" => "OPENAI_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "google" => "GOOGLE_API_KEY",
        "kimi" | "kimi-code" => "KIMI_API_KEY",
        // codex uses OAuth, no env api-key
        "codex" => return None,
        // ollama is local, no key required
        "ollama" => return None,
        _ => return None,
    };
    std::env::var(var).ok()
}

#[async_trait]
impl ProviderAdmin for Provisioner {
    async fn provision(
        &self,
        def: ProviderDef,
        allow_overwrite: bool,
    ) -> Result<ProviderSnapshot, ProvisionError> {
        validate(&def)?;

        if !allow_overwrite {
            let already = self
                .registry
                .read()
                .map_err(|_| ProvisionError::Persistence("registry lock poisoned".into()))?
                .contains(&def.name);
            if already {
                return Err(ProvisionError::AlreadyExists(def.name.clone()));
            }
        }

        // 1. Persist the api_key (if supplied) so build_provider can
        //    pick it up via resolve_api_key. Strip surrounding
        //    whitespace; treat blank as "leave existing on-disk key
        //    alone" (the PATCH case where the user didn't retype).
        if let Some(key) = def.api_key.as_deref() {
            let trimmed = key.trim();
            if !trimmed.is_empty() {
                auth_store::save_api_key(&def.name, trimmed).map_err(|e| {
                    ProvisionError::Persistence(format!("save api_key: {e}"))
                })?;
            }
        }

        // 2. Build the provider against a Config snapshot that has
        //    the new entry merged in.
        let merged = {
            let guard = self
                .config
                .read()
                .map_err(|_| ProvisionError::Persistence("config lock poisoned".into()))?;
            merged_config_for_build(&guard, &def)
        };
        let (provider, model) = crate::serve::build_provider(
            &def.kind,
            Some(def.default_model.clone()),
            &merged,
        )
        .await
        .map_err(|e| ProvisionError::Construction(e.to_string()))?;

        // 3. Insert into the live registry under the user's chosen
        //    name (which may differ from kind for custom providers).
        let mut models_for_registry = def.models.clone();
        if !models_for_registry.contains(&model) {
            models_for_registry.insert(0, model.clone());
        }
        {
            let mut guard = self
                .registry
                .write()
                .map_err(|_| ProvisionError::Persistence("registry lock poisoned".into()))?;
            guard.insert_with_models(
                def.name.clone(),
                provider,
                model.clone(),
                models_for_registry,
            );
        }

        // 4. Save Config to disk and update the in-memory copy.
        {
            let mut guard = self
                .config
                .write()
                .map_err(|_| ProvisionError::Persistence("config lock poisoned".into()))?;
            *guard = merged;
            if let Some(path) = &self.config_path {
                save_config(&guard, path)?;
            }
        }

        // 5. Build the snapshot for the response.
        let registry_guard = self
            .registry
            .read()
            .map_err(|_| ProvisionError::Persistence("registry lock poisoned".into()))?;
        let cfg_guard = self
            .config
            .read()
            .map_err(|_| ProvisionError::Persistence("config lock poisoned".into()))?;
        snapshot_from_state(&def.name, &registry_guard, &cfg_guard).ok_or_else(|| {
            ProvisionError::Persistence(
                "newly-installed provider missing from registry — race?".into(),
            )
        })
    }

    async fn unprovision(
        &self,
        name: &str,
        purge_secret: bool,
    ) -> Result<bool, ProvisionError> {
        let removed = {
            let mut guard = self
                .registry
                .write()
                .map_err(|_| ProvisionError::Persistence("registry lock poisoned".into()))?;
            guard.remove(name)
        };

        // Drop from config.providers regardless of whether the
        // registry had an entry — the on-disk config could still
        // carry it from a previous session.
        let cfg_changed = {
            let mut guard = self
                .config
                .write()
                .map_err(|_| ProvisionError::Persistence("config lock poisoned".into()))?;
            let was = guard.providers.remove(name).is_some();
            // If the deleted name was the default, clear it so the
            // next start-up doesn't try to route to a missing entry.
            if guard.default_provider.as_deref() == Some(name) {
                guard.default_provider = None;
            }
            if was {
                if let Some(path) = &self.config_path {
                    save_config(&guard, path)?;
                }
            }
            was
        };

        if purge_secret {
            // Best-effort: a missing file is fine.
            let _ = auth_store::delete(name);
        }

        Ok(removed || cfg_changed)
    }

    async fn set_default(&self, name: &str) -> Result<(), ProvisionError> {
        // Verify the name is in the registry first so we don't
        // strand the routing on a missing key.
        let known = {
            let guard = self
                .registry
                .read()
                .map_err(|_| ProvisionError::Persistence("registry lock poisoned".into()))?;
            guard.contains(name)
        };
        if !known {
            return Err(ProvisionError::NotFound(name.to_string()));
        }

        // Update on-disk config (and the in-memory copy).
        {
            let mut guard = self
                .config
                .write()
                .map_err(|_| ProvisionError::Persistence("config lock poisoned".into()))?;
            guard.default_provider = Some(name.to_string());
            if let Some(path) = &self.config_path {
                save_config(&guard, path)?;
            }
        }

        // The runtime registry exposes `default_name(&self) -> &str`
        // but no setter — the Web-UI's clients refetch via WS-driven
        // `providers_changed`, and the next per-request `pick()` call
        // honours the registry's frozen `default_name`. To make
        // `set_default` actually swap the registry's default in
        // memory, we'd need an `set_default(&mut self, name)` setter.
        // Add one:
        {
            let mut guard = self
                .registry
                .write()
                .map_err(|_| ProvisionError::Persistence("registry lock poisoned".into()))?;
            guard.set_default(name);
        }

        Ok(())
    }

    async fn snapshot(&self, name: &str) -> Result<ProviderSnapshot, ProvisionError> {
        let registry_guard = self
            .registry
            .read()
            .map_err(|_| ProvisionError::Persistence("registry lock poisoned".into()))?;
        let cfg_guard = self
            .config
            .read()
            .map_err(|_| ProvisionError::Persistence("config lock poisoned".into()))?;
        snapshot_from_state(name, &registry_guard, &cfg_guard)
            .ok_or_else(|| ProvisionError::NotFound(name.to_string()))
    }
}

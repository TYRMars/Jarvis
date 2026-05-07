//! `Tenant` — multi-tenant isolation boundary.
//!
//! A **Tenant** is a top-level organisational boundary (e.g. a team,
//! customer, or SaaS tenant). It is **not** a filesystem workspace —
//! the per-session working directory concept lives in
//! [`workspace`](crate::workspace).
//!
//! `harness-core` defines only the value type and the [`TenantStore`]
//! trait; persistence backends live in `harness-store`.

use serde::{Deserialize, Serialize};

/// A multi-tenant isolation boundary.
///
/// Tenants are independent of the per-session [`workspace`](crate::workspace)
/// concept.  A tenant may span many workspace directories, and a workspace
/// may be accessed in the context of many tenants (although typical SaaS
/// deployments map 1:1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tenant {
    /// Stable internal identifier (UUID v4).
    pub id: String,
    /// Human-readable, URL-friendly handle. Globally unique within a store.
    pub slug: String,
    /// Display name. Free-form, not unique.
    pub name: String,
    /// Per-tenant configuration.
    pub settings: TenantSettings,
    /// Soft-delete flag. Archived tenants are hidden from default listings.
    #[serde(default)]
    pub archived: bool,
    /// RFC-3339 / ISO-8601 timestamp of creation.
    pub created_at: String,
    /// RFC-3339 / ISO-8601 timestamp of the last mutation.
    pub updated_at: String,
}

/// Per-tenant settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TenantSettings {
    /// Optional prefix prepended to generated issue / requirement ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_prefix: Option<String>,
    /// Default LLM provider identifier for conversations created under
    /// this tenant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    /// Default model name used when `default_provider` is selected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// Repository URLs that agents running in this tenant are permitted
    /// to clone or interact with.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_repo_urls: Vec<String>,
}

impl Tenant {
    /// Create a new tenant with a fresh UUID v4 id and current timestamps.
    /// `slug` is left **empty** — the caller is expected to set one.
    pub fn new(name: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            slug: String::new(),
            name: name.into(),
            settings: TenantSettings::default(),
            archived: false,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Builder-style setter for `slug`. Bumps `updated_at`.
    pub fn with_slug(mut self, slug: impl Into<String>) -> Self {
        self.set_slug(slug);
        self
    }

    /// Builder-style setter for `settings`. Bumps `updated_at`.
    pub fn with_settings(mut self, settings: TenantSettings) -> Self {
        self.set_settings(settings);
        self
    }

    /// Replace `slug`; bumps `updated_at`.
    pub fn set_slug(&mut self, slug: impl Into<String>) {
        self.slug = slug.into();
        self.touch();
    }

    /// Replace `name`; bumps `updated_at`.
    pub fn set_name(&mut self, name: impl Into<String>) {
        self.name = name.into();
        self.touch();
    }

    /// Replace `settings`; bumps `updated_at`.
    pub fn set_settings(&mut self, settings: TenantSettings) {
        self.settings = settings;
        self.touch();
    }

    /// Mark the tenant as soft-deleted. Idempotent.
    pub fn archive(&mut self) {
        if !self.archived {
            self.archived = true;
            self.touch();
        }
    }

    /// Restore a soft-deleted tenant. Idempotent.
    pub fn unarchive(&mut self) {
        if self.archived {
            self.archived = false;
            self.touch();
        }
    }

    /// Refresh `updated_at` to "now". Called by every mutator.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Validate that a slug is well-formed for storage.
///
/// Returns `Ok(())` for `[a-z0-9-]{1,64}` that doesn't start or end
/// with `-`. Anything else returns `Err` with a human-readable reason.
pub fn validate_slug(slug: &str) -> Result<(), &'static str> {
    if slug.is_empty() {
        return Err("slug must not be empty");
    }
    if slug.len() > 64 {
        return Err("slug must be at most 64 characters");
    }
    if slug.starts_with('-') || slug.ends_with('-') {
        return Err("slug must not start or end with '-'");
    }
    if !slug
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("slug must contain only lowercase ascii, digits, and '-'");
    }
    Ok(())
}

/// Store for tenant metadata.
#[async_trait::async_trait]
pub trait TenantStore: Send + Sync {
    /// Persist a tenant. Inserts when `id` is unknown, updates otherwise.
    async fn save(&self, tenant: &Tenant) -> Result<(), crate::BoxError>;
    /// Load a single tenant by its internal `id`.
    async fn load(&self, id: &str) -> Result<Option<Tenant>, crate::BoxError>;
    /// Look up a tenant by its globally unique `slug`.
    async fn find_by_slug(&self, slug: &str) -> Result<Option<Tenant>, crate::BoxError>;
    /// List tenants. Default implementations may hide archived rows.
    async fn list(&self) -> Result<Vec<Tenant>, crate::BoxError>;
    /// Soft-delete (set `archived = true`). Returns `true` if the row
    /// existed and was modified.
    async fn archive(&self, id: &str) -> Result<bool, crate::BoxError>;
    /// Hard-delete a tenant. Returns `true` if the row existed.
    async fn delete(&self, id: &str) -> Result<bool, crate::BoxError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_mints_uuid_and_timestamps() {
        let t = Tenant::new("Acme Corp");
        assert_eq!(t.id.len(), 36); // UUID
        assert_eq!(t.name, "Acme Corp");
        assert!(t.slug.is_empty());
        assert!(!t.archived);
        assert_eq!(t.created_at, t.updated_at);
    }

    #[test]
    fn touch_bumps_updated_at() {
        let mut t = Tenant::new("x");
        let before = t.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        t.set_name("z");
        assert!(t.updated_at > before, "{} > {}", t.updated_at, before);
    }

    #[test]
    fn archive_is_idempotent() {
        let mut t = Tenant::new("x");
        t.archive();
        let stamp = t.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        t.archive();
        assert_eq!(
            t.updated_at, stamp,
            "second archive must not bump updated_at"
        );
        assert!(t.archived);
    }

    #[test]
    fn unarchive_is_idempotent() {
        let mut t = Tenant::new("x");
        t.archive();
        t.unarchive();
        let stamp = t.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        t.unarchive();
        assert!(!t.archived);
        assert_eq!(
            t.updated_at, stamp,
            "second unarchive must not bump updated_at"
        );
    }

    #[test]
    fn validate_slug_rejects_bad_inputs() {
        assert!(validate_slug("ok-slug").is_ok());
        assert!(validate_slug("a").is_ok());
        assert!(validate_slug("").is_err());
        assert!(validate_slug("-leading").is_err());
        assert!(validate_slug("trailing-").is_err());
        assert!(validate_slug("UPPER").is_err());
        assert!(validate_slug("with space").is_err());
        assert!(validate_slug("under_score").is_err());
        assert!(validate_slug(&"a".repeat(65)).is_err());
    }

    #[test]
    fn validate_slug_allows_digits_and_dashes() {
        assert!(validate_slug("acme-corp-42").is_ok());
        assert!(validate_slug("123").is_ok());
    }

    #[test]
    fn round_trip_serialises_to_json() {
        let t = Tenant::new("Acme")
            .with_slug("acme")
            .with_settings(TenantSettings {
                issue_prefix: Some("ACME".into()),
                default_provider: Some("openai".into()),
                default_model: Some("gpt-4o".into()),
                allowed_repo_urls: vec!["https://github.com/acme".into()],
            });
        let json = serde_json::to_string(&t).unwrap();
        let back: Tenant = serde_json::from_str(&json).unwrap();
        assert_eq!(t, back);
    }

    #[test]
    fn archived_default_false_for_legacy_json() {
        let legacy = r#"{
            "id": "11111111-1111-1111-1111-111111111111",
            "slug": "legacy",
            "name": "Legacy",
            "settings": {},
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }"#;
        let t: Tenant = serde_json::from_str(legacy).unwrap();
        assert!(!t.archived);
    }

    #[test]
    fn settings_are_skipped_when_default() {
        let t = Tenant::new("n");
        let json = serde_json::to_string(&t).unwrap();
        assert!(!json.contains("issue_prefix"));
        assert!(!json.contains("allowed_repo_urls"));
    }
}

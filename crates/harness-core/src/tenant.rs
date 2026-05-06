use serde::{Deserialize, Serialize};

/// Tenant (workspace) isolation boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tenant {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub settings: TenantSettings,
    pub created_at: String,
    pub updated_at: String,
}

/// Per-tenant settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TenantSettings {
    pub issue_prefix: Option<String>,
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub allowed_repo_urls: Vec<String>,
}

/// Store for tenant metadata.
#[async_trait::async_trait]
pub trait TenantStore: Send + Sync {
    async fn list(&self) -> Result<Vec<Tenant>, crate::BoxError>;
    async fn get(&self, id: &str) -> Result<Option<Tenant>, crate::BoxError>;
    async fn get_by_slug(&self, slug: &str) -> Result<Option<Tenant>, crate::BoxError>;
    async fn upsert(&self, tenant: &Tenant) -> Result<(), crate::BoxError>;
    async fn delete(&self, id: &str) -> Result<bool, crate::BoxError>;
}

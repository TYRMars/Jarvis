//! Connector binding stores — memory + JSON-file backends for the three
//! `harness-connectors` store traits. Follows the per-row-file pattern of
//! the sibling JSON stores (`<dir>/<kind>/<encoded-id>.json`, atomic
//! tmp+rename writes, `list` = directory scan).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use harness_connectors::{
    BoxError, ConnectorAccount, ConnectorAccountStore, ProjectBinding, ProjectBindingStore,
    RequirementBinding, RequirementBindingStore,
};

use crate::error::StoreError;
use crate::json_file::{atomic_write, encode_id, ensure_dir, read_json_records};

// ---------------------------------------------------------------------
// In-memory backends (tests / ephemeral deployments)
// ---------------------------------------------------------------------

#[derive(Default)]
pub struct MemoryConnectorAccountStore {
    inner: Arc<RwLock<HashMap<String, ConnectorAccount>>>,
}

impl MemoryConnectorAccountStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl ConnectorAccountStore for MemoryConnectorAccountStore {
    async fn upsert(&self, account: &ConnectorAccount) -> Result<(), BoxError> {
        self.inner
            .write()
            .map_err(|_| "lock poisoned")?
            .insert(account.id.clone(), account.clone());
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Option<ConnectorAccount>, BoxError> {
        Ok(self.inner.read().map_err(|_| "lock poisoned")?.get(id).cloned())
    }

    async fn list(&self) -> Result<Vec<ConnectorAccount>, BoxError> {
        let mut rows: Vec<_> = self
            .inner
            .read()
            .map_err(|_| "lock poisoned")?
            .values()
            .cloned()
            .collect();
        rows.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(rows)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        Ok(self
            .inner
            .write()
            .map_err(|_| "lock poisoned")?
            .remove(id)
            .is_some())
    }
}

#[derive(Default)]
pub struct MemoryProjectBindingStore {
    inner: Arc<RwLock<HashMap<String, ProjectBinding>>>,
}

impl MemoryProjectBindingStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl ProjectBindingStore for MemoryProjectBindingStore {
    async fn upsert(&self, binding: &ProjectBinding) -> Result<(), BoxError> {
        self.inner
            .write()
            .map_err(|_| "lock poisoned")?
            .insert(binding.id.clone(), binding.clone());
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Option<ProjectBinding>, BoxError> {
        Ok(self.inner.read().map_err(|_| "lock poisoned")?.get(id).cloned())
    }

    async fn list(&self, project_id: Option<&str>) -> Result<Vec<ProjectBinding>, BoxError> {
        let mut rows: Vec<_> = self
            .inner
            .read()
            .map_err(|_| "lock poisoned")?
            .values()
            .filter(|b| project_id.map_or(true, |p| b.project_id == p))
            .cloned()
            .collect();
        rows.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(rows)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        Ok(self
            .inner
            .write()
            .map_err(|_| "lock poisoned")?
            .remove(id)
            .is_some())
    }
}

#[derive(Default)]
pub struct MemoryRequirementBindingStore {
    inner: Arc<RwLock<HashMap<String, RequirementBinding>>>,
}

impl MemoryRequirementBindingStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl RequirementBindingStore for MemoryRequirementBindingStore {
    async fn upsert(&self, binding: &RequirementBinding) -> Result<(), BoxError> {
        self.inner
            .write()
            .map_err(|_| "lock poisoned")?
            .insert(binding.id.clone(), binding.clone());
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Option<RequirementBinding>, BoxError> {
        Ok(self.inner.read().map_err(|_| "lock poisoned")?.get(id).cloned())
    }

    async fn list_for_project_binding(
        &self,
        project_binding_id: &str,
    ) -> Result<Vec<RequirementBinding>, BoxError> {
        let mut rows: Vec<_> = self
            .inner
            .read()
            .map_err(|_| "lock poisoned")?
            .values()
            .filter(|b| b.project_binding_id == project_binding_id)
            .cloned()
            .collect();
        rows.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(rows)
    }

    async fn find_by_remote(
        &self,
        project_binding_id: &str,
        remote_task_id: &str,
    ) -> Result<Option<RequirementBinding>, BoxError> {
        Ok(self
            .inner
            .read()
            .map_err(|_| "lock poisoned")?
            .values()
            .find(|b| {
                b.project_binding_id == project_binding_id && b.remote_task_id == remote_task_id
            })
            .cloned())
    }

    async fn find_by_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Option<RequirementBinding>, BoxError> {
        Ok(self
            .inner
            .read()
            .map_err(|_| "lock poisoned")?
            .values()
            .find(|b| b.requirement_id == requirement_id)
            .cloned())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        Ok(self
            .inner
            .write()
            .map_err(|_| "lock poisoned")?
            .remove(id)
            .is_some())
    }
}

// ---------------------------------------------------------------------
// JSON-file backends (default persistence)
// ---------------------------------------------------------------------

macro_rules! json_row_store {
    ($store:ident, $subdir:literal) => {
        pub struct $store {
            dir: PathBuf,
        }

        impl $store {
            pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
                let dir = dir.into();
                ensure_dir(&dir)?;
                ensure_dir(&dir.join($subdir))?;
                Ok(Self { dir })
            }

            fn row_path(&self, id: &str) -> PathBuf {
                self.dir.join($subdir).join(format!("{}.json", encode_id(id)))
            }

            async fn write_row<T: serde::Serialize>(&self, id: &str, row: &T) -> Result<(), BoxError> {
                let bytes = serde_json::to_vec_pretty(row)?;
                atomic_write(&self.row_path(id), &bytes).await
            }

            async fn read_row<T: serde::de::DeserializeOwned>(
                &self,
                id: &str,
            ) -> Result<Option<T>, BoxError> {
                match tokio::fs::read(self.row_path(id)).await {
                    Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(e) => Err(e.into()),
                }
            }

            async fn delete_row(&self, id: &str) -> Result<bool, BoxError> {
                match tokio::fs::remove_file(self.row_path(id)).await {
                    Ok(()) => Ok(true),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                    Err(e) => Err(e.into()),
                }
            }

            async fn all_rows<T: serde::de::DeserializeOwned>(&self) -> Result<Vec<T>, BoxError> {
                read_json_records(&self.dir.join($subdir)).await
            }
        }
    };
}

json_row_store!(JsonFileConnectorAccountStore, "connector_accounts");
json_row_store!(JsonFileProjectBindingStore, "project_bindings");
json_row_store!(JsonFileRequirementBindingStore, "requirement_bindings");

#[async_trait]
impl ConnectorAccountStore for JsonFileConnectorAccountStore {
    async fn upsert(&self, account: &ConnectorAccount) -> Result<(), BoxError> {
        self.write_row(&account.id, account).await
    }

    async fn get(&self, id: &str) -> Result<Option<ConnectorAccount>, BoxError> {
        self.read_row(id).await
    }

    async fn list(&self) -> Result<Vec<ConnectorAccount>, BoxError> {
        let mut rows: Vec<ConnectorAccount> = self.all_rows().await?;
        rows.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(rows)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        self.delete_row(id).await
    }
}

#[async_trait]
impl ProjectBindingStore for JsonFileProjectBindingStore {
    async fn upsert(&self, binding: &ProjectBinding) -> Result<(), BoxError> {
        self.write_row(&binding.id, binding).await
    }

    async fn get(&self, id: &str) -> Result<Option<ProjectBinding>, BoxError> {
        self.read_row(id).await
    }

    async fn list(&self, project_id: Option<&str>) -> Result<Vec<ProjectBinding>, BoxError> {
        let mut rows: Vec<ProjectBinding> = self.all_rows().await?;
        if let Some(p) = project_id {
            rows.retain(|b| b.project_id == p);
        }
        rows.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(rows)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        self.delete_row(id).await
    }
}

#[async_trait]
impl RequirementBindingStore for JsonFileRequirementBindingStore {
    async fn upsert(&self, binding: &RequirementBinding) -> Result<(), BoxError> {
        self.write_row(&binding.id, binding).await
    }

    async fn get(&self, id: &str) -> Result<Option<RequirementBinding>, BoxError> {
        self.read_row(id).await
    }

    async fn list_for_project_binding(
        &self,
        project_binding_id: &str,
    ) -> Result<Vec<RequirementBinding>, BoxError> {
        let mut rows: Vec<RequirementBinding> = self.all_rows().await?;
        rows.retain(|b| b.project_binding_id == project_binding_id);
        rows.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(rows)
    }

    async fn find_by_remote(
        &self,
        project_binding_id: &str,
        remote_task_id: &str,
    ) -> Result<Option<RequirementBinding>, BoxError> {
        let rows: Vec<RequirementBinding> = self.all_rows().await?;
        Ok(rows.into_iter().find(|b| {
            b.project_binding_id == project_binding_id && b.remote_task_id == remote_task_id
        }))
    }

    async fn find_by_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Option<RequirementBinding>, BoxError> {
        let rows: Vec<RequirementBinding> = self.all_rows().await?;
        Ok(rows.into_iter().find(|b| b.requirement_id == requirement_id))
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        self.delete_row(id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn memory_requirement_binding_lookups() {
        let store = MemoryRequirementBindingStore::new();
        let mut b = RequirementBinding::new("github", "pb-1", "req-1", "42");
        store.upsert(&b).await.unwrap();
        assert!(store.find_by_remote("pb-1", "42").await.unwrap().is_some());
        assert!(store.find_by_remote("pb-1", "43").await.unwrap().is_none());
        assert!(store.find_by_requirement("req-1").await.unwrap().is_some());
        b.remote_updated_at = Some("2026-06-10T00:00:00Z".into());
        store.upsert(&b).await.unwrap();
        let got = store.get(&b.id).await.unwrap().unwrap();
        assert_eq!(got.remote_updated_at.as_deref(), Some("2026-06-10T00:00:00Z"));
        assert!(store.delete(&b.id).await.unwrap());
        assert!(!store.delete(&b.id).await.unwrap());
    }

    #[tokio::test]
    async fn json_file_stores_round_trip() {
        let dir = tempdir().unwrap();
        let accounts = JsonFileConnectorAccountStore::open(dir.path()).unwrap();
        let a = ConnectorAccount::new("github", "personal", "GITHUB_TOKEN");
        accounts.upsert(&a).await.unwrap();
        assert_eq!(accounts.list().await.unwrap().len(), 1);
        assert_eq!(accounts.get(&a.id).await.unwrap().unwrap().auth_ref, "GITHUB_TOKEN");

        let bindings = JsonFileProjectBindingStore::open(dir.path()).unwrap();
        let pb = ProjectBinding::new("github", &a.id, "proj-1", "tyrmars/jarvis");
        bindings.upsert(&pb).await.unwrap();
        assert_eq!(bindings.list(Some("proj-1")).await.unwrap().len(), 1);
        assert!(bindings.list(Some("other")).await.unwrap().is_empty());

        let reqs = JsonFileRequirementBindingStore::open(dir.path()).unwrap();
        let rb = RequirementBinding::new("github", &pb.id, "req-1", "7");
        reqs.upsert(&rb).await.unwrap();
        assert!(reqs.find_by_remote(&pb.id, "7").await.unwrap().is_some());
        assert!(reqs.find_by_requirement("req-1").await.unwrap().is_some());
        assert_eq!(reqs.list_for_project_binding(&pb.id).await.unwrap().len(), 1);
        assert!(reqs.delete(&rb.id).await.unwrap());
        assert!(reqs.find_by_remote(&pb.id, "7").await.unwrap().is_none());
    }
}

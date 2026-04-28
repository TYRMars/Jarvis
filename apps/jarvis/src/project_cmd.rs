//! `jarvis project ...` subcommands.
//!
//! Talks directly to the same `ProjectStore` the HTTP server uses —
//! reuses `JARVIS_DB_URL` / `[persistence].url` resolution so the CLI
//! and the server stay in sync without copy-paste.
//!
//! Subcommands:
//!
//! - `jarvis project list`           — newest-updated first; `--all` includes archived
//! - `jarvis project show <ref>`     — print one project (id or slug)
//! - `jarvis project create ...`     — create from flags / instructions file
//! - `jarvis project edit <ref> ...` — partial update
//! - `jarvis project delete <ref>`   — soft-delete; `--hard` removes the row
//! - `jarvis project restore <ref>`  — undo a soft-delete

use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Subcommand};
use harness_core::{derive_slug, validate_slug, Project, ProjectStore};

use crate::config::Config;

#[derive(Subcommand, Debug)]
pub enum ProjectCmd {
    /// List projects (newest-updated first).
    List(ListArgs),
    /// Print a project's full record by id or slug.
    Show {
        #[arg(value_name = "ID_OR_SLUG")]
        target: String,
        #[arg(long)]
        json: bool,
    },
    /// Create a new project.
    Create(CreateArgs),
    /// Update a project's fields. Each option is optional; only the
    /// fields you pass are touched.
    Edit(EditArgs),
    /// Soft-delete (archive) a project. Use `--hard` to remove the
    /// row entirely; refused if any conversations are still bound.
    Delete {
        #[arg(value_name = "ID_OR_SLUG")]
        target: String,
        #[arg(long)]
        hard: bool,
    },
    /// Un-archive a project.
    Restore {
        #[arg(value_name = "ID_OR_SLUG")]
        target: String,
    },
}

#[derive(Args, Debug)]
pub struct ListArgs {
    /// Include archived projects.
    #[arg(long)]
    pub all: bool,
    /// Limit (default 50).
    #[arg(long, default_value_t = 50)]
    pub limit: u32,
    /// Emit JSON instead of the human-readable table.
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    /// Display name (required).
    #[arg(long)]
    pub name: String,
    /// Slug. Defaults to a derivation of `name` (with `-2`, `-3` …
    /// disambiguation if the slug is already taken).
    #[arg(long)]
    pub slug: Option<String>,
    /// Optional one-line description.
    #[arg(long)]
    pub description: Option<String>,
    /// Project instructions inline. Mutually exclusive with
    /// `--instructions-file`. At least one of the two must be set.
    #[arg(long, conflicts_with = "instructions_file")]
    pub instructions: Option<String>,
    /// Path to a markdown / text file with the project's instructions.
    #[arg(long, value_name = "PATH")]
    pub instructions_file: Option<PathBuf>,
    /// Repeatable `--tag` flag.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// Print the created project as JSON.
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct EditArgs {
    #[arg(value_name = "ID_OR_SLUG")]
    pub target: String,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub slug: Option<String>,
    #[arg(long)]
    pub description: Option<String>,
    #[arg(long, conflicts_with = "instructions_file")]
    pub instructions: Option<String>,
    #[arg(long, value_name = "PATH")]
    pub instructions_file: Option<PathBuf>,
    /// Replace the tag list. Pass an empty string (`--tags ''`) to
    /// clear; pass comma-separated values to replace.
    #[arg(long)]
    pub tags: Option<String>,
    #[arg(long)]
    pub json: bool,
}

pub async fn run(cfg: Option<Config>, cmd: ProjectCmd) -> Result<()> {
    let cfg = cfg.unwrap_or_default();
    let store = open_store(&cfg).await?;
    match cmd {
        ProjectCmd::List(args) => list(store.as_ref(), args).await,
        ProjectCmd::Show { target, json } => show(store.as_ref(), &target, json).await,
        ProjectCmd::Create(args) => create(store.as_ref(), args).await,
        ProjectCmd::Edit(args) => edit(store.as_ref(), args).await,
        ProjectCmd::Delete { target, hard } => delete(store.as_ref(), &cfg, &target, hard).await,
        ProjectCmd::Restore { target } => restore(store.as_ref(), &target).await,
    }
}

async fn open_store(cfg: &Config) -> Result<std::sync::Arc<dyn ProjectStore>> {
    let url = pick_db_url(cfg).ok_or_else(|| {
        anyhow!(
            "no database URL configured — set JARVIS_DB_URL or `[persistence].url` in config.json"
        )
    })?;
    let bundle = harness_store::connect_all(&url)
        .await
        .with_context(|| format!("opening db url `{url}`"))?;
    Ok(bundle.projects)
}

fn pick_db_url(cfg: &Config) -> Option<String> {
    std::env::var("JARVIS_DB_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| cfg.persistence.url.clone())
}

// ---------- list ----------

async fn list(store: &dyn ProjectStore, args: ListArgs) -> Result<()> {
    let rows = store.list(args.all, args.limit).await.map_err(boxed)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&rows.iter().map(project_json).collect::<Vec<_>>())?);
        return Ok(());
    }
    if rows.is_empty() {
        eprintln!("(no projects)");
        return Ok(());
    }
    println!("{:<36}  {:<24}  NAME", "ID", "SLUG");
    for p in rows {
        let name = if p.archived {
            format!("{} (archived)", p.name)
        } else {
            p.name.clone()
        };
        println!("{:<36}  {:<24}  {}", p.id, p.slug, name);
    }
    Ok(())
}

// ---------- show ----------

async fn show(store: &dyn ProjectStore, target: &str, json: bool) -> Result<()> {
    let p = lookup(store, target).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&project_json(&p))?);
        return Ok(());
    }
    println!("id:           {}", p.id);
    println!("slug:         {}", p.slug);
    println!("name:         {}", p.name);
    if let Some(d) = &p.description {
        println!("description:  {d}");
    }
    if !p.tags.is_empty() {
        println!("tags:         {}", p.tags.join(", "));
    }
    println!("archived:     {}", p.archived);
    println!("created_at:   {}", p.created_at);
    println!("updated_at:   {}", p.updated_at);
    println!("---- instructions ----");
    println!("{}", p.instructions);
    Ok(())
}

// ---------- create ----------

async fn create(store: &dyn ProjectStore, args: CreateArgs) -> Result<()> {
    let instructions = read_instructions(args.instructions, args.instructions_file)?;
    let slug_seed = args
        .slug
        .clone()
        .unwrap_or_else(|| derive_slug(&args.name));
    validate_slug(&slug_seed).map_err(|e| anyhow!("invalid slug: {e}"))?;
    let slug = if args.slug.is_some() {
        // Caller-pinned slug: hard-fail on conflict.
        if store.find_by_slug(&slug_seed).await.map_err(boxed)?.is_some() {
            bail!("slug `{slug_seed}` already in use");
        }
        slug_seed
    } else {
        unique_slug(store, &slug_seed).await?
    };

    let mut p = Project::new(args.name, instructions).with_slug(slug);
    if let Some(d) = args.description {
        p.set_description(Some(d));
    }
    if !args.tags.is_empty() {
        p.set_tags(args.tags);
    }
    store.save(&p).await.map_err(boxed)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&project_json(&p))?);
    } else {
        println!("✓ created project {} ({})", p.name, p.slug);
        println!("  id: {}", p.id);
    }
    Ok(())
}

async fn unique_slug(store: &dyn ProjectStore, seed: &str) -> Result<String> {
    if store.find_by_slug(seed).await.map_err(boxed)?.is_none() {
        return Ok(seed.to_string());
    }
    for n in 2..=99 {
        let candidate = format!("{seed}-{n}");
        if validate_slug(&candidate).is_err() {
            break;
        }
        if store
            .find_by_slug(&candidate)
            .await
            .map_err(boxed)?
            .is_none()
        {
            return Ok(candidate);
        }
    }
    bail!("could not derive a unique slug from `{seed}`");
}

// ---------- edit ----------

async fn edit(store: &dyn ProjectStore, args: EditArgs) -> Result<()> {
    let mut p = lookup(store, &args.target).await?;

    if let Some(name) = args.name {
        if name.trim().is_empty() {
            bail!("name must not be empty");
        }
        p.set_name(name);
    }
    if let Some(slug) = args.slug {
        validate_slug(&slug).map_err(|e| anyhow!("invalid slug: {e}"))?;
        if slug != p.slug {
            if let Some(other) = store.find_by_slug(&slug).await.map_err(boxed)? {
                if other.id != p.id {
                    bail!("slug `{slug}` already in use");
                }
            }
            p.set_slug(slug);
        }
    }
    if let Some(d) = args.description {
        p.set_description(if d.is_empty() { None } else { Some(d) });
    }
    if let Some(content) = read_instructions_optional(args.instructions, args.instructions_file)? {
        p.set_instructions(content);
    }
    if let Some(tags) = args.tags {
        let parsed: Vec<String> = if tags.trim().is_empty() {
            Vec::new()
        } else {
            tags.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        };
        p.set_tags(parsed);
    }

    store.save(&p).await.map_err(boxed)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&project_json(&p))?);
    } else {
        println!("✓ updated project {} ({})", p.name, p.slug);
    }
    Ok(())
}

// ---------- delete / restore ----------

async fn delete(
    store: &dyn ProjectStore,
    cfg: &Config,
    target: &str,
    hard: bool,
) -> Result<()> {
    let p = lookup(store, target).await?;
    if !hard {
        store.archive(&p.id).await.map_err(boxed)?;
        eprintln!("✓ archived project {} ({})", p.name, p.slug);
        eprintln!("  use `jarvis project restore {}` to undo", p.slug);
        return Ok(());
    }
    // Hard delete — refuse if conversations are bound.
    if let Some(url) = pick_db_url(cfg) {
        let bundle = harness_store::connect_all(&url).await?;
        let bound = bundle
            .conversations
            .list_by_project(&p.id, 5)
            .await
            .map_err(boxed)?;
        if !bound.is_empty() {
            bail!(
                "{} conversation(s) still bound to `{}` — refuse to hard-delete. \
                 Archive instead, or unbind the conversations first.",
                bound.len(),
                p.slug,
            );
        }
    }
    let removed = store.delete(&p.id).await.map_err(boxed)?;
    if removed {
        eprintln!("✓ deleted project {} ({})", p.name, p.slug);
    } else {
        eprintln!("(project {} no longer existed)", p.slug);
    }
    Ok(())
}

async fn restore(store: &dyn ProjectStore, target: &str) -> Result<()> {
    let mut p = lookup(store, target).await?;
    if !p.archived {
        eprintln!("(project {} is not archived)", p.slug);
        return Ok(());
    }
    p.unarchive();
    store.save(&p).await.map_err(boxed)?;
    eprintln!("✓ restored project {} ({})", p.name, p.slug);
    Ok(())
}

// ---------- helpers ----------

async fn lookup(store: &dyn ProjectStore, target: &str) -> Result<Project> {
    if let Some(p) = store.load(target).await.map_err(boxed)? {
        return Ok(p);
    }
    if let Some(p) = store.find_by_slug(target).await.map_err(boxed)? {
        return Ok(p);
    }
    bail!("project `{target}` not found");
}

fn read_instructions(inline: Option<String>, file: Option<PathBuf>) -> Result<String> {
    let content = read_instructions_optional(inline, file)?
        .ok_or_else(|| anyhow!("must pass either --instructions or --instructions-file"))?;
    if content.trim().is_empty() {
        bail!("instructions must not be empty");
    }
    Ok(content)
}

fn read_instructions_optional(
    inline: Option<String>,
    file: Option<PathBuf>,
) -> Result<Option<String>> {
    if let Some(s) = inline {
        return Ok(Some(s));
    }
    if let Some(path) = file {
        let body = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        return Ok(Some(body));
    }
    Ok(None)
}

fn project_json(p: &Project) -> serde_json::Value {
    serde_json::json!({
        "id": p.id,
        "slug": p.slug,
        "name": p.name,
        "description": p.description,
        "instructions": p.instructions,
        "tags": p.tags,
        "archived": p.archived,
        "created_at": p.created_at,
        "updated_at": p.updated_at,
    })
}

fn boxed(e: harness_core::BoxError) -> anyhow::Error {
    anyhow!("{}", e)
}

//! REPL + pipe-mode entry points.
//!
//! The interactive runner mirrors the WS handler's three-channel
//! select pattern (`stdin lines`, `pending approvals`, `agent
//! events`) but writes to stdout instead of a WebSocket frame.
//! The flow per turn:
//!
//! 1. Print `> ` and read a prompt line (stdin task → mpsc).
//! 2. Build a fresh agent stream from the conversation.
//! 3. `tokio::select!`:
//!    - agent event → render to stdout (delta inline, tool start /
//!      end as bracketed status lines, approval request as a yes/no
//!      prompt).
//!    - `pending_rx` → stash the responder, gate the next stdin
//!      line as an approval reply.
//!    - stdin line → either an approval reply or (if no approval
//!      pending) a soft "wait for the model to finish" reminder.
//!    - `ctrl_c` → drop the stream, return to the outer prompt.
//!
//! The pipe runner short-circuits everything: read stdin to EOF,
//! run one turn with `AlwaysDeny`, print the assistant's final
//! text, exit.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use futures::StreamExt;
use harness_core::{
    Agent, AgentConfig, AgentEvent, AlwaysDeny, ApprovalDecision, Approver, ChannelApprover,
    Conversation, Message, PendingApproval, ToolRegistry,
};
use harness_tools::{register_builtins, BuiltinsConfig};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tracing::warn;

use crate::policy::{Policy, PolicyTable};
use crate::provider;
use crate::render::{bold, cyan, dim, green, red, yellow};
use crate::Args;

/// The system prompt mirrors `apps/jarvis::serve::CODING_SYSTEM_PROMPT`
/// — same contract, so the CLI and the server agent feel like the
/// same animal. Kept inline (not pulled from a shared crate) because
/// `apps/jarvis` and `apps/jarvis-cli` are siblings; promoting this
/// to a library would force a `harness-prompts` crate over one
/// const, which isn't worth it yet.
const CODING_SYSTEM_PROMPT: &str =
    "You are Jarvis, a coding agent working in the user's repository. \
Before editing, call workspace.context to orient yourself, then inspect git status. \
Do not overwrite user changes you did not make. \
Prefer code.grep, fs.read, fs.list, git.status, and git.diff before reaching for shell.exec. \
Use fs.edit (uniqueness-checked single replace) or fs.patch (unified-diff multi-hunk) for small \
reviewable edits; reach for fs.write only to create new files. \
When you run checks (tests, lints, builds), keep them focused on the change rather than the \
whole repo. \
End every coding turn with a short report: which files changed, which checks ran, which checks \
were skipped and why, and any residual risk you couldn't verify.";

/// Resolve the final system prompt: the coding template + (when not
/// opted out) the workspace's `AGENTS.md` / `CLAUDE.md` / `AGENT.md`
/// concatenated as project context + (when `--project` was passed) a
/// `=== project: <name> ===` block. Logged once per session so the
/// user knows what landed in the prompt.
fn resolve_system_prompt(args: &Args, workspace: &Path, project_prelude: Option<&str>) -> String {
    let mut prompt = CODING_SYSTEM_PROMPT.to_string();
    let no_ctx = args.no_project_context || std::env::var_os("JARVIS_NO_PROJECT_CONTEXT").is_some();
    if !no_ctx {
        let max_bytes = std::env::var("JARVIS_PROJECT_CONTEXT_BYTES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(32 * 1024);
        if let Some(extra) = harness_tools::workspace::load_instructions(workspace, max_bytes) {
            tracing::info!(
                bytes = extra.len(),
                "loaded project instructions (AGENTS.md / CLAUDE.md / AGENT.md)"
            );
            prompt.push_str("\n\n");
            prompt.push_str(&extra);
        }
    }
    if let Some(extra) = project_prelude {
        prompt.push_str("\n\n");
        prompt.push_str(extra);
    }
    prompt
}

/// Resolve the boot-time permission mode for the REPL. Order:
/// `--permission-mode` flag > `JARVIS_PERMISSION_MODE` env > Ask.
/// Bypass requires `--dangerously-skip-permissions`.
pub(crate) fn resolve_initial_mode(args: &Args) -> Result<harness_core::PermissionMode> {
    let raw = args
        .permission_mode
        .clone()
        .or_else(|| std::env::var("JARVIS_PERMISSION_MODE").ok());
    let mode = match raw.as_deref() {
        None => harness_core::PermissionMode::Ask,
        Some(s) => harness_core::PermissionMode::parse(s).ok_or_else(|| {
            anyhow::anyhow!("permission_mode=`{s}` not recognised; use ask / accept-edits / plan / auto / bypass")
        })?,
    };
    if matches!(mode, harness_core::PermissionMode::Bypass) && !args.dangerously_skip_permissions {
        anyhow::bail!("permission_mode=bypass requires --dangerously-skip-permissions");
    }
    Ok(mode)
}

/// Render a project's instructions block in the same `=== project: NAME ===`
/// envelope the server's `ProjectBinder` uses. Loaded once at startup
/// (CLI sessions are non-persistent — there's no notion of "edit the
/// project mid-session and have it propagate"; if you need that,
/// restart `jarvis-cli`).
pub(crate) async fn load_project_prelude(needle: &str) -> Result<String> {
    let url = std::env::var("JARVIS_DB_URL")
        .ok()
        .filter(|s| !s.is_empty());
    let url = url.ok_or_else(|| {
        anyhow::anyhow!(
            "--project requires JARVIS_DB_URL to be set so the project can be loaded from the store"
        )
    })?;
    let bundle = harness_store::connect_all(&url)
        .await
        .with_context(|| format!("opening db url `{url}`"))?;
    let store = bundle.projects;
    let project = if let Some(p) = store
        .load(needle)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
    {
        p
    } else if let Some(p) = store
        .find_by_slug(needle)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
    {
        p
    } else {
        anyhow::bail!("project `{needle}` not found in {url}");
    };
    if project.archived {
        anyhow::bail!("project `{needle}` is archived");
    }
    tracing::info!(project = %project.slug, "loaded project for CLI session");
    Ok(format!(
        "=== project: {} ===\n{}",
        project.name, project.instructions
    ))
}

fn build_tools(args: &Args, workspace: &Path) -> ToolRegistry {
    let cfg = BuiltinsConfig {
        fs_root: workspace.to_path_buf(),
        // The CLI defaults to "edits + patches on, write/shell off"
        // — strikes the right balance for a coding REPL: the model
        // can iterate on existing files (the common case) without
        // tripping over `fs.write`'s blunter semantics; opt-in
        // gates `--allow-fs-write` and `--allow-shell` cover the
        // rest. Approval-gated regardless of these defaults.
        enable_fs_edit: true,
        enable_fs_patch: true,
        enable_fs_write: args.allow_fs_write,
        enable_shell_exec: args.allow_shell,
        enable_git_read: !args.no_git_read,
        ..Default::default()
    };
    let mut tools = ToolRegistry::new();
    register_builtins(&mut tools, cfg);
    tools
}

/// Build the `(Agent, pending_rx)` pair for one turn. `pending_rx`
/// is fresh per turn so a denied approval from the previous turn
/// can't leak. `project_prelude` is the optional `=== project: NAME ===`
/// block resolved once at startup from `--project`.
fn build_agent(
    args: &Args,
    workspace: &Path,
    project_prelude: Option<&str>,
    permission_mode: harness_core::PermissionMode,
) -> Result<(Arc<Agent>, mpsc::Receiver<PendingApproval>)> {
    let (llm, model) = provider::build(&args.provider, args.model.clone())
        .context("provider construction failed")?;
    let tools = build_tools(args, workspace);
    let (channel_approver, pending_rx) = ChannelApprover::new(8);
    let approver: Arc<dyn Approver> = Arc::new(channel_approver);
    let prompt = resolve_system_prompt(args, workspace, project_prelude);
    let mut cfg = AgentConfig::new(model.clone())
        .with_system_prompt(prompt)
        .with_tools(tools)
        .with_approver(approver)
        .with_max_iterations(args.max_iterations);
    // Plan Mode: hide write/exec/network tools from the LLM
    // catalogue. The terminal `exit_plan` tool stays available
    // because it's `ToolCategory::Read`.
    if matches!(permission_mode, harness_core::PermissionMode::Plan) {
        use harness_core::ToolCategory;
        cfg = cfg.with_tool_filter(Arc::new(|t| matches!(t.category(), ToolCategory::Read)));
    }
    // Optional short-term memory.
    if let Some(tokens) = args.memory_tokens {
        let memory: Arc<dyn harness_core::Memory> = match args.memory_mode.as_str() {
            "summary" => Arc::new(harness_memory::SummarizingMemory::new(
                llm.clone(),
                model,
                tokens,
            )),
            _ => Arc::new(harness_memory::SlidingWindowMemory::new(tokens)),
        };
        cfg = cfg.with_memory(memory);
    }
    Ok((Arc::new(Agent::new(llm, cfg)), pending_rx))
}

// ============================================================
// Interactive REPL
// ============================================================

pub async fn run_repl(args: Args, workspace: PathBuf) -> Result<()> {
    let project_prelude = match &args.project {
        Some(needle) => Some(load_project_prelude(needle).await?),
        None => None,
    };

    print_banner(&args, &workspace);
    if let Some(prelude) = &project_prelude {
        // Show only the heading, not the full body — the heading
        // already names the project and the body lands in the system
        // prompt anyway.
        if let Some(first_line) = prelude.lines().next() {
            println!(
                "{}",
                dim(&format!("({first_line} loaded into system prompt)"))
            );
        }
    }

    let mut conv = Conversation::new();
    let mut policy = PolicyTable::new();
    let mut permission_mode = resolve_initial_mode(&args)?;
    println!(
        "{}",
        dim(&format!(
            "(permission mode: {} — switch with /mode <ask|accept-edits|plan|auto>)",
            permission_mode.as_str()
        ))
    );
    let mut stdout = tokio::io::stdout();
    let mut stdin_rx = spawn_stdin_reader();

    loop {
        // Read the next user line. None = EOF (Ctrl-D), exit cleanly.
        write_str(&mut stdout, &bold("> ")).await;
        let Some(line) = stdin_rx.recv().await else {
            println!();
            return Ok(());
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if matches!(line, "/quit" | "/exit") {
            return Ok(());
        }
        if line == "/reset" {
            conv = Conversation::new();
            println!("{}", dim("(conversation reset; session policy preserved)"));
            continue;
        }
        if line == "/policy" {
            print_policy(&policy);
            continue;
        }
        if let Some(rest) = line.strip_prefix("/mode") {
            let arg = rest.trim();
            if arg.is_empty() {
                println!(
                    "{}",
                    dim(&format!(
                        "current mode: {}; usage: /mode <ask|accept-edits|plan|auto>",
                        permission_mode.as_str()
                    ))
                );
                continue;
            }
            match harness_core::PermissionMode::parse(arg) {
                Some(harness_core::PermissionMode::Bypass) => {
                    eprintln!(
                        "{} bypass mode requires --dangerously-skip-permissions at startup",
                        red("✗")
                    );
                }
                Some(m) => {
                    permission_mode = m;
                    println!("{}", dim(&format!("(permission mode: {})", m.as_str())));
                }
                None => {
                    eprintln!(
                        "{} unknown mode `{arg}` — use ask / accept-edits / plan / auto",
                        red("✗")
                    );
                }
            }
            continue;
        }

        conv.messages.push(Message::user(line));

        // One agent build per turn — the `pending_rx` and the
        // agent's internal channel are both fresh, so denied
        // approvals or aborted turns don't leak state across turns.
        let (agent, pending_rx) = match build_agent(
            &args,
            &workspace,
            project_prelude.as_deref(),
            permission_mode,
        ) {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("{} {e:#}", red("✗"));
                continue;
            }
        };
        let outcome = run_one_turn(agent, &mut conv, pending_rx, &mut policy, &mut stdin_rx).await;
        match outcome {
            TurnOutcome::Done(updated) => {
                conv = updated;
            }
            TurnOutcome::Cancelled => {
                println!("{}", yellow("⤬ turn cancelled"));
                // Roll back the pending user message so the next
                // turn doesn't see a dangling user-without-reply,
                // which would confuse the model on the next prompt.
                if let Some(Message::User { .. }) = conv.messages.last() {
                    conv.messages.pop();
                }
            }
            TurnOutcome::Error(msg) => {
                println!("{} {msg}", red("✗"));
            }
        }
    }
}

enum TurnOutcome {
    Done(Conversation),
    Cancelled,
    Error(String),
}

async fn run_one_turn(
    agent: Arc<Agent>,
    conv: &mut Conversation,
    mut pending_rx: mpsc::Receiver<PendingApproval>,
    policy: &mut PolicyTable,
    stdin_rx: &mut mpsc::UnboundedReceiver<String>,
) -> TurnOutcome {
    let mut stream = agent.run_stream(conv.clone());
    let mut delta_open = false; // true while assistant text is streaming inline
    let mut awaiting: Option<PendingApproval> = None;

    loop {
        // Build the per-iteration "stdin needed?" future. Only valid
        // when we're awaiting an approval — outside that we let the
        // user type ahead but consume nothing (they'll get to type
        // when we return to the outer prompt).
        let want_stdin = awaiting.is_some();

        tokio::select! {
            biased;

            // ---- Ctrl-C: drop everything, return to outer prompt ----
            _ = tokio::signal::ctrl_c() => {
                drop(stream);
                if delta_open { println!(); }
                return TurnOutcome::Cancelled;
            }

            // ---- agent → stdout ----
            ev = stream.next() => {
                let Some(ev) = ev else {
                    // Stream ended without a Done event (shouldn't
                    // happen, but guard against it).
                    if delta_open { println!(); }
                    return TurnOutcome::Done(conv.clone());
                };
                match ev {
                    AgentEvent::Delta { content } => {
                        if !delta_open {
                            // First delta of an assistant turn —
                            // tag the speaker once, then stream.
                            print!("{} ", green("●"));
                            delta_open = true;
                        }
                        print!("{content}");
                        let _ = std::io::Write::flush(&mut std::io::stdout());
                    }
                    AgentEvent::AssistantMessage { .. } => {
                        if delta_open { println!(); delta_open = false; }
                    }
                    AgentEvent::ToolStart { name, arguments, .. } => {
                        if delta_open { println!(); delta_open = false; }
                        println!("{} {}{}",
                            cyan("⚙"),
                            cyan(&name),
                            dim(&format!(" {}", short_args(&arguments))));
                    }
                    AgentEvent::ToolProgress { stream: s, chunk, .. } => {
                        // shell.exec etc. — show stdout/stderr live.
                        let prefix = if s == "stderr" { red("│ ") } else { dim("│ ") };
                        for line in chunk.split_inclusive('\n') {
                            print!("{prefix}{line}");
                        }
                        let _ = std::io::Write::flush(&mut std::io::stdout());
                    }
                    AgentEvent::ToolEnd { content, .. } => {
                        // Truncate noisy tool output for the
                        // status line; the model still sees the
                        // whole thing.
                        let one_line = content.lines().next().unwrap_or("").trim();
                        let trimmed = if one_line.len() > 200 {
                            format!("{}…", &one_line[..200])
                        } else {
                            one_line.to_string()
                        };
                        println!("  {} {}", dim("→"), dim(&trimmed));
                    }
                    AgentEvent::ApprovalRequest { name, arguments, .. } => {
                        if delta_open { println!(); delta_open = false; }
                        println!("{} {} {}",
                            yellow("⚠"),
                            yellow(&format!("approve {name}?")),
                            dim(&short_args(&arguments)));
                        print!("{}", bold("  [y]es / [n]o / [a]lways / [d]eny-always > "));
                        let _ = std::io::Write::flush(&mut std::io::stdout());
                    }
                    AgentEvent::ApprovalDecision { decision, .. } => {
                        // Already printed "approved/denied" inline
                        // when we sent the response — nothing to do.
                        let _ = decision;
                    }
                    AgentEvent::PlanUpdate { items } => {
                        if delta_open { println!(); delta_open = false; }
                        println!("{} {}", cyan("☰"), cyan(&format!("plan ({} step{})",
                            items.len(),
                            if items.len() == 1 { "" } else { "s" })));
                        for item in &items {
                            let marker = match item.status {
                                harness_core::PlanStatus::Pending => "○",
                                harness_core::PlanStatus::InProgress => "◐",
                                harness_core::PlanStatus::Completed => "●",
                                harness_core::PlanStatus::Cancelled => "✕",
                            };
                            println!("    {marker} {}", item.title);
                        }
                    }
                    AgentEvent::Usage { .. } => {
                        // Surfaced via /policy / future usage badge;
                        // skip the noise inline.
                    }
                    AgentEvent::PlanProposed { plan } => {
                        if delta_open { println!(); delta_open = false; }
                        println!("{} {}", cyan("📋"), cyan("plan proposed"));
                        for line in plan.lines() {
                            println!("  {line}");
                        }
                        println!("{}", dim("  (Plan Mode: type a follow-up to refine, or /mode <ask|accept-edits|auto> to execute)"));
                    }
                    AgentEvent::SubAgentEvent { frame } => {
                        // Compact one-liner per subagent frame — the
                        // CLI is mostly used for solo debugging, so
                        // we surface enough to know "subagent X did
                        // tool Y" without burying the main stream.
                        // Web UI gets the full collapsible card +
                        // side-panel rendering.
                        if delta_open { println!(); delta_open = false; }
                        let label = format!("[subagent:{}]", frame.subagent_name);
                        match frame.event {
                            harness_core::SubAgentEvent::Started { task, .. } => {
                                println!("{} {}", dim(&label), task);
                            }
                            harness_core::SubAgentEvent::ToolStart { name, .. } => {
                                println!("{} → {}", dim(&label), name);
                            }
                            harness_core::SubAgentEvent::ToolEnd { name, .. } => {
                                println!("{} ← {}", dim(&label), name);
                            }
                            harness_core::SubAgentEvent::Status { message } => {
                                println!("{} {}", dim(&label), dim(&message));
                            }
                            harness_core::SubAgentEvent::Usage { .. } => {
                                // Accounted for by usage aggregation; keep
                                // the subagent trace readable in the CLI.
                            }
                            harness_core::SubAgentEvent::Done { final_message } => {
                                println!("{} ✓ {}", dim(&label), final_message);
                            }
                            harness_core::SubAgentEvent::Error { message } => {
                                println!("{} ✗ {}", dim(&label), message);
                            }
                            harness_core::SubAgentEvent::Delta { .. } => {
                                // Subagent text deltas go to the
                                // collapsible card; CLI skips them
                                // to keep the main stream readable.
                            }
                        }
                    }
                    AgentEvent::Done { conversation, .. } => {
                        if delta_open { println!(); }
                        return TurnOutcome::Done(conversation);
                    }
                    AgentEvent::Error { message } => {
                        if delta_open { println!(); }
                        return TurnOutcome::Error(message);
                    }
                }
            }

            // ---- approver → us ----
            // Auto-resolve via session policy or stash for the next
            // stdin line.
            Some(p) = pending_rx.recv(), if awaiting.is_none() => {
                match policy.lookup(&p.request.tool_name) {
                    Some(Policy::AlwaysAllow) => {
                        let _ = p.responder.send(ApprovalDecision::Approve);
                        println!("  {}", dim("(auto-approved by session policy)"));
                    }
                    Some(Policy::AlwaysDeny) => {
                        let _ = p.responder.send(ApprovalDecision::deny("session policy"));
                        println!("  {}", dim("(auto-denied by session policy)"));
                    }
                    None => {
                        awaiting = Some(p);
                    }
                }
            }

            // ---- stdin → approval reply ----
            // Only enabled when an approval is pending. Outside
            // that we leave stdin alone so the user can compose the
            // next prompt while the model is mid-stream (it'll be
            // consumed when we return to the outer prompt).
            Some(line) = stdin_rx.recv(), if want_stdin => {
                let pending = awaiting.take().unwrap();
                let tool_name = pending.request.tool_name.clone();
                let trimmed = line.trim().to_lowercase();
                let (decision, msg) = match trimmed.as_str() {
                    "y" | "yes" | "" => (ApprovalDecision::Approve, "approved".to_string()),
                    "a" | "always" => {
                        policy.set(&tool_name, Policy::AlwaysAllow);
                        (ApprovalDecision::Approve,
                         format!("approved (and always-allow {tool_name} for this session)"))
                    }
                    "d" | "deny-always" => {
                        policy.set(&tool_name, Policy::AlwaysDeny);
                        (ApprovalDecision::deny("session policy"),
                         format!("denied (and always-deny {tool_name} for this session)"))
                    }
                    _ => (ApprovalDecision::deny("user denied"), "denied".to_string()),
                };
                println!("  {} {}", dim("→"), dim(&msg));
                let _ = pending.responder.send(decision);
            }
        }
    }
}

// ============================================================
// Pipe mode (--no-interactive)
// ============================================================

pub async fn run_pipe(args: Args, workspace: PathBuf) -> Result<()> {
    let prompt = match args.prompt.clone() {
        Some(p) => p,
        None => {
            // Read all of stdin as the prompt.
            let mut buf = String::new();
            tokio::io::AsyncReadExt::read_to_string(&mut tokio::io::stdin(), &mut buf)
                .await
                .context("reading stdin for --no-interactive")?;
            buf
        }
    };
    let prompt = prompt.trim();
    if prompt.is_empty() {
        anyhow::bail!("--no-interactive needs a non-empty prompt (via --prompt or stdin)");
    }

    let project_prelude = match &args.project {
        Some(needle) => Some(load_project_prelude(needle).await?),
        None => None,
    };

    let permission_mode = resolve_initial_mode(&args)?;
    let (llm, model) = provider::build(&args.provider, args.model.clone())
        .context("provider construction failed")?;
    let tools = build_tools(&args, &workspace);
    // Pipe mode has no human approver. In `auto` / `bypass` it auto-
    // approves; in any other mode (or unset) it falls back to
    // `AlwaysDeny` so a gated tool surfaces the deny sentinel
    // ("tool denied: ...") and the model can adapt.
    let approver: Arc<dyn Approver> = match permission_mode {
        harness_core::PermissionMode::Auto | harness_core::PermissionMode::Bypass => {
            Arc::new(harness_core::AlwaysApprove)
        }
        _ => Arc::new(AlwaysDeny),
    };
    let system_prompt = resolve_system_prompt(&args, &workspace, project_prelude.as_deref());
    let mut cfg = AgentConfig::new(model)
        .with_system_prompt(system_prompt)
        .with_tools(tools)
        .with_approver(approver)
        .with_max_iterations(args.max_iterations);
    if matches!(permission_mode, harness_core::PermissionMode::Plan) {
        use harness_core::ToolCategory;
        cfg = cfg.with_tool_filter(Arc::new(|t| matches!(t.category(), ToolCategory::Read)));
    }
    let agent = Agent::new(llm, cfg);

    let mut conv = Conversation::new();
    conv.messages.push(Message::user(prompt));

    let outcome = agent.run(&mut conv).await.context("agent run")?;
    let _ = outcome;
    // Print the final assistant text — that's the contract for pipe
    // mode (`echo "..." | jarvis-cli --no-interactive | tee out.txt`).
    let last_text = conv
        .messages
        .iter()
        .rev()
        .find_map(|m| match m {
            Message::Assistant { content, .. } => content.clone(),
            _ => None,
        })
        .unwrap_or_default();
    println!("{last_text}");
    Ok(())
}

// ============================================================
// Stdin reader
// ============================================================
//
// We read stdin on a dedicated task and ship lines through an
// unbounded mpsc, so the main `tokio::select!` can sit on a regular
// channel `recv` without juggling AsyncBufReadExt internally. The
// tradeoff is that stdin is read continuously even when we're not
// expecting input — fine, the buffer holds a few lines without
// breaking a sweat, and the type-ahead is what makes the REPL feel
// snappy.

fn spawn_stdin_reader() -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut reader = BufReader::new(tokio::io::stdin());
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    if tx
                        .send(line.trim_end_matches(['\r', '\n']).to_string())
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    warn!(error = %e, "stdin read error");
                    break;
                }
            }
        }
    });
    rx
}

// ============================================================
// Small renderers
// ============================================================

fn print_banner(args: &Args, workspace: &Path) {
    let model_hint = args.model.as_deref().unwrap_or("(default)");
    eprintln!(
        "{} {} {} {} {} {}",
        bold("jarvis-cli"),
        dim("·"),
        cyan(&args.provider),
        dim("·"),
        dim(model_hint),
        dim(&format!("· {}", workspace.display())),
    );
    eprintln!(
        "{}",
        dim("type a prompt and Enter; /reset clears, /policy lists, /quit exits, Ctrl-C aborts the current turn.")
    );
}

fn print_policy(policy: &PolicyTable) {
    let _ = policy;
    // PolicyTable doesn't expose iter() — keep it simple, just say
    // "session policy table is in-memory; allow with `a`, deny with
    // `d` at any approval prompt". A future iter() can list it.
    println!(
        "{}",
        dim("session policy: type `a` at an approval prompt to always-allow that tool; `d` to always-deny.")
    );
}

fn short_args(value: &serde_json::Value) -> String {
    let s = value.to_string();
    if s.len() <= 80 {
        s
    } else {
        format!("{}…", &s[..80])
    }
}

async fn write_str(out: &mut tokio::io::Stdout, s: &str) {
    let _ = out.write_all(s.as_bytes()).await;
    let _ = out.flush().await;
}

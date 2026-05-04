// Stand-alone probe — sanity check that the ClaudeCode sidecar
// integration is wired correctly against the host's Node + SDK.
// Run with: `cargo run -p harness-subagents --example probe`.
use harness_subagents::claude_code::probe;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    match probe("node").await {
        Ok(()) => println!("PROBE OK: SDK importable on this host"),
        Err(e) => println!("PROBE NOT-OK: {e}"),
    }
    match probe("/no/such/binary").await {
        Ok(()) => println!("BAD: missing binary should have failed"),
        Err(e) => println!("missing-bin path: {e}"),
    }
}

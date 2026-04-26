// Make `cargo build` self-contained even on fresh checkouts where
// the web frontend hasn't been built yet.
//
// `src/ui.rs` uses `include_dir!("...apps/jarvis-web/dist")` which
// is a proc macro — it panics at compile time if the directory
// doesn't exist. That's a sharp edge for new contributors (and
// CI workflows that don't know to run `npm run build` first), so
// we plant a minimal placeholder here.
//
// Real production builds run the Vite build *before* cargo and
// overwrite this stub with the real bundle. The placeholder just
// keeps `cargo build` from exploding when nobody has.

use std::fs;
use std::path::{Path, PathBuf};

const PLACEHOLDER_HTML: &str = r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Jarvis (frontend not built)</title></head>
<body style="font-family:system-ui;padding:2em;max-width:40em;margin:auto">
<h1>Jarvis web UI not built</h1>
<p>This binary was compiled without the frontend bundle. Run:</p>
<pre style="background:#f4f4f4;padding:1em;border-radius:6px">cd apps/jarvis-web &amp;&amp; npm install &amp;&amp; npm run build</pre>
<p>then rebuild the server with <code>cargo build --release -p jarvis</code>.</p>
<p>The HTTP API (<code>/v1/chat/completions</code>, WebSocket
<code>/v1/chat/ws</code>, <code>/v1/conversations</code>) works without the UI.</p>
</body></html>
"#;

fn main() {
    // `apps/jarvis-web/dist` relative to this build.rs (which lives
    // alongside `Cargo.toml`).
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let dist: PathBuf = Path::new(&manifest_dir).join("../../apps/jarvis-web/dist");

    // Cargo should rerun build.rs whenever the dist tree changes —
    // include_dir!() doesn't track the dir's contents on its own.
    println!("cargo:rerun-if-changed={}", dist.display());

    // If the user has already produced a real build (index.html
    // present), don't touch it. `include_dir!` will pick it up as-is.
    let index = dist.join("index.html");
    if index.is_file() {
        return;
    }

    // Otherwise plant the placeholder so the macro has something to
    // include. `create_dir_all` is idempotent.
    if let Err(e) = fs::create_dir_all(&dist) {
        // Don't fail the build over the placeholder — re-emit a
        // warning Cargo shows in `--verbose`.
        println!("cargo:warning=could not create {}: {e}", dist.display());
        return;
    }
    if let Err(e) = fs::write(&index, PLACEHOLDER_HTML) {
        println!("cargo:warning=could not write {}: {e}", index.display());
    }
}

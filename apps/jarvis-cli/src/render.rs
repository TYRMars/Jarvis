//! Tiny ANSI helpers — TTY detection + a handful of named colours.
//!
//! Deliberately no `colored` / `owo-colors` dependency: the CLI's
//! styling needs are basic (one colour per event type) and adding a
//! crate just to write `\x1b[...m` is overkill. Detection uses the
//! stdlib's `IsTerminal` (stable since 1.70) so a pipe redirects
//! cleanly to plain text.

use std::io::IsTerminal;
use std::sync::OnceLock;

static USE_COLOR: OnceLock<bool> = OnceLock::new();

/// Whether stdout is attached to a terminal. Cached after the first
/// call so the cost of `IsTerminal` is one syscall per process.
/// `NO_COLOR` (https://no-color.org) overrides — set to anything to
/// force plain text even on a tty.
pub fn use_color() -> bool {
    *USE_COLOR.get_or_init(|| {
        if std::env::var_os("NO_COLOR").is_some() {
            return false;
        }
        std::io::stdout().is_terminal()
    })
}

fn wrap(code: &str, text: &str) -> String {
    if use_color() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

pub fn dim(s: &str) -> String {
    wrap("2", s)
}
pub fn bold(s: &str) -> String {
    wrap("1", s)
}
pub fn cyan(s: &str) -> String {
    wrap("36", s)
}
pub fn green(s: &str) -> String {
    wrap("32", s)
}
pub fn yellow(s: &str) -> String {
    wrap("33", s)
}
pub fn red(s: &str) -> String {
    wrap("31", s)
}

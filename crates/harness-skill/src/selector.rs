//! Auto-activation scorer.
//!
//! Picks the top-K skills (by relevance to the user's most recent
//! message) for which `activation` is `auto` or `both`. The score
//! is intentionally cheap — just keyword + description-token
//! overlap, no LLM round-trip — so it's safe to run on every turn.
//! A future flag (Phase 4b) can swap in an LLM-based selector if
//! the heuristic isn't sharp enough; the call shape stays the same.

use std::collections::HashSet;

use crate::catalog::SkillCatalog;
use crate::manifest::SkillActivation;

const KEYWORD_WEIGHT: usize = 4;
const DESC_TOKEN_WEIGHT: usize = 1;
const NAME_TOKEN_WEIGHT: usize = 2;
const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "have", "from", "you", "use",
    "are", "is", "to", "a", "of", "in", "on", "or", "an", "be", "it", "at",
    "as", "we",
];

/// Score one skill against a query string. Higher = better match.
/// Skills not eligible for auto-activation score 0 unconditionally.
pub fn score_skill(
    name: &str,
    description: &str,
    keywords: &[String],
    activation: SkillActivation,
    query_tokens: &HashSet<String>,
) -> usize {
    if matches!(activation, SkillActivation::Manual) {
        return 0;
    }
    let mut score = 0usize;

    // Keyword hits dominate — these are the curator's signal.
    for kw in keywords {
        if kw.is_empty() {
            continue;
        }
        let kw_lc = kw.to_lowercase();
        // Multi-word keywords match if every word is in the query.
        let parts: Vec<&str> = kw_lc.split_whitespace().filter(|p| !p.is_empty()).collect();
        if !parts.is_empty() && parts.iter().all(|p| query_tokens.contains(*p)) {
            score = score.saturating_add(KEYWORD_WEIGHT);
        }
    }

    // Name-token overlap (e.g. `pdf-helper` ⇒ tokens `pdf`,
    // `helper` — query containing "pdf" gets a small bump).
    for tok in tokenize(name) {
        if STOPWORDS.contains(&tok.as_str()) {
            continue;
        }
        if query_tokens.contains(&tok) {
            score = score.saturating_add(NAME_TOKEN_WEIGHT);
        }
    }

    // Description tokens contribute weakly. Drop stopwords +
    // 1-char tokens so "the" / "a" / "to" don't inflate scores.
    for tok in tokenize(description) {
        if tok.len() <= 1 || STOPWORDS.contains(&tok.as_str()) {
            continue;
        }
        if query_tokens.contains(&tok) {
            score = score.saturating_add(DESC_TOKEN_WEIGHT);
        }
    }

    score
}

/// Pick at most `top_k` skills from `catalog` whose
/// auto-activation is permitted, ranked by [`score_skill`] against
/// `query`. `exclude` lets the caller hide names that are already
/// active manually (so the auto layer doesn't re-emit them).
///
/// Returns names in descending-score order; ties break by name to
/// keep output stable across processes. Skills with score 0 are
/// dropped — we don't want to shovel context into the LLM that has
/// nothing to do with the query.
pub fn pick_auto_skills(
    catalog: &SkillCatalog,
    query: &str,
    top_k: usize,
    exclude: &[String],
) -> Vec<String> {
    if top_k == 0 || query.trim().is_empty() {
        return Vec::new();
    }
    let exclude_set: HashSet<&str> = exclude.iter().map(String::as_str).collect();
    let query_tokens = query_token_set(query);
    let mut scored: Vec<(usize, String)> = Vec::new();
    for entry in catalog.entries() {
        let name = &entry.manifest.name;
        if exclude_set.contains(name.as_str()) {
            continue;
        }
        let s = score_skill(
            name,
            &entry.manifest.description,
            &entry.manifest.keywords,
            entry.manifest.activation,
            &query_tokens,
        );
        if s > 0 {
            scored.push((s, name.clone()));
        }
    }
    // Sort: score desc, then name asc for stable order.
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().take(top_k).map(|(_, n)| n).collect()
}

/// Token set for one query string. Lowercased, alpha-numeric runs
/// only, stopwords removed. Public so callers that want to score
/// against the same set multiple times can build it once.
pub fn query_token_set(s: &str) -> HashSet<String> {
    tokenize(s)
        .into_iter()
        .filter(|t| t.len() > 1 && !STOPWORDS.contains(&t.as_str()))
        .collect()
}

fn tokenize(s: &str) -> Vec<String> {
    let s = s.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            cur.push(ch);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{SkillCatalog, SkillEntry, SkillSource};
    use crate::manifest::SkillManifest;
    use std::path::PathBuf;

    fn entry(name: &str, desc: &str, keywords: &[&str], activation: SkillActivation) -> SkillEntry {
        SkillEntry {
            manifest: SkillManifest {
                name: name.to_string(),
                description: desc.to_string(),
                license: None,
                allowed_tools: vec![],
                activation,
                keywords: keywords.iter().map(|s| s.to_string()).collect(),
                version: None,
            },
            body: format!("body of {name}"),
            path: PathBuf::from(format!("/dev/{name}")),
            source: SkillSource::Workspace,
        }
    }

    #[test]
    fn scores_zero_for_manual_activation() {
        let q = query_token_set("pdf invoice");
        let s = score_skill("pdf-helper", "PDFs.", &["pdf".into()], SkillActivation::Manual, &q);
        assert_eq!(s, 0);
    }

    #[test]
    fn keyword_dominates_description_tokens() {
        let q = query_token_set("pdf in the document");
        let with_keyword =
            score_skill("a", "x", &["pdf".into()], SkillActivation::Auto, &q);
        let only_desc =
            score_skill("b", "pdf is mentioned here", &[], SkillActivation::Auto, &q);
        assert!(with_keyword > only_desc, "keyword weight should dominate");
    }

    #[test]
    fn picks_top_k_in_score_order() {
        let mut cat = SkillCatalog::new();
        cat.insert(entry("pdf-helper", "Read PDF files.", &["pdf"], SkillActivation::Both));
        cat.insert(entry("code-review", "Review diffs.", &["review", "diff", "pr"], SkillActivation::Both));
        cat.insert(entry("manual-only", "Should not auto.", &["pdf"], SkillActivation::Manual));

        let picks = pick_auto_skills(&cat, "Can you review my PR diff?", 2, &[]);
        assert_eq!(picks, vec!["code-review".to_string()]);

        let picks = pick_auto_skills(&cat, "summarise this pdf for me", 2, &[]);
        assert_eq!(picks, vec!["pdf-helper".to_string()]);

        // Manual-only skill must not be picked even if relevant.
        assert!(!picks.contains(&"manual-only".to_string()));
    }

    #[test]
    fn exclude_filters_already_active_skills() {
        let mut cat = SkillCatalog::new();
        cat.insert(entry("pdf-helper", "PDF.", &["pdf"], SkillActivation::Auto));
        let picks =
            pick_auto_skills(&cat, "pdf please", 2, &["pdf-helper".to_string()]);
        assert!(picks.is_empty());
    }

    #[test]
    fn empty_query_picks_nothing() {
        let mut cat = SkillCatalog::new();
        cat.insert(entry("pdf-helper", "PDF.", &["pdf"], SkillActivation::Auto));
        let picks = pick_auto_skills(&cat, "   ", 2, &[]);
        assert!(picks.is_empty());
    }

    #[test]
    fn zero_score_skills_are_dropped() {
        let mut cat = SkillCatalog::new();
        cat.insert(entry("nope", "Totally unrelated.", &["sailboat"], SkillActivation::Auto));
        let picks = pick_auto_skills(&cat, "review my code", 2, &[]);
        assert!(picks.is_empty(), "should not pick skills that don't match at all");
    }

    #[test]
    fn ties_break_by_name() {
        let mut cat = SkillCatalog::new();
        cat.insert(entry("zebra", "review!", &["review"], SkillActivation::Auto));
        cat.insert(entry("alpha", "review!", &["review"], SkillActivation::Auto));
        let picks = pick_auto_skills(&cat, "code review please", 2, &[]);
        assert_eq!(picks, vec!["alpha".to_string(), "zebra".to_string()]);
    }
}

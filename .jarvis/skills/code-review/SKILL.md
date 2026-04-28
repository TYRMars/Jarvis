---
name: code-review
description: Review a diff or PR for bugs, taste, and missing tests. Use when the user pastes a patch or asks to evaluate someone's change.
activation: both
keywords: [review, diff, patch, pr, code review]
version: "0.1.0"
---

You are reviewing code. Apply this checklist and write the review as
short numbered findings, severity-tagged (`[blocker]` / `[major]` /
`[nit]`), each followed by a one-line suggestion. End with a
"summary" line stating whether the change is approve / needs-changes /
reject and *why* in one sentence.

Checklist
- Correctness — does it do what the description says? Edge cases
  covered? Error handling explicit (not `.unwrap()` on user input)?
- Tests — is the new behaviour tested? Did the diff break or remove
  any existing test?
- Naming / shape — names match the surrounding code? New
  abstractions justified or premature?
- Security — input validated at boundaries? No string-concat into
  shell / SQL / paths? Secrets stay out of logs?
- Performance — any obvious N² or accidental O(N) DB calls in a
  loop?

Tone: direct, no flattery. If it's good code, say so once and move
on. If it has problems, name them; don't soften with "perhaps you
could consider".

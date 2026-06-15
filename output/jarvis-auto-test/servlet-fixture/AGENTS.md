# servlet-fixture — Jarvis auto-mode test target

This is a deliberately broken Java Servlet 3.1 project used to exercise
Jarvis's project-automation surface (Requirement kanban + auto-loop +
verification + diagnostics).

## Goal of the harness test

1. `triage.scan_candidates` walks the source tree and surfaces the `TODO`
   marker plus any other read-only signals.
2. The agent (or `roadmap.import`) writes one Requirement per defect into
   the Triage queue (`triage_state = ProposedByAgent` / `ProposedByScan`).
3. A human (or the harness on their behalf) calls
   `POST /v1/requirements/:id/approve` on each — auto-loop refuses to pick
   them up until then.
4. Auto-loop picks each Approved row, drives the agent loop, and the
   verification plan (Maven build + OWASP dep-check) decides Pass/Fail.
5. The harness watches `/v1/diagnostics/runs/*` after each iteration; if
   any row is stuck or has burnt its retry budget, the test loop stops
   and the operator is paged.

## Seeded defects (one Requirement each)

| ID                 | Defect                                    | File                          | Plan                     |
|--------------------|-------------------------------------------|-------------------------------|--------------------------|
| `srv-sql-injection`| Concatenated SQL → injection              | `LoginServlet.java:34`        | `mvn verify` + sqlmap    |
| `srv-xss-reflected`| Raw `username` written to response        | `LoginServlet.java:42`        | OWASP ZAP baseline       |
| `srv-secret-leak`  | DB password hardcoded in source           | `LoginServlet.java:18`        | `grep -RE 'hunter2'` (none) |
| `srv-resource-leak`| `Connection/Statement/ResultSet` not closed| `LoginServlet.java:31-48`    | `mvn spotbugs:check`     |
| `srv-error-leak`   | Exception message echoed into response    | `LoginServlet.java:52`        | unit test on error path  |

## Not in the harness test (scoped out)

- Real network calls — the fixture does not run during this scheduled task.
- Mutating Jarvis stores — no API key, no server, no writes.

# Security findings

This repository is public. A pre-fix security finding is a live exploit path, so pentest output
never lands in git: run directories are gitignored and stay on the authoring machine.

- Runbook: [docs/operations/security-pentest.md](../operations/security-pentest.md)
- `runs/<date>/` — one directory per pentest run: parent report, tracker, and
  `findings/F-###-*.md` children. Gitignored; never committed.
- `ledger.md` — created after the first fix lands: one committed line per finding (id, severity,
  violated section, fix pull request). The fix pull request carries the full evidence, public
  exactly when it stops being true.

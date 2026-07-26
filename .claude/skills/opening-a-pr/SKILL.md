---
name: opening-a-pr
description: How to open and merge a pull request in fidy-ai. Use whenever you are about to create a PR, write a commit or PR title, or merge to trunk — covers the commit/PR-title convention, scope allowlist, and merge conditions.
---

# Opening a PR

All changes reach `trunk` through a squash-merged PR. Direct pushes to `trunk` are blocked.

## 1. Branch and commit

- Branch off `trunk`: `git checkout -b <type>/<short-name> trunk`.
- Commit with the convention (enforced by the commit-msg hook): a `type(scope): summary` header, then `- ` bullet body lines only. Trailers (`Co-Authored-By`, etc.) are rejected.
  - **type** and **scope** come from the allowlist published in README.md's "Commit convention"
    section, which the hooks and the `PR Title` check parse directly. Read it there rather than
    from a copy here — a copy is exactly what drifts. The scope is the slice the change lands in
    (ARCHITECTURE.md §2); cross-cutting scopes are only for work that belongs to no slice.
  - Print the current list without leaving the terminal:
    `bun scripts/check-commit-message.ts /dev/null`

## 2. Create the PR

- **Title** must follow `type(scope): summary` — the `PR Title` CI check enforces it, because the squashed `trunk` subject is taken from the PR title.
- **Body**: short `- ` bullets only, same terse style as commit bodies. No `What/Why` headings, no prose paragraphs.
- `gh pr create --base trunk --title "type(scope): summary" --body "..."` (heredoc for the bullets).

## 3. Conditions to merge

- All required checks pass. The `Required Checks` job fans in on: `pr-title`, `lint`, `format`, `typecheck`, `security-secrets`, `security-sast`, `security-sca`.
- **0 approvals required** — solo self-merge is allowed.
- **Squash only**: `gh pr merge <n> --squash --delete-branch`. Merge commits and rebase are disabled.
- Resulting `trunk` commit reads `type(scope): summary (#N)`.

## 4. After merge

- Sync local trunk: `git checkout trunk && git pull --ff-only`.

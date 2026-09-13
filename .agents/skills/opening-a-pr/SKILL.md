---
name: opening-a-pr
description: How to open, validate, and merge a pull request in fidy-ai. Use when creating or updating a PR, waiting for CI, writing a commit or PR title, or merging to trunk — covers the commit/PR-title convention, scope allowlist, CI observation, and merge conditions.
---

# Opening a PR

All changes reach `trunk` through a squash-merged PR. Direct pushes to `trunk` are blocked.

## 1. Sync with trunk

- Rebase onto the latest remote trunk: `git pull --rebase origin trunk`.

## 2. Branch and commit

- Branch off `trunk`: `git checkout -b <type>/<short-name> trunk`.
- Commit with the convention (enforced by the commit-msg hook): a `type(scope): summary` header, then `- ` bullet body lines only. Trailers (`Co-Authored-By`, etc.) are rejected.
  - **type** and **scope** come from the allowlist published in README.md's "Commit convention"
    section, which the hooks and the `PR Title` check parse directly. Read it there rather than
    from a copy here — a copy is exactly what drifts. For server domain work, use the owning slice
    (`apps/server/ARCHITECTURE.md` §2); otherwise use the matching cross-cutting scope.
  - Print the current list without leaving the terminal:
    `bun scripts/check-commit-message.ts /dev/null`

## 3. Create the PR

- **Title** must follow `type(scope): summary` — the `PR Title` CI check enforces it, because the squashed `trunk` subject is taken from the PR title.
- **Body**: short `- ` bullets only, same terse style as commit bodies. No `What/Why` headings, no prose paragraphs.
- `gh pr create --base trunk --title "type(scope): summary" --body "..."` (heredoc for the bullets).

## 4. Wait for CI

After creating the PR, capture its number and hand CI observation to GitHub CLI's built-in watcher:

```sh
PR_NUMBER=$(gh pr view --json number --jq .number)
gh pr checks "$PR_NUMBER" --watch --interval 60 --fail-fast
```

Watch every check attached to the PR: the fail-closed `Required Checks` job may not exist until its
parallel jobs finish, so filtering to `--required` can report no checks while CI is still running.
This is one foreground wait: `--watch` owns the refresh loop, and the 60-second interval avoids hot
polling while keeping completion reasonably prompt. Keep the watcher running until it exits; the
completion criterion is exit code 0. After every push that changes the PR head, run it again. CI
waiting is delegated to this command rather than a `sleep` loop or repeated manual status checks.

If it exits non-zero, inspect the terminal verdicts and the focused failing job, then fix, commit,
push, and restart the watcher:

```sh
gh pr checks "$PR_NUMBER" --json name,state,bucket,link
```

## 5. Conditions to merge

- The CI watcher exited 0. The fail-closed `Required Checks` job aggregates the parallel static,
  build, unit, integration, acceptance, quality, production-image, and provider-hosted security jobs;
  every dependency must report `success`. Read the failing sibling job for its focused verdict.
- **0 approvals required** — solo self-merge is allowed.
- **Squash only**: `gh pr merge <n> --squash --delete-branch`. Merge commits and rebase are disabled.
- Resulting `trunk` commit reads `type(scope): summary (#N)`.

## 6. After merge

- Sync local trunk: `git checkout trunk && git pull --ff-only`.

---
name: opening-a-pr
description: "Create or update fidy-ai PRs, write commit titles, observe CI, and merge under repository conventions."
metadata:
  source:
    author: Matt Pocock
    url: "https://github.com/mattpocock/skills/tree/main/skills/in-progress/pr"
    license: MIT
  credits:
    skill: show-me
    author: Dex Horthy
    organisation: Humanlayer
    url: "https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md"
---

# Opening a PR

All changes reach `trunk` through a squash-merged PR. Direct pushes to `trunk` are blocked.

## 1. Sync with trunk

- Inspect the current branch and working tree. Fetch the latest remote trunk; synchronize the task branch when needed without discarding unrelated work.

## 2. Branch and commit

- Reuse the task branch. For new work without a task branch, create one from the intended base using `<type>/<short-name>`.
- Commit with the convention (enforced by the commit-msg hook): a `type(scope): #123 summary` header, then `- ` bullet body lines only. Put the originating GitHub issue number immediately after the colon, without parentheses. Trailers (`Co-Authored-By`, etc.) are rejected.
  - **type** and **scope** come from the allowlist published in CODING_STANDARDS.md's "Commit messages"
    section, which the hooks and the `PR Title` check parse directly. Read it there rather than
    from a copy here — a copy is exactly what drifts. For server domain work, use the owning slice
    (`apps/server/ARCHITECTURE.md` §2); otherwise use the matching cross-cutting scope.
  - `#123` links the commit to issue #123 but does not close it. Add `- Fixes #123` to the commit body or PR description when the work resolves that issue.
  - Print the current list without leaving the terminal:
    `bun scripts/check-commit-message.ts /dev/null`

## 3. Create the PR

- **Title** must follow `type(scope): #123 summary` with the originating issue reference — the `PR Title` CI check enforces it, because the squashed `trunk` subject is taken from the PR title.
- **Body** must follow the template and guidance below.
- Create it with `gh pr create --base trunk --title "type(scope): #123 summary" --body-file - <<'EOF`, followed by the body and a closing `EOF`.

For PR creation or body updates, read [PR-BODY.md](PR-BODY.md) for the required template and evidence.

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

Merge when the user’s request includes merging; a request to create a PR ends with a validated PR.

- The CI watcher exited 0. The fail-closed `Required Checks` job aggregates the parallel static,
  build, unit, integration, acceptance, quality, production-image, and provider-hosted security jobs;
  every dependency must report `success`. Read the failing sibling job for its focused verdict.
- **0 approvals required** — solo self-merge is allowed.
- **Squash only**: `gh pr merge <n> --squash --subject "$(gh pr view <n> --json title --jq .title)" --delete-branch`. Merge commits and rebase are disabled; the explicit subject prevents a pull-request number from being appended.
- Resulting `trunk` commit reads exactly `type(scope): #123 summary`.

## 6. After merge

- Sync local trunk: `git checkout trunk && git pull --ff-only`.

---
name: update-repos
description: Update the vendored Effect or Alchemy upstream source checkouts. Use when asked to refresh either `.repos/effect` or `.repos/alchemy`.
disable-model-invocation: true
---

# Update repositories

1. Select every requested checkout from this table:

   | checkout | prefix           | remote             | branch |
   | -------- | ---------------- | ------------------ | ------ |
   | Effect   | `.repos/effect`  | `effect-upstream`  | `main` |
   | Alchemy  | `.repos/alchemy` | `alchemy-upstream` | `main` |

2. Record pre-existing changes and make the worktree clean before running `git subtree`.

3. For each selected checkout, fetch its remote branch and update the subtree:

   ```bash
   git fetch <remote> <branch>
   git subtree pull --prefix=<prefix> <remote> <branch> --squash
   ```

4. Restore any pre-existing changes, then verify for every selected checkout:

   ```bash
   git merge-base --is-ancestor <remote>/<branch> HEAD
   ```

   The command must exit non-zero because a squashed subtree does not make upstream history an ancestor. Confirm `git status` contains only the subtree updates plus the recorded pre-existing changes.

Complete only when every requested checkout satisfies both verification conditions.

---
name: update-repos
description: Update the vendored Effect, Alchemy, or Foldkit upstream source checkouts. Use when asked to refresh `.repos/effect`, `.repos/alchemy`, or `.repos/foldkit`.
disable-model-invocation: true
---

# Update repositories

1. Select every requested checkout from this table:

   | checkout | prefix           | remote             | URL                                        | branch |
   | -------- | ---------------- | ------------------ | ------------------------------------------ | ------ |
   | Effect   | `.repos/effect`  | `effect-upstream`  | https://github.com/Effect-TS/effect.git      | `main` |
   | Alchemy  | `.repos/alchemy` | `alchemy-upstream` | https://github.com/alchemy-run/alchemy.git  | `main` |
   | Foldkit  | `.repos/foldkit` | `foldkit-upstream` | https://github.com/foldkit/foldkit.git      | `main` |

   Inspect `git remote -v`. Add a missing remote with `git remote add <remote> <URL>`;
   resolve a mismatched URL before fetching. Remotes are local Git configuration and do not
   travel with the checked-in subtree.

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

   The command must exit non-zero because a squashed subtree does not make upstream history an ancestor.
   Verify the tracked subtree content matches the fetched source:

   ```bash
   git diff --exit-code HEAD:<prefix> <remote>/<branch>^{tree}
   ```

   Confirm `git status` contains only the recorded pre-existing changes. A subtree pull commits
   its update. For a new checkout, use `git subtree add --prefix=<prefix> <remote> <branch> --squash`
   instead of `pull`, then run the same verification.

5. Check the selected source map in `.patterns/INDEX.md` and its linked pattern. Record any
   version mismatch between upstream main and the installed package; the installed package
   remains the authority for APIs used by application code. For Foldkit, inspect
   `packages/foldkit/src/`, `packages/ui/src/`, and `examples/` as applicable.

Complete only when every requested checkout satisfies both verification conditions.

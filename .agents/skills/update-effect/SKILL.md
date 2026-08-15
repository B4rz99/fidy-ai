---
name: update-effect
description: Safely update the vendored Effect source.
disable-model-invocation: true
---

# Update Effect

1. Fetch `effect-upstream/main`, then run:

   ```bash
   git subtree pull --prefix=.repos/effect effect-upstream main --squash
   ```

2. Verify `git merge-base --is-ancestor effect-upstream/main HEAD` exits non-zero and `git status` contains only the intended subtree update plus pre-existing changes.

Complete only when Effect's upstream history is not an ancestor of `HEAD`.

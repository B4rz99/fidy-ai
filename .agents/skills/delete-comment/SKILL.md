---
name: delete-comment
description: Run the next comment cleanup pass in fidy-ai, classify comments, and shrink the comment lint baseline.
---

# Delete comments

1. Run `bun run lint:comments --inventory` to locate parsed comments. Use any
   paths named in the request. Inspect other source formats with their own
   syntax tools. Exclude `.repos/`.
2. Read the code around each comment and trace the use or verify the claimed
   constraint before acting.
   - **Tautology** repeats what the code shows. Delete it.
   - **Stale** describes an obsolete implementation or constraint. Verify the
     current behavior, then delete it.
   - **Excuse** rationalizes a repairable workaround. Find the matching issue
     or file one with the affected code, observable problem, and completion
     criteria. Follow [the issue tracker workflow](../../../docs/agents/issue-tracker.md),
     then delete the comment.
   - **Decision Record** explains a durable, non-obvious choice. Add the rationale
     to the owning ADR or create one in [docs/adr](../../../docs/adr/) using the
     [ADR format](../domain-modeling/ADR-FORMAT.md), then remove the inline prose.
3. Treat compiler, generator, test, bundler and coverage directives, executable
   JSDoc, and license notices as behavior or legal obligations. Keep any such
   comment in the baseline until an equivalent permitted representation exists.
   Check the generator when the comment is in generated source.
4. Run `bun run lint:comments --prune`, then `bun run lint:comments`. Verify
   affected behavior and artifacts. Report the counts by category, issue and ADR
   links, comment-only lines removed, and the portion still awaiting review.

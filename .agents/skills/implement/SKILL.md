---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
---

Implement the work described by the user in the spec or tickets.

Use $tdd where possible, at pre-agreed seams.

Continue typechecking regularly and run only the focused test files that cover the changed behaviour. After the first implementation slice, run `bun run lint:type-aware` before expanding the change. Fix any failures before continuing, then rerun it after the final edit. Do not hand off for review while lint or focused tests fail.

Once done, use $code-review to review the work.

Commit your work to the current branch.

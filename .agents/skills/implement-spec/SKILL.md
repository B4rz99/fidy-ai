---
name: implement-spec
description: "Implement an approved spec across its ticket graph on one integration branch."
disable-model-invocation: true
---

The user has provided an approved spec and its implementation tickets. The goal is the **whole spec on one integration branch**, with each ticket resolved according to this repository's issue-tracker workflow.

The tickets form a task graph, not a checklist: only tickets whose blockers are complete are ready. Keep the integration branch as the shared line of work and give every implementer an isolated worktree.

## Preconditions

- Read `docs/agents/issue-tracker.md` for the tracker's source of truth and blocking-edge operations.
- Read the spec and every ticket's full body and comments. Confirm the parent-child relationships, acceptance criteria, blocking edges, and current ticket states.
- If the graph, ticket criteria, or pre-agreed test seams are missing or contradictory, stop and ask the user rather than inventing them.
- This flow delegates workers that edit files. Check `test "${HERDR_ENV:-}" = 1` before creating branches or dispatching work. If it fails, stop and report that this flow requires Herdr; do not fall back to in-process agents or shared-checkout workers.
- Check the working tree before branching. Preserve existing user changes; if they would interfere with an integration branch, ask how to proceed.

## Steps

1. **Understand the graph.** Identify the spec's tickets, their blockers, acceptance criteria, and any shared files or module boundaries. Use the tracker instructions to determine the live frontier: open, unblocked tickets that are available to claim. Do not start blocked or already-claimed tickets.

2. **Create the integration branch.** Branch from the latest `trunk`, unless the user supplied another base. Record the base commit for the final review. Keep all integration work on this branch; do not merge it to `trunk` here.

3. **Dispatch ready tickets.** Start one background implementer per ready ticket, each in its own Herdr worktree and branch based on the current integration branch tip. Use `/herdr` for the installed CLI workflow and returned worktree/pane IDs. Keep concurrent work bounded when tickets touch the same files or shared design seam; serialize overlapping work rather than inviting avoidable conflicts.

   Each implementer must:
   - Verify that its clean worktree is based on the integration branch tip before editing. If it is not, bring it up to date without discarding work; stop and report any unexpected existing changes.
   - Read `.agents/skills/tdd/SKILL.md` and implement the ticket in vertical red-green slices at the seams already approved in the spec. `/tdd` is user-invoked in this repo, so follow its documented process directly rather than attempting to invoke it from the worker. If the seam is not approved, pause for the user rather than inventing one.
   - Run the focused tests for changed behavior and the relevant typecheck/build commands. Follow the repository's `CONTEXT.md`, architecture, coding, and security instructions.
   - Commit the ticket work using this repository's commit convention.
   - Merge the latest integration branch tip into its own branch before reporting completion. Resolve conflicts against the spec and both tickets' intent; do not choose a side mechanically.
   - Report the ticket, worktree branch, commit, tests and checks run, and any remaining risks. Do not change tracker state or merge to `trunk`.

4. **Integrate completed work.** Inspect each report and branch diff. Integrate a completed branch into the integration branch with a fast-forward when possible; the implementer should already include the latest integration tip. If it cannot fast-forward or conflicts remain, stop and investigate or delegate conflict resolution in an isolated worktree. Never force-push, hard-reset user work, or silently skip a ticket. After each integration, refresh the tracker frontier and dispatch newly unblocked tickets.

   If the user requested a PR, open a draft only after the first ticket has been integrated (so the branch has commits), using `/opening-a-pr` and the repository's PR conventions. Keep it draft until the final review passes.

5. **Review the complete spec.** Once every ticket is integrated, call the Skill tool with `code-review` on the integration branch, using the recorded base commit as the fixed point. This is one review of the whole spec, across Standards, Security, and Spec. Fix the findings in one implementer worktree, integrate the fixes, and repeat review against the same fixed point until all active axes report no findings.

6. **Resolve tracker work and report.** Resolve child tickets only when their work meets the tracker's closure condition. Use the issue-tracker instructions; do not close the parent spec unless the user asks. If a draft PR exists, mark it ready only after review passes. Otherwise report the integration branch and ticket outcomes. Do not merge to `trunk` as part of this skill.

7. **Clean up.** Remove only implementer worktrees and panes created by this run, and only after their branches are integrated and their reports read. Preserve any branch with unintegrated work; report it instead of deleting it.

## Completion

The work is complete when every ticket is integrated, the full integration diff passes code review, tracker state matches the issue-tracker workflow, and all created worktrees are either safely cleaned up or explicitly reported as retained. Report the integration branch, the review base, ticket outcomes, checks, PR status if applicable, and any unresolved risks.

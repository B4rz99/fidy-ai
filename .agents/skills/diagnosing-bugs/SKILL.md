---
name: diagnosing-bugs
description: "Diagnose hard bugs, intermittent failures, and performance regressions using a focused reproduction loop."
---

# Diagnosing Bugs

Build a focused feedback loop that distinguishes the reported failure from correct behavior. Adapt the investigation to the evidence; an obvious cause needs less exploration than an intermittent regression.

## Establish the signal

Inspect the relevant code, error output, recent changes, and existing tests to find the failing path. Reproduce the user's exact symptom with the smallest practical test, command, or UI interaction. Record the invocation and observed failure. For reproduction approaches, including replay, bisection, fuzzing, and human-assisted loops, read [FEEDBACK-LOOPS.md](FEEDBACK-LOOPS.md).

Tighten the loop where it saves investigation time: narrow setup, assert the specific symptom, and control time, randomness, or external state. Minimize enough to isolate the cause; exhaustive minimization is unnecessary when the evidence is already decisive.

For intermittent failures, measure reproduction frequency and use repeated runs or stress to make comparisons meaningful. For performance regressions, establish a baseline and profile or bisect the expensive path.

If reproduction is unavailable, continue useful code and artifact inspection, distinguish hypotheses from observations, and request only the access or evidence needed to resolve the remaining uncertainty. Production instrumentation needs authorization for that environment.

## Test explanations

Use falsifiable hypotheses: state what observation would support or rule out each explanation. Consider alternatives when the evidence is ambiguous; choose probes that discriminate between them. Change one relevant variable at a time where feasible. Share consequential findings without turning each probe into an approval checkpoint.

Use targeted debugger inspection or instrumentation. Give temporary logs a unique prefix so cleanup is checkable. Keep credentials in environment variables or protected inputs, and redact secrets from commands, logs, and captured artifacts shown to the user.

## Fix and verify

Where a meaningful test seam exists, capture the actual bug pattern in a regression test and observe it fail before applying the fix. A test that cannot exercise the triggering conditions is not evidence for the fix. Document missing test coverage without expanding the task into an architectural redesign.

Apply the fix, run the original reproduction and relevant checks, and resolve failures introduced by the change. Remove temporary instrumentation and artifacts created for the investigation. Complete when the reported symptom is resolved with supporting evidence, or report the specific unresolved blocker and verification limits. State the cause and the evidence that distinguishes it from the rejected explanations.

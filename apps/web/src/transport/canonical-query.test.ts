import { Cause, Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";
import { presentCanonicalQuery } from "./canonical-query";

const response = { data: "visible" } as const;
const previous = AsyncResult.success(response);

describe("canonical query presentation", () => {
  it("keeps initial idle and loading states distinct", () => {
    expect(presentCanonicalQuery(AsyncResult.initial())).toEqual({
      _tag: "Initial",
      waiting: false,
    });
    expect(presentCanonicalQuery(AsyncResult.initial(true))).toEqual({
      _tag: "Initial",
      waiting: true,
    });
  });

  it("preserves successful data while a refresh is waiting", () => {
    expect(presentCanonicalQuery(AsyncResult.success(response, { waiting: true }))).toEqual({
      _tag: "Ready",
      value: response,
      waiting: true,
      refreshFailure: Option.none(),
    });
  });

  it("preserves successful data after a recoverable refresh failure", () => {
    const result = AsyncResult.failure(Cause.fail("declared"), {
      previousSuccess: Option.some(previous),
    });

    expect(presentCanonicalQuery(result)).toEqual({
      _tag: "Ready",
      value: response,
      waiting: false,
      refreshFailure: Option.some({ _tag: "DeclaredFailure", error: "declared" }),
    });
  });

  it("distinguishes declared failures, defects, and interruption without flattening causes", () => {
    expect(presentCanonicalQuery(AsyncResult.failure(Cause.fail("declared")))).toEqual({
      _tag: "Failure",
      failure: { _tag: "DeclaredFailure", error: "declared" },
      waiting: false,
    });
    expect(presentCanonicalQuery(AsyncResult.failure(Cause.die("private defect")))).toEqual({
      _tag: "Failure",
      failure: { _tag: "BoundaryFailure" },
      waiting: false,
    });
    expect(presentCanonicalQuery(AsyncResult.failure(Cause.interrupt(1)))).toEqual({
      _tag: "Failure",
      failure: { _tag: "Interrupted" },
      waiting: false,
    });
  });
});

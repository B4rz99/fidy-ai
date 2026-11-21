import { Cause, Data, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vitest";
import {
  type CanonicalQueryFailure,
  type CanonicalQueryState,
  presentCanonicalQuery,
} from "@/transport/canonical-query";

const response = { data: "visible" } as const;

const previous = AsyncResult.success(response);

const State = Data.taggedEnum<CanonicalQueryState<typeof response, string>>();

const Failure = Data.taggedEnum<CanonicalQueryFailure<string>>();

describe("canonical query presentation", () => {
  it("keeps initial idle and loading states distinct", () => {
    expect(presentCanonicalQuery(AsyncResult.initial())).toEqual(
      State.Initial({
        waiting: false,
      })
    );
    expect(presentCanonicalQuery(AsyncResult.initial(true))).toEqual(
      State.Initial({
        waiting: true,
      })
    );
  });

  it("preserves successful data while a refresh is waiting", () => {
    expect(presentCanonicalQuery(AsyncResult.success(response, { waiting: true }))).toEqual(
      State.Ready({
        value: response,
        waiting: true,
        refreshFailure: Option.none(),
      })
    );
  });

  it("preserves successful data after a recoverable refresh failure", () => {
    const result = AsyncResult.failure(Cause.fail("declared"), {
      previousSuccess: Option.some(previous),
    });

    expect(presentCanonicalQuery(result)).toEqual(
      State.Ready({
        value: response,
        waiting: false,
        refreshFailure: Option.some(Failure.DeclaredFailure({ error: "declared" })),
      })
    );
  });

  it("distinguishes declared failures, defects, and interruption without flattening causes", () => {
    expect(presentCanonicalQuery(AsyncResult.failure(Cause.fail("declared")))).toEqual(
      State.Failure({
        failure: Failure.DeclaredFailure({ error: "declared" }),
        waiting: false,
      })
    );
    expect(presentCanonicalQuery(AsyncResult.failure(Cause.die("private defect")))).toEqual(
      State.Failure({
        failure: Failure.BoundaryFailure(),
        waiting: false,
      })
    );
    expect(presentCanonicalQuery(AsyncResult.failure(Cause.interrupt(1)))).toEqual(
      State.Failure({
        failure: Failure.Interrupted(),
        waiting: false,
      })
    );
  });
});

it("classifies mixed interruption and defect as boundary failure while retaining display facts", () => {
  const result = AsyncResult.failure(
    Cause.combine(Cause.interrupt(1), Cause.die("private defect")),
    {
      previousSuccess: Option.some(previous),
    }
  );

  expect(presentCanonicalQuery(result)).toEqual(
    State.Ready({
      value: response,
      waiting: false,
      refreshFailure: Option.some(Failure.BoundaryFailure()),
    })
  );
});

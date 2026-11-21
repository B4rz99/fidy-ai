import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { type TenFleetPort, type TenState, fleetOrdinals, runTenFleet } from "./native-ten-fleet";

type TenFleetFixture = {
  port: TenFleetPort;
  state: TenState;
  calls: string[];
  rows: Map<string, boolean>;
};

const fixture = (): TenFleetFixture => {
  const calls: string[] = [];

  const rows = new Map([
    ["prior", true],
    ["old", false],
  ]);

  const state: TenState = {
    at: 1,
    baseline: [...rows],
    survivors: ["smoke1", "smoke2"],
    members: [],
    events: [],
  };

  const port: TenFleetPort = {
    save: () => Effect.void,
    inventory: () => Effect.sync(() => new Map(rows)),
    objects: () =>
      Effect.sync(() =>
        fleetOrdinals
          .filter((ord) => rows.has("object" + ord))
          .map((ord) => ({ id: "object" + ord, name: "user" + ord }))
      ),
    signup: (ord) =>
      Effect.sync(() => {
        calls.push("signup" + ord);
        rows.set("object" + ord, true);

        return { id: "user" + ord, outcome: "created" };
      }),
    login: (ord) =>
      Effect.succeed({
        id: "user" + ord,
        outcome: "approved",
        erase: () =>
          Effect.sync(() => {
            calls.push("erase" + ord);
            rows.set("object" + ord, false);

            return "receipt" + ord;
          }),
        denied: () =>
          Effect.sync(() => {
            expect(rows.get("object" + ord)).toBe(false);
          }),
      }),
    refused: () => Effect.succeed(Effect.void),
    survivors: () => Effect.succeed(["smoke1", "smoke2"]),
    renewCleanup: () => Effect.void,
    beforeSignup: () => Effect.void,
    watch: () =>
      Effect.sync(() => {
        expect([...rows.values()].filter(Boolean)).toHaveLength(11);
        calls.push("observed");
      }),
  };

  return { port, state, calls, rows };
};

it.effect(
  "observes ten distinct new Users together, erases each and preserves every earlier object",
  () =>
    Effect.gen(function* () {
      const { port, state, calls, rows } = fixture();
      yield* runTenFleet(state, port, "measure");
      expect(calls).toEqual([
        ...fleetOrdinals.map((ordinal) => "signup" + ordinal),
        "observed",
        ...fleetOrdinals.map((ordinal) => "erase" + ordinal),
      ]);
      expect([...rows.values()].filter(Boolean)).toHaveLength(1);
      expect(state.events.filter((event) => event.stage === "member-bound")).toHaveLength(10);
      expect(state.events.filter((event) => event.stage === "member-erased")).toHaveLength(10);
    })
);

it.effect("reconciles a lost signup reply without creating any later cohort member", () =>
  Effect.gen(function* () {
    const { port, state, calls, rows } = fixture();

    const verdict = yield* runTenFleet(
      state,
      {
        ...port,
        signup: (ordinal) =>
          ordinal === 3
            ? port.signup(ordinal).pipe(Effect.andThen(Effect.fail(Error("lost signup reply"))))
            : port.signup(ordinal),
      },
      "measure"
    ).pipe(Effect.result);

    expect(verdict._tag).toBe("Failure");
    expect(calls).toEqual(["signup2", "signup3", "erase2", "erase3"]);
    expect([...rows.values()].filter(Boolean)).toHaveLength(1);
    expect(state.events.some((event) => event.stage === "observation-start")).toBe(false);
  })
);

it.effect(
  "refuses to erase a retained physical object even if its name matches a signed login",
  () =>
    Effect.gen(function* () {
      const { port, state, calls } = fixture();
      state.members.push({ ordinal: 2, user: "user2", physical: "" });

      const result = yield* runTenFleet(
        state,
        {
          ...port,
          objects: () => Effect.succeed([{ name: "user2", id: "prior" }]),
        },
        "cleanup"
      ).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      expect(calls).toEqual([]);
    })
);

it.effect("continues physical cleanup after uncertain admission without repeating the trial", () =>
  Effect.gen(function* () {
    const { port, state, calls, rows } = fixture();
    rows.set("object2", false);
    rows.set("object3", true);
    state.members.push(
      { ordinal: 2, user: "user2", physical: "object2" },
      { ordinal: 3, user: "user3", physical: "object3" }
    );
    yield* runTenFleet(state, port, "cleanup");
    expect(calls).toEqual(["erase3"]);
    expect(
      state.events
        .filter((event) => event.stage === "member-erased")
        .map((event) => event["ordinal"])
    ).toEqual([2, 3]);
  })
);

it.effect("stops before erasure when fresh login identifies a different User", () =>
  Effect.gen(function* () {
    const { port, state, calls, rows } = fixture();
    rows.set("object2", true);
    state.members.push({ ordinal: 2, user: "user2", physical: "object2" });

    const result = yield* runTenFleet(
      state,
      { ...port, login: () => port.login(3) },
      "cleanup"
    ).pipe(Effect.result);

    expect(result._tag).toBe("Failure");
    expect(calls).toEqual([]);
    expect(rows.get("object2")).toBe(true);
  })
);

it.effect(
  "cleans positively bound peers and leaves an unlisted signup unresolved after a failed login",
  () =>
    Effect.gen(function* () {
      const { port, state, calls, rows } = fixture();
      rows.set("object2", true);
      state.members.push(
        { ordinal: 2, user: "user2", physical: "object2" },
        { ordinal: 3, user: "", physical: "" }
      );

      const result = yield* runTenFleet(
        state,
        {
          ...port,
          login: (ordinal) =>
            ordinal === 3
              ? Effect.fail(Error("login temporarily unavailable"))
              : port.login(ordinal),
        },
        "cleanup"
      ).pipe(Effect.result);

      expect(calls).toEqual(["erase2"]);
      expect(result._tag).toBe("Failure");
      expect(
        state.events
          .filter((event) => event.stage === "member-erased")
          .map((event) => event["ordinal"])
      ).toEqual([2]);
      expect(
        state.events
          .filter((event) => event.stage === "member-unresolved")
          .map((event) => event["ordinal"])
      ).toEqual([3]);
      expect(state.events.some((event) => event.stage === "cleanup-verified")).toBe(false);
    })
);

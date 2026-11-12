import { Effect, Option } from "effect";
import { expect, it } from "vitest";
import { makeUserRecoveryAlarm } from "./recovery-alarm";

const fromTestPromise = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise(() => Promise.resolve(run())).pipe(Effect.orDie);

it("coalesces competing wake-ups at the earliest due time", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let alarm = Option.none<number>();
      const writes: Array<number | Date> = [];
      const owner = makeUserRecoveryAlarm({
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> =>
          Promise.resolve(Option.getOrNull(alarm)),
        setAlarm: (due): Promise<void> => {
          writes.push(due);
          alarm = Option.some(Number(due));
          return Promise.resolve();
        },
        deleteAlarm: (): Promise<void> => Promise.resolve(),
      });
      yield* fromTestPromise(() =>
        Promise.all([owner.schedule(10), owner.schedule(30), owner.schedule(20)])
      );
      expect(Option.getOrNull(alarm)).toBe(10);
      expect(writes).toEqual([10]);
    })
  ));

it("joins an in-flight write and fences queued or late callbacks before clearing custody", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let alarm = Option.none<number>();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const owner = makeUserRecoveryAlarm({
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> =>
          Promise.resolve(Option.getOrNull(alarm)),
        setAlarm: (due): Promise<void> => {
          entered.resolve();
          return release.promise.then(() => {
            alarm = Option.some(Number(due));
          });
        },
        deleteAlarm: (): Promise<void> => {
          alarm = Option.none();
          return Promise.resolve();
        },
      });
      const scheduling = owner.schedule(10);
      yield* fromTestPromise(() => entered.promise);
      const queued = owner.schedule(5);
      const clearing = owner.retireAndClear();
      release.resolve();
      yield* fromTestPromise(() => Promise.all([scheduling, queued]));
      expect(yield* fromTestPromise(() => clearing)).toEqual({ _tag: "AlarmAbsent" });
      yield* fromTestPromise(() => owner.schedule(1));
      expect(Option.isNone(alarm)).toBe(true);
    })
  ));

it("does not poison future alarm work after a rejected native write", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let alarm = Option.none<number>();
      let first = true;
      const owner = makeUserRecoveryAlarm({
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> =>
          Promise.resolve(Option.getOrNull(alarm)),
        setAlarm: (due): Promise<void> => {
          if (first) {
            first = false;
            return Promise.reject(new Error("Native write unavailable"));
          }
          alarm = Option.some(Number(due));
          return Promise.resolve();
        },
        deleteAlarm: (): Promise<void> => {
          alarm = Option.none();
          return Promise.resolve();
        },
      });
      yield* fromTestPromise(() =>
        expect(owner.schedule(10)).rejects.toMatchObject({ _tag: "RecoveryAlarmUnavailable" })
      );
      yield* fromTestPromise(() => owner.schedule(20));
      expect(Option.getOrNull(alarm)).toBe(20);
      expect(yield* fromTestPromise(() => owner.retireAndClear())).toEqual({ _tag: "AlarmAbsent" });
    })
  ));

it("moves installed wakes earlier for decreasing deadlines without postponing them", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let alarm = Option.none<number>();
      const writes: Array<number | Date> = [];
      const owner = makeUserRecoveryAlarm({
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> =>
          Promise.resolve(Option.getOrNull(alarm)),
        setAlarm: (due): Promise<void> => {
          writes.push(due);
          alarm = Option.some(Number(due));
          return Promise.resolve();
        },
        deleteAlarm: (): Promise<void> => Promise.resolve(),
      });
      yield* fromTestPromise(() => Promise.all([30, 20, 10, 10, 40].map(owner.schedule)));
      expect(writes).toEqual([30, 20, 10]);
      expect(Option.getOrNull(alarm)).toBe(10);
    })
  ));

it("retires synchronously during a suspended read before any write can enter", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const release =
        Promise.withResolvers<Awaited<ReturnType<DurableObjectStorage["getAlarm"]>>>();
      const calls: string[] = [];
      const owner = makeUserRecoveryAlarm({
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => {
          calls.push("read");
          entered.resolve();
          return release.promise;
        },
        setAlarm: (): Promise<void> => {
          calls.push("write");
          return Promise.resolve();
        },
        deleteAlarm: (): Promise<void> => {
          calls.push("delete");
          return Promise.resolve();
        },
      });
      const scheduling = owner.schedule(10);
      yield* fromTestPromise(() => entered.promise);
      const clearing = owner.retireAndClear();
      const late = owner.schedule(1);
      release.resolve(null);
      yield* fromTestPromise(() => Promise.all([scheduling, late]));
      expect(yield* fromTestPromise(() => clearing)).toEqual({ _tag: "AlarmAbsent" });
      expect(calls).toEqual(["read", "delete", "read"]);
    })
  ));

it("reports uncertainty when deletion leaves an alarm and retries without reopening admission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let alarm = Option.some(10);
      let deletions = 0;
      const writes: Array<number | Date> = [];
      const owner = makeUserRecoveryAlarm({
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> =>
          Promise.resolve(Option.getOrNull(alarm)),
        setAlarm: (due): Promise<void> => {
          writes.push(due);
          return Promise.resolve();
        },
        deleteAlarm: (): Promise<void> => {
          deletions += 1;
          if (deletions > 1) alarm = Option.none();
          return Promise.resolve();
        },
      });
      expect(yield* fromTestPromise(() => owner.retireAndClear())).toEqual({
        _tag: "ClearUnconfirmed",
      });
      yield* fromTestPromise(() => owner.schedule(1));
      expect(yield* fromTestPromise(() => owner.retireAndClear())).toEqual({
        _tag: "AlarmAbsent",
      });
      expect(deletions).toBe(2);
      expect(writes).toEqual([]);
    })
  ));

it.each(["delete", "verification"] as const)(
  "rejects failed %s and permits cleanup retry while keeping scheduling retired",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        let failed = false;
        const calls: string[] = [];
        const owner = makeUserRecoveryAlarm({
          getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => {
            calls.push("read");
            if (failure === "verification" && !failed) {
              failed = true;
              return Promise.reject(new Error("Native verification unavailable"));
            }
            return Promise.resolve(null);
          },
          setAlarm: (): Promise<void> => {
            calls.push("write");
            return Promise.resolve();
          },
          deleteAlarm: (): Promise<void> => {
            calls.push("delete");
            if (failure === "delete" && !failed) {
              failed = true;
              return Promise.reject(new Error("Native deletion unavailable"));
            }
            return Promise.resolve();
          },
        });
        yield* fromTestPromise(() =>
          expect(owner.retireAndClear()).rejects.toMatchObject({
            _tag: "RecoveryAlarmUnavailable",
          })
        );
        yield* fromTestPromise(() => owner.schedule(1));
        expect(yield* fromTestPromise(() => owner.retireAndClear())).toEqual({
          _tag: "AlarmAbsent",
        });
        expect(calls).toEqual(
          failure === "delete" ? ["delete", "delete", "read"] : ["delete", "read", "delete", "read"]
        );
      })
    )
);

it("serializes repeated retirement attempts while native deletion is pending", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const calls: string[] = [];
      const owner = makeUserRecoveryAlarm({
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => {
          calls.push("read");
          return Promise.resolve(null);
        },
        setAlarm: (): Promise<void> => {
          calls.push("write");
          return Promise.resolve();
        },
        deleteAlarm: (): Promise<void> => {
          calls.push("delete");
          entered.resolve();
          return release.promise;
        },
      });
      const first = owner.retireAndClear();
      yield* fromTestPromise(() => entered.promise);
      const second = owner.retireAndClear();
      const scheduling = owner.schedule(1);
      expect(calls).toEqual(["delete"]);
      release.resolve();
      expect(yield* fromTestPromise(() => Promise.all([first, second]))).toEqual([
        { _tag: "AlarmAbsent" },
        { _tag: "AlarmAbsent" },
      ]);
      yield* fromTestPromise(() => scheduling);
      expect(calls).toEqual(["delete", "read", "delete", "read"]);
    })
  ));

it("retires a schedule waiting for its native read before it can write an alarm", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const release =
        Promise.withResolvers<Awaited<ReturnType<DurableObjectStorage["getAlarm"]>>>();
      const effects: string[] = [];
      let reads = 0;
      const owner = makeUserRecoveryAlarm({
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => {
          reads += 1;
          if (reads === 1) {
            entered.resolve();
            return release.promise;
          }
          effects.push("verify");
          return Promise.resolve(null);
        },
        setAlarm: (): Promise<void> => {
          effects.push("write");
          return Promise.resolve();
        },
        deleteAlarm: (): Promise<void> => {
          effects.push("delete");
          return Promise.resolve();
        },
      });
      const scheduling = owner.schedule(10);
      yield* fromTestPromise(() => entered.promise);
      const clearing = owner.retireAndClear();
      const late = owner.schedule(1);
      expect(effects).toEqual([]);
      release.resolve(null);
      yield* fromTestPromise(() => scheduling);
      expect(yield* fromTestPromise(() => clearing)).toEqual({ _tag: "AlarmAbsent" });
      yield* fromTestPromise(() => late);
      expect(yield* fromTestPromise(() => owner.retireAndClear())).toEqual({ _tag: "AlarmAbsent" });
      yield* fromTestPromise(() => owner.schedule(1));
      expect(effects).toEqual(["delete", "verify", "delete", "verify"]);
      expect(reads).toBe(3);
    })
  ));

it("distinguishes a remaining alarm from native clearance failure and stays retired on retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let deletes = 0;
      let writes = 0;
      const owner = makeUserRecoveryAlarm({
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> =>
          Promise.resolve(deletes === 1 ? 10 : null),
        setAlarm: (): Promise<void> => {
          writes += 1;
          return Promise.resolve();
        },
        deleteAlarm: (): Promise<void> => {
          deletes += 1;
          return deletes === 2
            ? Promise.reject(new Error("Native deletion unavailable"))
            : Promise.resolve();
        },
      });
      expect(yield* fromTestPromise(() => owner.retireAndClear())).toEqual({
        _tag: "ClearUnconfirmed",
      });
      yield* fromTestPromise(() =>
        expect(owner.retireAndClear()).rejects.toMatchObject({ _tag: "RecoveryAlarmUnavailable" })
      );
      yield* fromTestPromise(() => owner.schedule(1));
      expect(yield* fromTestPromise(() => owner.retireAndClear())).toEqual({ _tag: "AlarmAbsent" });
      yield* fromTestPromise(() => owner.schedule(1));
      expect(deletes).toBe(3);
      expect(writes).toBe(0);
    })
  ));

it("rejects unavailable absence verification and permits cleanup retry without reopening scheduling", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      let deletes = 0;
      let writes = 0;
      const owner = makeUserRecoveryAlarm({
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => {
          reads += 1;
          return reads === 1
            ? Promise.reject(new Error("Native verification unavailable"))
            : Promise.resolve(null);
        },
        setAlarm: (): Promise<void> => {
          writes += 1;
          return Promise.resolve();
        },
        deleteAlarm: (): Promise<void> => {
          deletes += 1;
          return Promise.resolve();
        },
      });
      yield* fromTestPromise(() =>
        expect(owner.retireAndClear()).rejects.toMatchObject({ _tag: "RecoveryAlarmUnavailable" })
      );
      yield* fromTestPromise(() => owner.schedule(1));
      expect(yield* fromTestPromise(() => owner.retireAndClear())).toEqual({ _tag: "AlarmAbsent" });
      expect(reads).toBe(2);
      expect(deletes).toBe(2);
      expect(writes).toBe(0);
    })
  ));

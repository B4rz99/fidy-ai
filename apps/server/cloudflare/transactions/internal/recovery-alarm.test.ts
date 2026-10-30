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
      const clearing = owner.clear();
      release.resolve();
      yield* fromTestPromise(() => Promise.all([scheduling, queued]));
      expect(yield* fromTestPromise(() => clearing)).toBe(true);
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
      expect(yield* fromTestPromise(() => owner.clear())).toBe(true);
    })
  ));

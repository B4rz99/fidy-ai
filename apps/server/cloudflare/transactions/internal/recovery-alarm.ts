import { Data, Effect } from "effect";

type Storage = Pick<DurableObjectStorage, "getAlarm" | "setAlarm" | "deleteAlarm">;

class RecoveryAlarmUnavailable extends Data.TaggedError("RecoveryAlarmUnavailable") {}

const nativeAlarm = <A>(run: () => Promise<A>): Effect.Effect<A, RecoveryAlarmUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new RecoveryAlarmUnavailable() });

/** One resident coordinator serializes alarm updates; durable intent remains in D1. Retiring the
 * owner fences late callbacks before joining pending native writes and clearing the alarm.
 */
export const makeUserRecoveryAlarm = (
  storage: Storage
): Readonly<{
  schedule: (dueAtMs: number) => Promise<void>;
  clear: () => Promise<boolean>;
}> => {
  let pending: Promise<void> = Promise.resolve();
  let retired = false;
  const isRetired = (): boolean => retired;
  const enqueue = <A>(run: () => Promise<A>): Promise<A> => {
    const result = pending.then(run);
    pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  return {
    schedule: (dueAtMs) =>
      enqueue(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (isRetired()) return;
            const existing = yield* nativeAlarm(() => storage.getAlarm());
            if (!isRetired() && (existing === null || dueAtMs < existing)) {
              yield* nativeAlarm(() => storage.setAlarm(dueAtMs));
            }
          })
        )
      ),
    clear: () => {
      retired = true;
      return enqueue(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* nativeAlarm(() => storage.deleteAlarm());
            return (yield* nativeAlarm(() => storage.getAlarm())) === null;
          })
        )
      );
    },
  };
};

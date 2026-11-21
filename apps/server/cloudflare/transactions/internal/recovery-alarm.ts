import { Data, Effect, Layer, ManagedRuntime } from "effect";

const boundaryRuntime = ManagedRuntime.make(Layer.empty);

type Storage = Pick<DurableObjectStorage, "getAlarm" | "setAlarm" | "deleteAlarm">;

export type RecoveryAlarmClear = Data.TaggedEnum<{ AlarmAbsent: {}; ClearUnconfirmed: {} }>;

export const RecoveryAlarmClear = Data.taggedEnum<RecoveryAlarmClear>();

export class RecoveryAlarmUnavailable extends Data.TaggedError("RecoveryAlarmUnavailable") {}

const nativeAlarm = <A>(run: () => Promise<A>): Effect.Effect<A, RecoveryAlarmUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new RecoveryAlarmUnavailable() });

type UserRecoveryAlarm = Readonly<{
  schedule: (dueAtMs: number) => Promise<void>;
  retireAndClear: () => Promise<RecoveryAlarmClear>;
}>;

export const makeUserRecoveryAlarm = (storage: Storage): UserRecoveryAlarm => {
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
        boundaryRuntime.runPromise(
          Effect.gen(function* () {
            if (isRetired()) return;
            const existing = yield* nativeAlarm(() => storage.getAlarm());

            if (!isRetired() && (existing === null || dueAtMs < existing)) {
              yield* nativeAlarm(() => storage.setAlarm(dueAtMs));
            }
          })
        )
      ),
    retireAndClear: () => {
      retired = true;

      return enqueue(() =>
        boundaryRuntime.runPromise(
          Effect.gen(function* () {
            yield* nativeAlarm(() => storage.deleteAlarm());

            const result =
              (yield* nativeAlarm(() => storage.getAlarm())) === null
                ? RecoveryAlarmClear.AlarmAbsent()
                : RecoveryAlarmClear.ClearUnconfirmed();

            return result;
          })
        )
      );
    },
  };
};

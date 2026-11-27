import { type Cause, Data, Effect, Schema } from "effect";
import { newId } from "../secret-material/operations";
import {
  RecoveryOwner,
  maintenanceName,
  recoveryAlarmHeader,
  reserveRecoveryUrl,
  settleRecoveryUrl,
} from "./contract";

class RecoveryReservationUnavailable extends Data.TaggedError("RecoveryReservationUnavailable") {}

const RecoveryReservation = Schema.Struct({ clean: Schema.Boolean, hadDeadline: Schema.Boolean });

type RecoveryFailure =
  | Cause.UnknownError
  | Cause.TimeoutError
  | Schema.SchemaError
  | RecoveryReservationUnavailable;

export class OwnerWorkRecovery {
  private running = 0;
  private readonly state: DurableObjectState;
  private readonly maintenance: Pick<DurableObjectNamespace, "getByName">;

  constructor(state: DurableObjectState, maintenance: Pick<DurableObjectNamespace, "getByName">) {
    this.state = state;
    this.maintenance = maintenance;
  }

  private send(url: string, payload: unknown): Effect.Effect<Response, RecoveryFailure> {
    return Effect.gen({ self: this }, function* () {
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(payload);

      return yield* Effect.tryPromise((signal) =>
        this.maintenance.getByName(maintenanceName).fetch(url, {
          method: "POST",
          body,
          signal,
          headers: { "content-type": "application/json" },
        })
      ).pipe(Effect.timeout("3 seconds"));
    });
  }

  run<A>(
    work: () => Promise<A>,
    completed: (result: A) => boolean,
    alarm = false
  ): Effect.Effect<A, RecoveryFailure> {
    return Effect.gen({ self: this }, function* () {
      this.running++;
      const generation = newId();
      const userId = yield* Schema.decodeUnknownEffect(RecoveryOwner)(this.state.id.name);
      const reservation = yield* this.send(reserveRecoveryUrl, { userId, generation });

      if (!reservation.ok) return yield* new RecoveryReservationUnavailable();

      const { clean, hadDeadline } = yield* Schema.decodeUnknownEffect(RecoveryReservation)(
        yield* Effect.tryPromise(() => reservation.json())
      );

      const result = yield* Effect.tryPromise(work);

      if (clean && this.running === 1 && completed(result)) {
        yield* Effect.gen({ self: this }, function* () {
          const next = yield* Effect.tryPromise(() => this.state.storage.getAlarm());

          if (this.running === 1 && (next !== null || alarm || !hadDeadline)) {
            yield* this.send(settleRecoveryUrl, { userId, generation, next });
          }
        }).pipe(Effect.ignore);
      }

      return result;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.running--;
        })
      )
    );
  }

  inspect(work: () => Promise<Response>): Effect.Effect<Response, Cause.UnknownError> {
    return Effect.gen({ self: this }, function* () {
      if (this.running !== 0) return new Response(null, { status: 503 });

      const response = yield* Effect.tryPromise(work);

      if (!response.ok) return response;

      const next = yield* Effect.tryPromise(() => this.state.storage.getAlarm());
      response.headers.set(recoveryAlarmHeader, next === null ? "idle" : String(next));

      return response;
    });
  }
}

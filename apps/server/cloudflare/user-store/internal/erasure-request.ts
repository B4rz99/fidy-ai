import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { ErasureReference, ErasureRequest } from "../../../src/core/erasure/contract";
import { UserId } from "../../../src/core/identity/contract";
import { boundedJsonBody } from "../../http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import { readBoundWebSessionProof } from "../../web-session/operations";

const invalidStatus = 400;

const unauthorizedStatus = 401;

const forbiddenStatus = 403;

const methodStatus = 405;

const conflictStatus = 409;

const acceptedStatus = 202;

const unavailableStatus = 503;

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});

const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refused = (status: number): Response => json(status, { error: "erasure-unavailable" });

export const requestLocalErasure = Effect.fn(
  function* ({
    request,
    origin,
    storage,
    owns,
  }: Readonly<{
    request: Request;
    origin: string;
    storage: DurableObjectStorage;
    owns: (id: string) => boolean;
  }>) {
    if (request.headers.get("origin") !== origin) return refused(forbiddenStatus);

    if (request.method !== "POST") return refused(methodStatus);

    if (new URL(request.url).search !== "") return refused(invalidStatus);
    const body = yield* boundedJsonBody({ request, policy, schema: Schema.Unknown });

    if (
      Option.isNone(
        Option.flatMap(
          body,
          Schema.decodeUnknownOption(ErasureRequest, { onExcessProperty: "error" })
        )
      )
    ) {
      return refused(invalidStatus);
    }

    const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));

    if (Option.isNone(proof)) return refused(unauthorizedStatus);
    const sql = yield* SqliteClient;
    const { binding, digest } = proof.value;

    return yield* withStoreCapacity("required")(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        if (request.signal.aborted) return refused(conflictStatus);

        const [session] =
          yield* sql`SELECT user_id FROM web_sessions WHERE id=${binding} AND token_digest=${new Uint8Array(digest)} AND revoked_at_ms IS NULL AND fresh_until_ms>${now} AND hard_expires_at_ms>${now} AND idle_expires_at_ms>${now}`;

        const user = Schema.decodeUnknownOption(UserId)(session?.user_id);

        if (Option.isNone(user) || !owns(user.value)) return refused(unauthorizedStatus);

        const inserted =
          yield* sql`INSERT INTO erasure_requests(id,user_id,state,requested_at_ms,session_id,handoff_due_ms,observed_custody)
          SELECT ${newId()},${user.value},'Draining',${now},${binding},${now},json_object('whatsapp',whatsapp,'wompi',wompi,'resend',resend) FROM local_erasure_custody WHERE true ON CONFLICT(user_id) DO NOTHING RETURNING id`;

        if (inserted.length > 0) {
          yield* sql`UPDATE ingest_sample_decisions SET phase='removing',artifact=NULL,due_ms=${now} WHERE phase='approved' AND user_id=${user.value}`;
        }

        const [record] =
          yield* sql`SELECT id,handoff_due_ms FROM erasure_requests WHERE user_id=${user.value} AND session_id=${binding}`;

        if (record === undefined) return refused(conflictStatus);

        const receipt = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ id: ErasureReference, handoff_due_ms: Schema.NullOr(Schema.Int) })
        )(record);

        if (receipt.handoff_due_ms !== null) {
          yield* preserveStoreAlarm(storage, receipt.handoff_due_ms);
        }

        return json(acceptedStatus, {
          reference: receipt.id,
          state: "Draining",
          next: "admitted-work",
        });
      })
    );
  },
  Effect.tapCause(Effect.logDebug),
  Effect.catchCause(() => Effect.succeed(refused(unavailableStatus)))
);

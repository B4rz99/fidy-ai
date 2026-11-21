import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import {
  CustodyScopeAdmission,
  type ErasureRegistryNamespace,
  custodyScopePage,
  scopeDirectoryUrl,
} from "../contract";
import { directoryName } from "../../directory/contract";
import { validContinuation } from "./control-admission";

const conflict = (): Response => new Response(null, { status: 409 });

export const nativeScopeRequest = Effect.fn(function* (
  request: Request,
  directory: ErasureRegistryNamespace
) {
  const decoded = Schema.decodeUnknownOption(CustodyScopeAdmission, { onExcessProperty: "error" })(
    yield* Effect.tryPromise(() => request.json())
  );

  if (Option.isNone(decoded)) return conflict();
  const admission = decoded.value;
  const { userId, reference, custodian, after } = admission;
  const sql = yield* SqliteClient;

  const available = Effect.gen(function* () {
    if (!validContinuation({ admission, userId, current: yield* Clock.currentTimeMillis })) {
      return false;
    }

    return (
      (yield* sql`SELECT 1 FROM erasure_cases r JOIN erasure_case_custodians c USING(reference) WHERE r.state='ExternalPending' AND r.reference=${reference} AND r.user_id=${userId} AND c.custodian=${custodian} AND c.status NOT IN('Verified','NotApplicable')`)
        .length === 1
    );
  });

  if (!(yield* available)) return conflict();

  if (request.url === "https://erasure.invalid/case/confirm-scope") {
    return new Response(null, { status: 204 });
  }

  if (custodian === "Resend") {
    const scope =
      yield* sql`SELECT rowid AS cursor, work_id AS workId,requested_at_ms AS requestedAtMs FROM erasure_resend_scope WHERE reference=${reference} AND rowid>${after} ORDER BY rowid LIMIT 17`;

    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          cursor: Schema.Unknown,
          workId: Schema.Unknown,
          requestedAtMs: Schema.Unknown,
        })
      )
    )(scope);

    return custodyScopePage(rows);
  }

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(CustodyScopeAdmission))(admission);

  const page = yield* Effect.tryPromise((signal) =>
    directory.getByName(directoryName).fetch(scopeDirectoryUrl, { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));

  return (yield* available) ? page : conflict();
});

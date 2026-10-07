import { Schema, Struct } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";

/** Stable Fidy identity of a financial institution, independent of its technical integration. */
export const InstitutionId = Schema.NonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u)
)
  .pipe(Schema.brand("InstitutionId"))
  .annotate({ identifier: "InstitutionId" });
export type InstitutionId = typeof InstitutionId.Type;

/** Stable identity retained across reauthorization of one User's institution association. */
export const ConnectionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("ConnectionId"))
  .annotate({ identifier: "ConnectionId" });
export type ConnectionId = typeof ConnectionId.Type;

/** Product lifecycle; initiating an attempt never grants institution authority. */
export const ConnectionState = Schema.Literals([
  "Connecting",
  "Active",
  "Action required",
  "Ended",
]).annotate({ identifier: "ConnectionState" });
export type ConnectionState = typeof ConnectionState.Type;

/** Safe caller-owned Connection projection without credentials, attempts, or provider identifiers. */
export const Connection = Schema.Struct({
  id: ConnectionId,
  institutionId: InstitutionId,
  state: ConnectionState,
}).annotate({ identifier: "Connection" });
export type Connection = typeof Connection.Type;

/** Discovery includes unavailable institutions and only the caller's current association. */
export const InstitutionSummary = Schema.Struct({
  id: InstitutionId,
  displayName: Schema.NonEmptyString,
  availability: Schema.Literals(["available", "unavailable"]),
  connection: Schema.OptionFromNullOr(Connection.mapFields(Struct.pick(["id", "state"]))),
}).annotate({ identifier: "InstitutionSummary" });
export type InstitutionSummary = typeof InstitutionSummary.Type;

/** Starting requires only Fidy's stable institution identity. */
export const ConnectInstitutionInput = Schema.Struct({ institutionId: InstitutionId }).annotate({
  identifier: "ConnectInstitutionInput",
});
export type ConnectInstitutionInput = typeof ConnectInstitutionInput.Type;

/** Public browser locator; the same User's browser authentication is still required. */
export const BrowserContinuation = Schema.Struct({
  url: Schema.String.check(
    Schema.isPattern(/^https:\/\/app\.fidyapp\.com\/connections\/continue\?attempt=[0-9a-f-]{36}$/u)
  ),
  expiresAt: UtcTimestamp,
}).annotate({ identifier: "BrowserContinuation" });

/** A browser handoff or an already authorized association; no bank authority is returned. */
export const ConnectInstitutionResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("continue_in_browser"),
    connection: Schema.Struct({ ...Connection.fields, state: Schema.Literal("Connecting") }),
    continuation: BrowserContinuation,
  }),
  Schema.Struct({
    type: Schema.Literal("already_connected"),
    connection: Schema.Struct({ ...Connection.fields, state: Schema.Literal("Active") }),
  }),
]).annotate({ identifier: "ConnectInstitutionResult" });
export type ConnectInstitutionResult = typeof ConnectInstitutionResult.Type;

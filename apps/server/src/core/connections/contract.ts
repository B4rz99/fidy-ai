import { Schema, Struct } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";

export const InstitutionId = Schema.NonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u)
)
  .pipe(Schema.brand("InstitutionId"))
  .annotate({ identifier: "InstitutionId" });

export type InstitutionId = typeof InstitutionId.Type;

export const ConnectionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("ConnectionId"))
  .annotate({ identifier: "ConnectionId" });

export type ConnectionId = typeof ConnectionId.Type;

export const ConnectionState = Schema.Literals([
  "Connecting",
  "Active",
  "Action required",
  "Ended",
]).annotate({ identifier: "ConnectionState" });

export type ConnectionState = typeof ConnectionState.Type;

export const Connection = Schema.Struct({
  id: ConnectionId,
  institutionId: InstitutionId,
  state: ConnectionState,
}).annotate({ identifier: "Connection" });

export type Connection = typeof Connection.Type;

export const AccountId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("AccountId"))
  .annotate({ identifier: "AccountId" });

export type AccountId = typeof AccountId.Type;

export const Account = Schema.Struct({ id: AccountId, connectionId: ConnectionId }).annotate({
  identifier: "Account",
});

export type Account = typeof Account.Type;

export const InstitutionSummary = Schema.Struct({
  id: InstitutionId,
  displayName: Schema.NonEmptyString,
  availability: Schema.Literals(["available", "unavailable"]),
  connection: Schema.OptionFromNullOr(Connection.mapFields(Struct.pick(["id", "state"]))),
}).annotate({ identifier: "InstitutionSummary" });

export type InstitutionSummary = typeof InstitutionSummary.Type;

export const ConnectInstitutionInput = Schema.Struct({ institutionId: InstitutionId }).annotate({
  identifier: "ConnectInstitutionInput",
});

export type ConnectInstitutionInput = typeof ConnectInstitutionInput.Type;

export const BrowserContinuation = Schema.Struct({
  url: Schema.String.check(
    Schema.isPattern(/^https:\/\/app\.fidyapp\.com\/connections\/continue\?attempt=[0-9a-f-]{36}$/u)
  ),
  expiresAt: UtcTimestamp,
}).annotate({ identifier: "BrowserContinuation" });

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

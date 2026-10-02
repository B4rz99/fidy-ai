import { prepareConsentAction } from "../consent/operations";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
  refusedByAuditBudget,
} from "@fidy/server/audit";
import { liveWebSessionAuthority } from "@fidy/server/identity-operations";
import { livePATAuthority, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { activeProUserCondition } from "../access-tier";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type TransactionCaller,
  isPATCaller,
  refusedTransactionWork,
  transactionId,
  transactionNoStore,
  transactionUnavailable,
} from "../transactions/transaction-boundary";
import { type EmailForwardingAddress, EmailForwardingStatus } from "../../src/core/ingestion/model";
import { freeForwardedEmailCap } from "../../src/core/ingestion/email-policy";
import { emailAllowancePeriod } from "../../src/core/ingestion/rules";
import {
  EmailForwardingAddressId,
  EmailForwardingLocalPart,
} from "../../src/core/ingestion/reference";

const AddressRow = Schema.Struct({
  id: EmailForwardingAddressId,
  local_part: EmailForwardingLocalPart,
  created_at_ms: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  consumed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pro: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
const domain = "fidyapp.com";
const HTTP_OK = 200;
const HTTP_TOO_MANY_REQUESTS = 429;

/** One authorized canonical forwarding operation; both operations disclose only the User's own address. */
export type ForwardingAddressOperation =
  | "ingestion.enableEmailForwarding"
  | "ingestion.getEmailForwarding";

const rows = (db: D1Database, userId: string, current: number): D1PreparedStatement => {
  const period = emailAllowancePeriod(DateTime.makeUnsafe(current));
  const pro = activeProUserCondition({ userId, nowEpochMs: current });
  return prepareConsentAction({
    db,
    subject: { _tag: "Owner", column: "a.user_id" },
    requirement: "active",
    statement: {
      sql: `SELECT a.id, a.local_part, a.created_at_ms,
      (SELECT count(*) FROM forwarded_email_receipts r WHERE r.user_id = a.user_id
       AND r.received_at_ms >= ? AND r.received_at_ms < ?) AS consumed,
      ${pro.sql} AS pro
     FROM email_forwarding_addresses a WHERE a.user_id = ?`,
      params: [
        DateTime.toEpochMillis(period.from),
        DateTime.toEpochMillis(period.toExclusive),
        ...pro.params,
        userId,
      ],
    },
  });
};

export const forwardingAddressAudit = ({
  db,
  subject,
  current,
  operation,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  operation: ForwardingAddressOperation;
}>): ReadonlyArray<D1PreparedStatement> => {
  if (isPATCaller(subject)) {
    return [
      prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
      prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          authority: livePATAuthority({ subject, current }),
          input: {
            id: transactionId(),
            current,
            operation,
            outcome: "accepted",
            afterOwnerWrite: false,
          },
        }),
      }),
    ];
  }
  const authority = liveWebSessionAuthority({ subject, current });
  return [
    prepareAuthorizedAuditCall({
      db,
      authority,
      id: transactionId(),
      operation,
      outcome: "success",
      current,
      afterOwnerWrite: false,
    }),
  ];
};

/** One metadata-only refusal for a guarded forwarding-address mutation after its D1 unit rolls back. */
export const forwardingAddressGuardAudit = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): D1PreparedStatement => {
  if (isPATCaller(subject)) {
    return prepareOwnedStatement({
      db,
      statement: recordCanonicalPATWork({
        authority: livePATAuthority({ subject, current }),
        input: {
          id: transactionId(),
          current,
          operation: "ingestion.enableEmailForwarding",
          outcome: "rejected",
          afterOwnerWrite: false,
        },
      }),
    });
  }
  const authority = liveWebSessionAuthority({ subject, current });
  return prepareAuthorizedAuditCall({
    db,
    authority,
    id: transactionId(),
    operation: "ingestion.enableEmailForwarding",
    outcome: "validation_failed",
    current,
    afterOwnerWrite: false,
  });
};

const auditCommitted = (results: D1Result[], subject: TransactionCaller): boolean => {
  const committed = results.at(-1)?.meta.changes === 1;
  return committed && (!isPATCaller(subject) || results.at(results.length - 2)?.meta.changes === 1);
};

const batchFailure = (cause: unknown): Response =>
  refusedByAuditBudget(cause) ? rateLimited() : transactionUnavailable();

const rateLimited = (): Response =>
  Response.json(
    {
      error: { code: "rate_limited", message: "Daily canonical work budget exhausted." },
      next: [],
    },
    { status: HTTP_TOO_MANY_REQUESTS, headers: transactionNoStore }
  );

const projectAddress = (row: typeof AddressRow.Type): EmailForwardingAddress => ({
  id: row.id,
  address: `${row.local_part}@${domain}`,
  createdAt: DateTime.makeUnsafe(row.created_at_ms),
});

/** Committed readback for the composable enable mutation, never a caller-supplied address. */
export const readForwardingAddress = Effect.fn(
  (
    db: D1Database,
    userId: string,
    current: number
  ): Effect.Effect<Option.Option<EmailForwardingAddress>> =>
    Effect.tryPromise(() => rows(db, userId, current).first()).pipe(
      Effect.map((value) =>
        Option.flatMap(Option.fromNullishOr(value), Schema.decodeUnknownOption(AddressRow))
      ),
      Effect.map(Option.map(projectAddress)),
      Effect.orElseSucceed(() => Option.none())
    )
);

const responseFor = Effect.fn(function* (row: typeof AddressRow.Type, current: number) {
  const address = projectAddress(row);
  const period = emailAllowancePeriod(DateTime.makeUnsafe(current));
  const status: EmailForwardingStatus = {
    address: Option.some(address),
    remainingThisMonth:
      row.pro === 1
        ? Option.none()
        : Option.some(Math.max(0, freeForwardedEmailCap - row.consumed)),
    deferredEmails: 0,
    deferredCapacityRemaining: freeForwardedEmailCap,
    resetsAt: period.toExclusive,
  };
  const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(EmailForwardingStatus))(
    status
  ).pipe(Effect.option);
  return Option.isSome(encoded)
    ? Response.json(
        { data: encoded.value, next: [] },
        { status: HTTP_OK, headers: transactionNoStore }
      )
    : transactionUnavailable();
});

/**
 * Read the address issued with verified onboarding under the canonical caller's live authority.
 * The same atomic D1 batch commits a metadata-only Audit (and PAT use where applicable) before
 * this read discloses the address. POST composes its Audit in the shared mutation unit.
 */
export const forwardingAddressResponse = Effect.fn(function* (
  input: Readonly<{
    db: D1Database;
    subject: TransactionCaller;
    operation: "ingestion.getEmailForwarding";
  }>
) {
  const current = yield* Clock.currentTimeMillis;
  const result = yield* Effect.exit(
    Effect.tryPromise(() =>
      input.db.batch([
        rows(input.db, input.subject.userId, current),
        ...forwardingAddressAudit({ ...input, current }),
      ])
    )
  );
  if (result._tag === "Failure") {
    return batchFailure(result.cause);
  }
  if (!auditCommitted(result.value, input.subject)) {
    return yield* Effect.tryPromise(() =>
      refusedTransactionWork({
        db: input.db,
        subject: input.subject,
      })
    ).pipe(Effect.orElseSucceed(transactionUnavailable));
  }
  const stored = Schema.decodeUnknownOption(AddressRow)(result.value[0]?.results[0]);
  if (Option.isNone(stored)) return transactionUnavailable();
  return yield* responseFor(stored.value, current);
});

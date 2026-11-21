import {
  canonicalAdmissionUnavailable,
  localPreparationSubject,
  prepareLocalWrite,
  runLocalMutation,
} from "../../canonical-admission/operations";
import { DateTime, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  EmailForwardingAddressId,
  EmailForwardingLocalPart,
  freeForwardedEmailCap,
  freeForwardedEmailDeferredCap,
} from "../../../src/core/ingestion/contract";
import { emailAllowancePeriod } from "../../../src/core/ingestion/operations";
import type { UserId } from "../../../src/core/identity/contract";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import { allowanceConsumptionCount } from "../../quotas/operations";

import { DirectoryWriteUnavailable, type UserStoreBindings } from "../../directory/contract";
import { reserveExternalEventRoute } from "../../directory/operations";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";

const addressOperations = Schema.Literals([
  "ingestion.getEmailForwarding",
  "ingestion.enableEmailForwarding",
]);

export const isLocalForwardingOperation = Schema.is(addressOperations);

const Address = Schema.Struct({
  id: EmailForwardingAddressId,
  local_part: EmailForwardingLocalPart,
  issued_at_ms: Schema.Int,
});

const addressFor = Effect.fn(function* (userId: UserId) {
  const sql = yield* SqliteClient;

  const query = protectConsentStatement({
    subject: ConsentSubject.User({ userId }),
    requirement: "active",
    statement: {
      sql: "SELECT id,local_part,issued_at_ms FROM forwarding_addresses WHERE user_id=?",
      params: [userId],
    },
  });

  const [stored] = yield* sql.unsafe(query.sql, query.params);

  return yield* Schema.decodeUnknownEffect(Address)(stored);
});

const forwardingAllowance = Effect.fn(function* (userId: UserId, current: number) {
  const pro = activeProUserCondition({ userId, nowEpochMs: current });
  const used = allowanceConsumptionCount({ userId, current, allowance: "forwarded_email" });
  const sql = yield* SqliteClient;

  const [raw] = yield* sql.unsafe(
    `SELECT ${pro.sql} AS pro, (${used.sql}) AS used,(SELECT count(*) FROM forwarded_email_receipts WHERE user_id=? AND deferred_checked_at_ms IS NOT NULL) AS deferred`,
    [...pro.params, ...used.params, userId]
  );

  const stats = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ pro: Schema.Int, used: Schema.Int, deferred: Schema.Int })
  )(raw);

  return stats;
});

const registerAddress = Effect.fn(function* (
  user: Option.Option<UserId>,
  directory: UserStoreBindings["DIRECTORY"]
) {
  return yield* Effect.transposeOption(
    Option.map(user, (userId) =>
      Effect.gen(function* () {
        const address = yield* addressFor(userId);
        yield* reserveExternalEventRoute(directory, {
          kind: "forwarding",
          endpoint: "fidyapp.com",
          lookup: address.local_part,
          userId,
          operationId: address.id,
          family: "forwarding",
        });

        const sql = yield* SqliteClient;
        yield* sql`UPDATE forwarding_addresses SET route_registered=1 WHERE id=${address.id} AND user_id=${userId} AND local_part=${address.local_part}`;

        return address;
      })
    )
  );
});

const forwardingStatus = Effect.fn(function* ({
  userId,
  current,
  data,
}: {
  userId: UserId;
  current: number;
  data: { id: string; address: string; createdAt: string };
}) {
  const stats = yield* forwardingAllowance(userId, current);

  return {
    status: 200,
    outcome: "success",
    body: {
      data: {
        address: data,
        ...Option.match(
          Option.liftPredicate(stats, (usage) => usage.pro !== 1),
          {
            onNone: () => ({}),
            onSome: (usage) => ({
              remainingThisMonth: Math.max(0, freeForwardedEmailCap - usage.used),
            }),
          }
        ),
        deferredEmails: stats.deferred,
        deferredCapacityRemaining: Math.max(0, freeForwardedEmailDeferredCap - stats.deferred),
        resetsAt: DateTime.formatIso(
          emailAllowancePeriod(DateTime.makeUnsafe(current)).toExclusive
        ),
      },
      next: [],
    },
  } as const;
});

export const readForwarding = Effect.fnUntraced(function* (userId: UserId, current: number) {
  const address = yield* addressFor(userId);

  const [registered] =
    yield* (yield* SqliteClient)`SELECT 1 FROM forwarding_addresses WHERE user_id=${userId} AND id=${address.id} AND route_registered=1`;

  if (registered === undefined) return yield* new DirectoryWriteUnavailable();

  return yield* forwardingStatus({
    userId,
    current,
    data: {
      id: address.id,
      address: address.local_part + "@fidyapp.com",
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(address.issued_at_ms)),
    },
  });
});

export const dispatchLocalForwarding = Effect.fn(
  function* (unit: {
    request: Request;
    storage: DurableObjectStorage;
    owns: (id: string) => boolean;
    operation: CatalogOperation;
    directory: UserStoreBindings["DIRECTORY"];
  }) {
    const user = yield* localPreparationSubject(unit.request, unit.owns, unit.operation);
    const selected = yield* registerAddress(user, unit.directory);

    return yield* runLocalMutation({
      ...unit,
      input: Effect.succeed(selected),
      work: (reserved, userId, current) =>
        Effect.gen(function* () {
          const address = yield* addressFor(userId);

          if (address.id !== reserved.id || address.local_part !== reserved.local_part) {
            return yield* new DirectoryWriteUnavailable();
          }

          const data = {
            id: address.id,
            address: address.local_part + "@fidyapp.com",
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(address.issued_at_ms)),
          };

          if (unit.operation.id === "ingestion.enableEmailForwarding") {
            return { status: 200, outcome: "success", body: { data, next: [] } } as const;
          }

          return yield* forwardingStatus({ userId, current, data });
        }),
    });
  },
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const reserveBatchForwarding = Effect.fn(function* (
  user: UserId,
  directory: UserStoreBindings["DIRECTORY"]
) {
  yield* registerAddress(Option.some(user), directory);
});

export const prepareLocalForwardingEnable = Effect.fn(function* (userId: UserId) {
  const sql = yield* SqliteClient;
  const address = yield* addressFor(userId);

  const [ready] =
    yield* sql`SELECT 1 FROM forwarding_addresses WHERE user_id=${userId} AND id=${address.id} AND route_registered=1`;

  if (ready === undefined) return yield* new DirectoryWriteUnavailable();

  return prepareLocalWrite({
    targets: ["forwarding"],
    commit: Effect.succeed({
      status: 200,
      outcome: "success",
      body: {
        data: {
          id: address.id,
          address: address.local_part + "@fidyapp.com",
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(address.issued_at_ms)),
        },
        next: [],
      },
    }),
  });
});

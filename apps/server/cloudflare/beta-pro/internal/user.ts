import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Schema } from "effect";
import { BetaUserCommand, betaStatus } from "../contract";
import type { ProMutation } from "../../../src/shell/pro-grants/contract";
import { withStoreAdmission } from "../../runtime/sqlite/operations";

type Command = (typeof BetaUserCommand.Type)["command"];

type Authority = (typeof BetaUserCommand.Type)["authority"];

type Growth = Parameters<Parameters<typeof withStoreAdmission>[0]>[0];

const refused = (status: number): Response => new Response(null, { status });

const liveTarget = Effect.fn(function* (command: Command) {
  const sql = yield* SqliteClient,
    user = command.userId;

  const live =
    yield* sql`SELECT id FROM users WHERE id=${user} AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=${user})`;

  if (live.length !== 1) return false;

  if (!("mailbox" in command) || command.mailbox === undefined) return true;
  const { email, revision } = command.mailbox;

  const verified =
    yield* sql`SELECT 1 FROM verified_email_credentials WHERE user_id=${user} AND normalized_address=${email} AND revision=${revision}`;

  return verified.length === 1;
});

const record = Effect.fn(function* (
  command: typeof ProMutation.Type,
  authority: Authority,
  { now, admitGrowth }: { now: number; admitGrowth: Growth }
) {
  const sql = yield* SqliteClient;
  const revision = command.mailbox?.revision ?? null;

  const [prior] =
    yield* sql`SELECT action=${command.action} AND operator=${authority.email} AND operator_issuer=${authority.issuer} AND operator_subject=${authority.subject} AND mailbox_revision IS ${revision} AS same_intent
 FROM pro_grant_events WHERE user_id=${command.userId} AND request_id=${command.requestId}`;

  if (prior !== undefined && prior.same_intent !== 1) return refused(betaStatus.conflict);

  if (prior === undefined) {
    if (command.action === "grant") yield* admitGrowth;

    const evidence =
      yield* sql`INSERT INTO pro_grant_events(user_id,action,operator,occurred_at_ms,request_id,operator_issuer,operator_subject,mailbox_revision)
   VALUES(${command.userId},${command.action},${authority.email},${now},${command.requestId},${authority.issuer},${authority.subject},${revision}) RETURNING sequence`;

    if (evidence.length !== 1) return yield* Effect.fail(Error("Manual Pro decision unavailable"));
  }

  return Response.json({ userId: command.userId, action: command.action });
});

export const applyBetaUserCommand = Effect.fn(
  function* (request: Request, owns: (id: string) => boolean) {
    const { command, authority } = yield* Schema.decodeUnknownEffect(BetaUserCommand)(
      yield* Effect.tryPromise(() => request.json())
    );

    const sql = yield* SqliteClient;

    return yield* withStoreAdmission((admitGrowth) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        if (now >= authority.deadline) return refused(betaStatus.unauthenticated);

        if (!owns(command.userId) || !(yield* liveTarget(command))) {
          return refused(betaStatus.notFound);
        }

        if (command.action === "resolve") {
          return Response.json({ userId: command.userId, revision: command.mailbox.revision });
        }

        if (command.action === "inspect") {
          const [row] =
            yield* sql`SELECT action FROM pro_grant_events WHERE user_id=${command.userId} ORDER BY sequence DESC LIMIT 1`;

          return Response.json({ active: row?.action === "grant" });
        }

        return yield* record(command, authority, { now, admitGrowth });
      })
    );
  },
  Effect.tapError(() =>
    Effect.logWarning({
      component: "beta-pro",
      operation: "applyBetaUserCommand",
      outcome: "unavailable",
    })
  ),
  Effect.orElseSucceed(() => refused(betaStatus.unavailable))
);

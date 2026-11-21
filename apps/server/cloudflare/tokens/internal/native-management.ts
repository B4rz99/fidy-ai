import type { PATActivityAuthority } from "../../../src/shell/audit/contract";
import type { UserId } from "../../../src/core/identity/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import { ActivePATList, TokenShortId } from "../../../src/core/tokens/contract";
import { PATActivity } from "../../../src/shell/tokens/contract";
import {
  patIdentityQuery,
  preparePATActivityMetadata,
  preparePATMetadata,
  revocablePATGrants,
  revocablePairingGrants,
  revokeEveryPAT,
  revokeEveryPairing,
  revokeOnePAT,
} from "../../../src/shell/tokens/operations";
import {
  revokeAllPATConsents,
  revokeAllPairingConsents,
  revokeOnePATConsent,
} from "../../../src/shell/consent/operations";
import {
  preparePATActivity,
  recordAllPATRevocations,
  recordOnePATRevocation,
  recordPATActivityQuery,
  recordPATList,
} from "../../../src/shell/audit/operations";
import { type CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { type LocalMutationResult } from "../../canonical-admission/contract";
import { readBoundWebSessionProof } from "../../web-session/operations";
import { newId } from "../../secret-material/operations";
import { PATUnavailable } from "../contract";

const read = Effect.fn(function* (statement: OwnedStatement) {
  return yield* (yield* SqliteClient).unsafe(statement.sql, statement.params);
});

const changed = Effect.fn(function* (statement: OwnedStatement) {
  return yield* (yield* SqliteClient).unsafe(statement.sql + " RETURNING id", statement.params);
});

const record = Effect.fn(function* (statement: OwnedStatement) {
  if ((yield* changed(statement)).length !== 1) {
    return yield* new PATUnavailable({ cause: Option.none() });
  }
});

const missing: LocalMutationResult = {
  status: 404,
  outcome: "not_found",
  body: { error: { code: "not_found", message: "PAT not found." }, next: [] },
};

const ok = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

export const isPATManagement = (id: string): boolean =>
  ["pats.listPATs", "pats.getPATActivity", "pats.revokePAT", "pats.revokeAllPATs"].includes(id);

type Session = Parameters<typeof revokeOnePAT>[0]["session"];

const revokeSingle = Effect.fn(function* ({
  session,
  current,
  shortId,
}: {
  session: Session;
  current: number;
  shortId: string;
}) {
  const userId = session.user_id,
    sql = yield* SqliteClient;

  if (!Schema.is(TokenShortId)(shortId)) return missing;

  const [owned] =
    yield* sql`SELECT revoked_at_ms FROM pats WHERE user_id=${userId} AND short_id=${shortId}`;

  if (owned === undefined) return missing;

  if (owned.revoked_at_ms !== null) return ok({ shortId });
  const candidates = revocablePATGrants({ userId, shortId: Option.some(shortId), current });

  const evidence = yield* changed(
    revokeOnePATConsent({ session, input: { id: newId(), shortId, current }, candidates })
  );

  if (evidence.length !== 1) return yield* new PATUnavailable({ cause: Option.none() });

  if ((yield* changed(revokeOnePAT({ session, input: { shortId, current } }))).length !== 1) {
    return yield* new PATUnavailable({ cause: Option.none() });
  }

  yield* record(recordOnePATRevocation({ session, input: { id: newId(), shortId, current } }));

  return ok({ shortId });
});

const revokeAll = Effect.fn(function* (session: Session, current: number) {
  const userId = session.user_id;

  const pats = revocablePATGrants({ userId, current, shortId: Option.none() }),
    pairs = revocablePairingGrants(userId);

  const grants = yield* read(pats.statement),
    approvals = yield* read(pairs.statement);

  if (
    (yield* changed(revokeAllPATConsents({ session, current, candidates: pats }))).length !==
    grants.length
  ) {
    return yield* new PATUnavailable({ cause: Option.none() });
  }

  const revoked = yield* changed(revokeEveryPAT({ session, current }));

  if (revoked.length !== grants.length) return yield* new PATUnavailable({ cause: Option.none() });

  if (
    (yield* changed(revokeAllPairingConsents({ session, current, candidates: pairs }))).length !==
    approvals.length
  ) {
    return yield* new PATUnavailable({ cause: Option.none() });
  }

  if ((yield* changed(revokeEveryPairing({ session, current }))).length !== approvals.length) {
    return yield* new PATUnavailable({ cause: Option.none() });
  }

  yield* record(recordAllPATRevocations({ session, input: { id: newId(), current } }));

  return ok({ revokedCount: revoked.length });
});

const absentCredential: LocalMutationResult = {
  status: 401,
  outcome: "validation_failed" as const,
  body: {
    error: { code: "unauthenticated", message: "Present a valid credential and retry." },
    next: [],
  },
};

export const dispatchManagement = Effect.fn(function* (unit: {
  request: Request;
  operation: CatalogOperation;
  owns: (id: string) => boolean;
  storage: DurableObjectStorage;
}) {
  const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(unit.request));
  const id = unit.operation.id;
  const shortId = new URL(unit.request.url).pathname.split("/")[2] ?? "";

  return {
    ...unit,
    input: Effect.succeedSome(true),
    work: Effect.fn(function* (_unused: boolean, userId: UserId, current: number) {
      if (Option.isNone(proof)) {
        return absentCredential;
      }

      const { binding, digest } = proof.value;
      const sql = yield* SqliteClient;

      const authority = liveWebSessionAuthority({
        subject: { id: binding, userId, digest },
        current,
      });

      if (id === "pats.listPATs") return yield* readMetadata({ authority, userId, current });

      if (id === "pats.getPATActivity") {
        return yield* readActivity({ authority, userId, current, shortId });
      }

      const session = { id: binding, user_id: userId };

      const fresh =
        yield* sql`SELECT 1 FROM web_sessions WHERE id=${binding} AND user_id=${userId} AND fresh_until_ms>${current}`;

      if (fresh.length !== 1) {
        return absentCredential;
      }

      if (id === "pats.revokePAT") {
        return yield* revokeSingle({ session, current, shortId });
      }

      return yield* revokeAll(session, current);
    }),
  };
});

type Metadata = { authority: PATActivityAuthority; userId: UserId; current: number };

export const readMetadata = Effect.fn(function* ({ authority, userId, current }: Metadata) {
  const select = preparePATMetadata({ userId, current, authority });
  const { data } = yield* select.decode(yield* read(select.statement));
  yield* record(recordPATList({ authority, input: { id: newId(), current } }));

  return ok(yield* Schema.encodeEffect(Schema.toCodecJson(ActivePATList))(data));
});

export const readActivity = Effect.fn(function* ({
  authority,
  userId,
  current,
  shortId,
}: Metadata & { shortId: string }) {
  const input = { userId, current, authority, shortId };
  const select = preparePATActivityMetadata(input);
  const pat = yield* select.decode(yield* read(select.statement));
  const activityInput = { ...input, grant: patIdentityQuery(input) };
  const activity = preparePATActivity(activityInput);
  const history = yield* activity.decode(yield* read(activity.statement));
  yield* record(recordPATActivityQuery({ ...activityInput, id: newId() }));

  if (Option.isNone(pat)) return missing;

  return ok(
    yield* Schema.encodeEffect(Schema.toCodecJson(PATActivity))({
      pat: pat.value,
      ...history,
    })
  );
});

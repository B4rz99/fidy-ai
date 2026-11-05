import type { HostedDashboardAdmission } from "../../agent/contract";
import { allowancePeriod } from "../../../src/core/quotas/operations";
import { dashboardLoadsSavedHistory, prepareHostedDashboardTurn } from "../../agent/operations";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import {
  protectConsentAuthority,
  protectConsentStatement,
} from "../../../src/shell/consent/operations";
import { whatsAppIdentityQuery } from "../../identity/operations";
import {
  prepareConsumption,
  quotaFailure,
  quotaStatusForUserSelection,
} from "../../quotas/operations";
import { liveOAuthAuthority } from "../../../src/shell/oauth-agents/operations";
import { resolveCanonicalOAuthSnapshot } from "../../oauth-agents/operations";
import type { OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import type {
  CanonicalSnapshotMaterial,
  CanonicalSnapshotResponse,
} from "../../canonical-admission/contract";
import type { AuditAuthority } from "../../../src/shell/audit/contract";
import type { AuthorizedPAT, CanonicalPATMaterial } from "../../tokens/contract";
import { prepareCanonicalPATMaterial, resolveCanonicalPATSnapshot } from "../../tokens/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { getBoundOperationCatalog } from "../../../src/shell/canonical-catalog/contract";
import { BrowserSessionBinding } from "../../../src/shell/web-session/contract";
import type { Category } from "../../../src/core/categories/contract";
import { WebSessionId } from "../../../src/core/web-session/contract";
import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import { DashboardDocument } from "../../../src/core/dashboard/contract";
import { UserContext } from "../../../src/core/identity/contract";
import { renderDashboardHtml } from "../../../src/shell/dashboard/operations";
import { DashboardViewSnapshot } from "../../../src/shell/dashboard/contract";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { prepareReservedChangeCheck } from "../../../src/shell/sql-assertions/operations";
import { browserSessionBindingHeader } from "../../../src/shell/browser-transport/contract";
import {
  attachCanonicalSnapshotStanding,
  canonicalSnapshotFailure,
  canonicalSnapshotPressureRefusal,
  prepareCanonicalSnapshotAdmission,
  prepareCanonicalSnapshotMaterial,
  protectCanonicalSnapshotSource,
  runCanonicalSnapshotAdmission,
} from "../../canonical-admission/operations";
import { prepareRecoveryGenerationFence } from "../../erasure/operations";
import { makeSqliteDatabaseUnit } from "../../sqlite-store/operations";
import { prepareSelectedUserDocument } from "../../user-documents/operations";
import { prepareSelectedUserContext } from "../../identity/user-context/operations";
import { prepareCategorySnapshot } from "../../categories/operations";

import {
  acceptsCanonicalBrowserBinding,
  currentBrowserSessionLookup,
  prepareBrowserSessionMaterial,
  prepareCanonicalBrowserBinding,
  readWebSessionSnapshotContext,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import type { AuthenticatedWebSession, BoundWebSessionLookup } from "../../web-session/contract";
import { transactionId, transactionNoStore } from "../../canonical-work/operations";
import { type NativeDashboardRead, NativeDashboardResult } from "../contract";
import { sqliteDashboardView } from "./sqlite-view";

const DocumentRow = Schema.Struct({
  encoded: Schema.fromJsonString(Schema.toCodecJson(DashboardDocument)),
  revision: Schema.Int,
});
const encodeView = Schema.encodeSync(Schema.toCodecJson(DashboardViewSnapshot));
const encodeResult = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(NativeDashboardResult))
);
const maximumResultBytes = 33554432;
const maximumHtmlBytes = 1_048_576;
const successfulStatus = 200;
const failure = (
  kind: "unavailable" | "unauthenticated" | "rate_limited"
): NativeDashboardResult => {
  const response = canonicalSnapshotFailure(kind);
  return {
    kind: "response",
    response: { ...response, headers: { ...transactionNoStore, ...response.headers } },
  };
};
const unavailable = (): NativeDashboardResult => failure("unavailable");
type Unit = ReturnType<typeof makeSqliteDatabaseUnit>;
type Work = Readonly<{
  unit: Unit;
  lookup: Pick<BoundWebSessionLookup, "statement"> & Readonly<{ authority: AuditAuthority }>;
  activity: Option.Option<AuthorizedPAT>;
  current: number;
  sql: SqlStorage;
  hosted: Option.Option<HostedDashboardAdmission>;
}>;
type BrowserWork = Work & Readonly<{ lookup: BoundWebSessionLookup }>;
const standingStatement = ({ unit, lookup, current }: Work): D1PreparedStatement =>
  quotaStatusForUserSelection({
    db: unit.database,
    current,
    users: { sql: `SELECT userId FROM (${lookup.statement.sql})`, params: lookup.statement.params },
  });
const absent = (): NativeDashboardResult => ({
  kind: "response",
  response: {
    status: 404,
    body: {
      error: {
        code: "dashboard_uninitialized",
        message: "Initialize your Dashboard explicitly, then read it again.",
      },
      next: [],
    },
    headers: transactionNoStore,
  },
});
class HostedHistoryExhausted extends Data.TaggedError("HostedHistoryExhausted") {}
const accountHostedHistory = (work: Work, output: unknown): void => {
  const { unit, lookup, current } = work;
  if (Option.isSome(work.hosted) && dashboardLoadsSavedHistory(output)) {
    try {
      unit.run(
        prepareConsumption({
          db: unit.database,
          userId: work.hosted.value.subject.userId,
          allowance: "hosted_history_turn",
          identity: work.hosted.value.turnId,
          current,
          authority: lookup.statement,
        })
      );
    } catch (cause) {
      if (quotaFailure(cause) === "exhausted") throw new HostedHistoryExhausted();
      throw cause;
    }
  }
};
const audited = (work: Work, output?: unknown): unknown => {
  const { unit, lookup, current } = work;
  accountHostedHistory(work, output);
  const activity = Option.map(work.activity, (subject) => recordLivePATUse({ subject, current }));
  const rows = unit.run([
    ...Option.toArray(
      Option.map(activity, ({ sql, params }) => unit.database.prepare(sql).bind(...params))
    ),
    prepareAuthorizedAuditCall({
      db: unit.database,
      authority: lookup.authority,
      id: transactionId(),
      current,
      operation: "dashboard.getDashboardView",
      outcome: "accepted",
      afterOwnerWrite: false,
    }),
    prepareReservedChangeCheck({
      db: unit.database,
      scope: "dashboard",
      reservation: lookup.statement,
    }),
    standingStatement(work),
  ]);
  const auditIndex = Option.isSome(activity) ? 1 : 0;
  if (rows[auditIndex]?.meta.changes !== 1 || (auditIndex === 1 && rows[0]?.meta.changes !== 1)) {
    throw new Error("Dashboard Audit refused");
  }
  return rows.at(-1)?.results[0];
};
type Retained = Readonly<{
  document: typeof DocumentRow.Type;
  context: UserContext;
  categories: ReadonlyArray<Category>;
}>;
const retainedDashboard = ({ unit, lookup }: Work): Option.Option<Retained> => {
  const categories = prepareCategorySnapshot({ db: unit.database, authority: lookup.authority });
  const rows = unit.run([
    prepareSelectedUserDocument({
      db: unit.database,
      userSelection: lookup.statement,
      kind: "dashboard",
    }),
    prepareSelectedUserContext({ db: unit.database, userSelection: lookup.statement }),
    categories.statement,
  ]);
  const documents = Schema.decodeUnknownSync(
    Schema.Array(DocumentRow).check(Schema.isMaxLength(1))
  )(rows[0]?.results);
  const document = documents[0];
  if (document === undefined) return Option.none();
  return Option.some({
    document,
    context: Schema.decodeUnknownSync(Schema.Tuple([UserContext]))(rows[1]?.results)[0],
    categories: Option.getOrThrow(categories.decode(rows[2]?.results)),
  });
};
type Admission =
  | Readonly<{ subject: AuthenticatedWebSession }>
  | Readonly<{ result: NativeDashboardResult }>;
const recoverAdmission = (work: BrowserWork, cause: unknown): Admission => {
  if (!canonicalSnapshotPressureRefusal(cause)) throw cause;
  const { unit, lookup, current } = work;
  const rows = unit.run([
    unit.database.prepare(lookup.statement.sql).bind(...lookup.statement.params),
    standingStatement(work),
  ]);
  const subject = resolveBoundCanonicalWebSession({ lookup, row: rows[0]?.results[0] });
  if (Option.isNone(subject)) return { result: failure("unauthenticated") };
  const result = failure("rate_limited");
  return {
    result: {
      ...result,
      response: attachCanonicalSnapshotStanding({
        response: result.response,
        row: rows[1]?.results[0],
        current,
      }),
    },
  };
};
const admitSnapshot = (work: BrowserWork): Admission => {
  const { unit, lookup, current } = work;
  try {
    const rows = unit.run(
      prepareCanonicalSnapshotAdmission({ db: unit.database, lookup, current })
    );
    const subject = resolveBoundCanonicalWebSession({ lookup, row: rows[3]?.results[0] });
    return Option.isSome(subject)
      ? { subject: subject.value }
      : { result: failure("unauthenticated") };
  } catch (cause) {
    return recoverAdmission(work, cause);
  }
};
type FinancialProjection = Readonly<{ response: CanonicalSnapshotResponse }> &
  (
    | Readonly<{ kind: "absent" }>
    | Readonly<{ kind: "view"; facts: ReturnType<typeof sqliteDashboardView> }>
  );
const financialProjection = (
  work: Work,
  userId: string,
  binding: Option.Option<string>
): FinancialProjection => {
  const { current, sql } = work;
  const retained = retainedDashboard(work);
  const document = Option.isSome(retained) ? retained.value.document : undefined;
  const headers = Option.match(binding, {
    onNone: () => ({}),
    onSome: (id) => ({ [browserSessionBindingHeader]: id }),
  });
  if (document === undefined) {
    const result = absent();
    return {
      kind: "absent",
      response: attachCanonicalSnapshotStanding({
        current,
        row: audited(work),
        response: {
          ...result.response,
          headers: { ...result.response.headers, ...headers },
        },
      }),
    } as const;
  }
  const peers = Option.getOrThrow(retained);
  const facts = sqliteDashboardView({
    sql,
    userId,
    current,
    document: document.encoded,
    context: peers.context,
    categories: peers.categories,
  });
  const body = { data: encodeView({ ...facts.view, revision: document.revision }), next: [] };
  const response = attachCanonicalSnapshotStanding({
    current,
    row: audited(work, body),
    response: {
      status: 200,
      body,
      headers: { ...transactionNoStore, etag: `"${document.revision}"`, ...headers },
    },
  });
  return { kind: "view", response, facts } as const;
};
const financialSnapshot = (
  work: Work,
  subject: AuthenticatedWebSession,
  mode: NativeDashboardRead["input"]["mode"]
): NativeDashboardResult => {
  const projection = financialProjection(work, subject.userId, Option.some(subject.id));
  if (projection.kind === "absent") return { kind: "response", response: projection.response };
  return {
    kind: "view",
    response: projection.response,
    binding: Schema.decodeSync(WebSessionId)(subject.id),
    measurement: projection.facts.measurement,
    ...(mode === "document" ? { html: renderDashboardHtml(projection.facts.view) } : {}),
  };
};

const snapshot = (
  work: BrowserWork,
  mode: NativeDashboardRead["input"]["mode"]
): NativeDashboardResult => {
  const admission = admitSnapshot(work);
  if ("result" in admission) return admission.result;
  const subject = admission.subject;
  const bootstrap =
    mode === "document"
      ? Schema.encodeSync(BrowserSessionBinding)({
          binding: Schema.decodeSync(WebSessionId)(subject.id),
          initial: Option.some(
            Effect.runSync(
              readWebSessionSnapshotContext({
                db: work.unit.database,
                subject,
                current: work.current,
                execute: work.unit.run,
              })
            )
          ),
        })
      : undefined;
  return {
    ...financialSnapshot(work, subject, mode),
    ...(bootstrap === undefined ? {} : { bootstrap }),
  };
};
const validate = (result: NativeDashboardResult): NativeDashboardResult => {
  if (new TextEncoder().encode(encodeResult(result)).byteLength > maximumResultBytes) {
    throw new Error("Dashboard result exceeds resource budget");
  }
  return result;
};
const formatted = (result: NativeDashboardResult, request: Request): NativeDashboardResult => {
  if (
    request.headers.get("accept") !== "text/html" ||
    result.response.status !== successfulStatus
  ) {
    return validate(result);
  }
  const value = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DashboardViewSnapshot) })
  )(result.response.body);
  const html = renderDashboardHtml(value.data);
  if (new TextEncoder().encode(html).byteLength > maximumHtmlBytes) {
    throw new Error("Dashboard HTML exceeds resource budget");
  }
  return validate({ ...result, html });
};
const consentRefusal = (): NativeDashboardResult => ({
  kind: "response",
  response: {
    status: 403,
    body: {
      error: {
        code: "user_action_required",
        message: "Return to Fidy to review your withdrawn Consent.",
      },
      next: [],
    },
    headers: transactionNoStore,
  },
});
const credentialWork = (
  input: Readonly<{
    read: NativeDashboardRead;
    unit: Unit;
    current: number;
    authority: AuditAuthority;
    activity: Option.Option<AuthorizedPAT>;
  }>
): Work => {
  const authority = input.authority;
  return {
    unit: input.unit,
    current: input.current,
    sql: input.read.storage.sql,
    activity: input.activity,
    hosted: Option.none(),
    lookup: {
      authority,
      statement: {
        sql: `SELECT user_id AS userId FROM ${authority.table} WHERE ${authority.predicate}`,
        params: authority.bindings,
      },
    },
  };
};
const patSnapshot = (
  input: Readonly<{
    read: NativeDashboardRead;
    unit: Unit;
    current: number;
    material: Option.Option<CanonicalPATMaterial>;
    prepared: CanonicalSnapshotMaterial;
  }>
): NativeDashboardResult => {
  const { read, unit, current, material, prepared } = input;
  const request = read.input.request;
  const finish = (response: CanonicalSnapshotResponse): NativeDashboardResult =>
    formatted(
      {
        kind: "response",
        response: protectCanonicalSnapshotSource({
          db: unit.database,
          request,
          current,
          execute: unit.run,
          response,
        }),
      },
      request
    );
  if (Option.isNone(material)) return finish(failure("unauthenticated").response);
  const subject = resolveCanonicalPATSnapshot({
    db: unit.database,
    material: material.value,
    operation: prepared.operation,
    current,
    execute: unit.run,
  });
  if (subject === "unauthenticated") return finish(failure("unauthenticated").response);
  if (subject === "user_action_required") return consentRefusal();
  const work = credentialWork({
    read,
    unit,
    current,
    authority: livePATAuthority({ subject, current }),
    activity: Option.some(subject),
  });
  return finish(
    runCanonicalSnapshotAdmission({
      db: unit.database,
      caller: { _tag: "PAT", value: subject },
      current,
      material: prepared,
      execute: unit.run,
      work: () => financialProjection(work, subject.userId, Option.none()).response,
    })
  );
};
const readPATSnapshot = (read: NativeDashboardRead): Effect.Effect<NativeDashboardResult> =>
  Effect.gen(function* () {
    const request = read.input.request;
    if (request.method !== "GET" || new URL(request.url).pathname !== "/dashboard/view") {
      return unavailable();
    }
    const operation = yield* Effect.try(() =>
      Option.getOrThrow(
        Option.fromUndefinedOr(getBoundOperationCatalog().byId.get("dashboard.getDashboardView"))
      )
    );
    const binding = yield* Effect.tryPromise(() => prepareCanonicalBrowserBinding(request));
    const material = yield* prepareCanonicalPATMaterial(request);
    const prepared = yield* prepareCanonicalSnapshotMaterial({ request, operation });
    const unit = makeSqliteDatabaseUnit(read.storage);
    const fence = yield* prepareRecoveryGenerationFence({ db: unit.database, bucket: read.bucket });
    const services = yield* Effect.context<never>();
    return yield* Effect.try(() =>
      read.storage.transactionSync(() => {
        if (!read.admitted()) throw new Error("Dashboard admission closed");
        const current = Effect.runSyncWith(services)(Clock.currentTimeMillis);
        unit.run([fence]);
        if (
          !acceptsCanonicalBrowserBinding({
            db: unit.database,
            current,
            execute: unit.run,
            binding,
          })
        ) {
          return failure("unauthenticated");
        }
        return patSnapshot({ read, unit, current, material, prepared });
      })
    );
  }).pipe(Effect.orElseSucceed(unavailable));

const oauthSnapshot = (
  input: Readonly<{
    read: NativeDashboardRead;
    unit: Unit;
    current: number;
    subject: OAuthCaller;
    prepared: CanonicalSnapshotMaterial;
  }>
): NativeDashboardResult => {
  const { read, unit, current, prepared } = input;
  const subject = resolveCanonicalOAuthSnapshot({
    db: unit.database,
    subject: input.subject,
    current,
    execute: unit.run,
  });
  if (subject === "unauthenticated") return failure("unauthenticated");
  if (subject === "user_action_required") return consentRefusal();
  const work = credentialWork({
    read,
    unit,
    current,
    authority: liveOAuthAuthority({
      subject: { ...subject, requiredScope: Option.some("read") },
      current,
    }),
    activity: Option.none(),
  });
  return validate({
    kind: "response",
    response: runCanonicalSnapshotAdmission({
      db: unit.database,
      caller: { _tag: "OAuth", value: subject },
      current,
      material: prepared,
      execute: unit.run,
      work: () => financialProjection(work, subject.userId, Option.none()).response,
    }),
  });
};
const readOAuthSnapshot = (read: NativeDashboardRead): Effect.Effect<NativeDashboardResult> =>
  Effect.gen(function* () {
    const input = read.input;
    if (input.mode !== "oauth" || input.admission.operation !== "dashboard.getDashboardView") {
      return unavailable();
    }
    const operation = yield* Effect.try(() =>
      Option.getOrThrow(
        Option.fromUndefinedOr(getBoundOperationCatalog().byId.get("dashboard.getDashboardView"))
      )
    );
    const prepared = yield* prepareCanonicalSnapshotMaterial({
      operation,
      canonicalInput: input.admission.input,
      retryKey: Option.fromUndefinedOr(input.admission.retryKey),
    });
    const unit = makeSqliteDatabaseUnit(read.storage);
    const fence = yield* prepareRecoveryGenerationFence({ db: unit.database, bucket: read.bucket });
    const services = yield* Effect.context<never>();
    return yield* Effect.try(() =>
      read.storage.transactionSync(() => {
        if (!read.admitted()) throw new Error("Dashboard admission closed");
        const current = Effect.runSyncWith(services)(Clock.currentTimeMillis);
        if (current >= input.admission.deadlineMilliseconds) return unavailable();
        unit.run([fence]);
        const result = oauthSnapshot({
          read,
          unit,
          current,
          prepared,
          subject: {
            userId: input.admission.userId,
            oauthConnectionId: input.admission.connectionId,
            credentialId: input.admission.credentialId,
            clientId: input.admission.clientId,
            resource: input.admission.resource,
            digest: new Uint8Array(input.admission.digest),
            requiredScope: Option.none(),
          },
        });
        if (
          Effect.runSyncWith(services)(Clock.currentTimeMillis) >=
          input.admission.deadlineMilliseconds
        ) {
          throw new Error("Dashboard handoff expired before commit");
        }
        return result;
      })
    );
  }).pipe(Effect.orElseSucceed(unavailable));

const hostedAuthority = (admission: HostedDashboardAdmission, current: number): AuditAuthority => {
  const subject = admission.subject;
  const turn = prepareHostedDashboardTurn({ admission, current });
  if (subject._tag === "Browser") {
    const credential = protectConsentAuthority({
      authority: liveWebSessionAuthority({
        subject: { userId: subject.userId, id: subject.id, digest: new Uint8Array(subject.digest) },
        current,
      }),
      subject: { _tag: "Owner", column: "web_sessions.user_id" },
      requirement: "active",
    });
    return {
      ...credential,
      predicate: `(${credential.predicate}) AND EXISTS (${turn.sql})`,
      bindings: [...credential.bindings, ...turn.params],
    };
  }
  const live = protectConsentStatement({
    statement: whatsAppIdentityQuery(subject),
    subject: { _tag: "User", userId: subject.userId },
    requirement: "active",
  });
  return {
    table: "hosted_turns",
    predicate: `id=? AND user_id=? AND id IN (${turn.sql}) AND EXISTS (${live.sql})`,
    bindings: [admission.turnId, subject.userId, ...turn.params, ...live.params],
  };
};
const hostedHistoryRefusal = ({ unit, lookup, current }: Work): NativeDashboardResult => {
  const rows = unit.run([
    prepareAuthorizedAuditCall({
      db: unit.database,
      authority: lookup.authority,
      id: transactionId(),
      current,
      operation: "dashboard.getDashboardView",
      outcome: "rejected",
      afterOwnerWrite: false,
    }),
  ]);
  if (rows[0]?.meta.changes !== 1) throw new Error("Dashboard Audit refused");
  return {
    kind: "response",
    response: {
      status: 429,
      body: {
        error: {
          code: "quota_exhausted",
          allowance: "hosted_history_turn",
          resetsAt: DateTime.formatIso(allowancePeriod(DateTime.makeUnsafe(current)).resetsAt),
        },
        next: [],
      },
      headers: transactionNoStore,
    },
  };
};
const hostedSnapshot = (
  input: Readonly<{
    read: NativeDashboardRead;
    unit: Unit;
    current: number;
    admission: HostedDashboardAdmission;
  }>
): NativeDashboardResult => {
  const { read, unit, current, admission } = input;
  const work: Work = {
    ...credentialWork({
      read,
      unit,
      current,
      authority: hostedAuthority(admission, current),
      activity: Option.none(),
    }),
    hosted: Option.some(admission),
  };
  if (
    unit.run([
      unit.database.prepare(work.lookup.statement.sql).bind(...work.lookup.statement.params),
    ])[0]?.results.length !== 1
  ) {
    return failure("unauthenticated");
  }
  try {
    return validate({
      kind: "response",
      response: financialProjection(work, admission.subject.userId, Option.none()).response,
    });
  } catch (cause) {
    if (!(cause instanceof HostedHistoryExhausted)) throw cause;
    return hostedHistoryRefusal(work);
  }
};
const readHostedSnapshot = (read: NativeDashboardRead): Effect.Effect<NativeDashboardResult> =>
  Effect.gen(function* () {
    const input = read.input;
    if (input.mode !== "hosted") return unavailable();
    const unit = makeSqliteDatabaseUnit(read.storage);
    const fence = yield* prepareRecoveryGenerationFence({ db: unit.database, bucket: read.bucket });
    const services = yield* Effect.context<never>();
    return yield* Effect.try(() =>
      read.storage.transactionSync(() => {
        if (!read.admitted()) throw new Error("Dashboard admission closed");
        const current = Effect.runSyncWith(services)(Clock.currentTimeMillis);
        if (current >= input.admission.deadlineMilliseconds) return unavailable();
        unit.run([fence]);
        const result = hostedSnapshot({ read, unit, current, admission: input.admission });
        if (
          Effect.runSyncWith(services)(Clock.currentTimeMillis) >=
          input.admission.deadlineMilliseconds
        ) {
          throw new Error("Dashboard handoff expired before commit");
        }
        return result;
      })
    );
  }).pipe(Effect.orElseSucceed(unavailable));

const browserSnapshotRequest = (request: Request, browserOrigin: string): boolean =>
  request.method === "GET" &&
  new URL(request.url).pathname === "/dashboard/view" &&
  new URL(request.url).search === "" &&
  request.headers.get("origin") === browserOrigin;

/** No database work precedes the native unit; the external generation and cookie digest grant no reusable authority. */
export const readAuditedSqliteDashboard = (
  read: NativeDashboardRead
): Effect.Effect<NativeDashboardResult> =>
  Effect.gen(function* () {
    const request = read.input.request;
    const mode = read.input.mode;
    if (mode === "hosted") return yield* readHostedSnapshot(read);
    if (mode === "oauth") return yield* readOAuthSnapshot(read);
    if (mode !== "document" && request.headers.has("authorization")) {
      return yield* readPATSnapshot(read);
    }
    if (!browserSnapshotRequest(request, read.browserOrigin)) {
      return unavailable();
    }
    const material = yield* Effect.tryPromise(() =>
      prepareBrowserSessionMaterial({ request, mode })
    );
    if (Option.isNone(material)) return failure("unauthenticated");
    const unit = makeSqliteDatabaseUnit(read.storage);
    const fence = yield* prepareRecoveryGenerationFence({ db: unit.database, bucket: read.bucket });
    const services = yield* Effect.context<never>();
    return yield* Effect.try(() =>
      read.storage.transactionSync(() => {
        if (!read.admitted()) throw new Error("Dashboard admission closed");
        const current = Effect.runSyncWith(services)(Clock.currentTimeMillis);
        const lookup = currentBrowserSessionLookup({ ...material.value, current });
        unit.run([fence]);
        return formatted(
          snapshot(
            {
              unit,
              lookup,
              current,
              sql: read.storage.sql,
              activity: Option.none(),
              hosted: Option.none(),
            },
            mode
          ),
          request
        );
      })
    );
  }).pipe(Effect.orElseSucceed(unavailable));

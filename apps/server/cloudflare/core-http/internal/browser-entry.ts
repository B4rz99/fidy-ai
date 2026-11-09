import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { UserContext, UserId } from "../../../src/core/identity/contract";
import { prepareUserContext } from "../../identity/user-context/operations";
import { type Cause, Clock, DateTime, Duration, Effect, Option, Schema } from "effect";
import { newId } from "../../secret-material/operations";
import { browserSessionBindingPath } from "~/shell/browser-transport/contract";
import { prepareBrowserTransactionPage } from "../../transactions/operations";

import {
  BrowserSessionBinding,
  type BrowserSessionInitialContext,
  type InitialTransactionPage,
} from "../../../src/shell/web-session/contract";
import type { CurrentUserMetadata } from "../../../src/shell/identity/contract";
import {
  decodeProcessingConsentStatusRead,
  prepareProcessingConsentStatusRead,
  prepareSelectedProcessingConsentRead,
} from "../../../src/shell/processing-consent/operations";
import {
  browserSessionBindingResponse,
  prepareBrowserEntryLookup,
  prepareBrowserMetadata,
  type readCurrentWebSessionMetadata,
  type readWebSessionEntry,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import type {
  AuthenticatedWebSession,
  BoundWebSessionLookup,
  WebSessionRequest,
} from "../../web-session/contract";
import {
  prepareBrowserObservationProtection,
  releaseBrowserObservation,
} from "../../canonical-admission/operations";

type Input = WebSessionRequest & Readonly<{ browserOrigin: string }>;
type StartupPhase = "source" | "disclosure";
type StartupTimings = Record<StartupPhase, number>;
type EntryError =
  | Effect.Error<ReturnType<typeof readWebSessionEntry>>
  | Effect.Error<ReturnType<typeof readCurrentWebSessionMetadata>>
  | Schema.SchemaError;
type TimedInput = Input & Readonly<{ timings: StartupTimings }>;
const measurePhase = <A, E>(
  phase: StartupPhase,
  work: Effect.Effect<A, E>,
  timings: StartupTimings
): Effect.Effect<A, E> =>
  work.pipe(
    Effect.timed,
    Effect.map(([duration, result]) => {
      timings[phase] += Duration.toMillis(duration);
      return result;
    })
  );
const appendStartupTimings = (
  response: Response,
  timings: StartupTimings,
  duration: Duration.Duration
): Response => {
  const total = Duration.toMillis(duration);
  const { source, disclosure } = timings;
  const phases = {
    bootstrap: total,
    "bootstrap-source": source,
    "bootstrap-disclosure": disclosure,
    "bootstrap-other": Math.max(0, total - source - disclosure),
  };
  response.headers.append(
    "server-timing",
    Object.entries(phases)
      .map(([name, elapsed]) => `${name};dur=${elapsed}`)
      .join(", ")
  );
  return response;
};

const finalContextIndex = -3;
const finalReceiptIndex = -2;
const maximumInitialResponseBytes = 65_536;
const noStore = { "cache-control": "no-store" };
const unavailableStatus = 503;
const forbiddenStatus = 403;
const invalidStatus = 400;
const refusalCode = (status: number): string => {
  if (status === forbiddenStatus) return "forbidden";
  if (status === invalidStatus) return "validation_failed";
  return "unavailable";
};
const refused = (status: number): Response =>
  Response.json(
    {
      error: { code: refusalCode(status), message: "The operation is unavailable. Retry later." },
      next: [],
    },
    { status, headers: noStore }
  );

const reply = (
  binding: Option.Option<string>,
  initial: Option.Option<BrowserSessionInitialContext>
): Effect.Effect<Response, Schema.SchemaError> =>
  Schema.decodeEffect(BrowserSessionBinding.fields.binding)(Option.getOrNull(binding)).pipe(
    Effect.flatMap((binding) => Schema.encodeEffect(BrowserSessionBinding)({ binding, initial })),
    Effect.map((body) => {
      const initial = body.initial;
      if (
        initial?.status === "Granted" &&
        initial.transactions !== undefined &&
        new TextEncoder().encode(JSON.stringify(body)).byteLength > maximumInitialResponseBytes
      ) {
        return Response.json(
          { ...body, initial: { status: "Granted", withdrawal: null, profile: initial.profile } },
          { headers: noStore }
        );
      }
      return Response.json(body, { headers: noStore });
    })
  );

type InitialPageRead = Readonly<{
  from: DateTime.Utc;
  to: DateTime.Utc;
  statements: ReadonlyArray<D1PreparedStatement>;
  decode: (rows: ReadonlyArray<D1Result>) => Option.Option<InitialTransactionPage["page"]>;
}>;
const prepareInitialTransactions = ({
  input,
  subject,
  profile,
  current,
}: Readonly<{
  input: Input;
  subject: AuthenticatedWebSession;
  profile: typeof CurrentUserMetadata.Type;
  current: number;
}>): Option.Option<InitialPageRead> => {
  if (new URL(input.request.url).searchParams.get("context") !== "transactions") {
    return Option.none();
  }
  const now = DateTime.setZone(
    DateTime.makeUnsafe(current),
    DateTime.zoneMakeNamedUnsafe(profile.data.timeZone)
  );
  const from = DateTime.toUtc(DateTime.startOf(now, "month"));
  const to = DateTime.toUtc(DateTime.add(DateTime.startOf(now, "month"), { months: 1 }));
  const url = new URL("https://core.internal/transactions");
  url.searchParams.set("from", DateTime.formatIso(from));
  url.searchParams.set("to", DateTime.formatIso(to));
  url.searchParams.set("limit", "25");
  return Option.map(
    prepareBrowserTransactionPage({ db: input.db, request: new Request(url), subject, current }),
    (prepared) => ({ ...prepared, from, to })
  );
};

const grantedReply = (
  subject: AuthenticatedWebSession,
  profile: Option.Option<typeof CurrentUserMetadata.Type>,
  transactions: Option.Option<InitialTransactionPage>
): Effect.Effect<Response, Schema.SchemaError> =>
  Option.isSome(profile) && profile.value.data.id === subject.userId
    ? reply(
        Option.some(subject.id),
        Option.some({
          status: "Granted",
          withdrawal: null,
          profile: profile.value,
          transactions,
        })
      )
    : Effect.sync(() => {
        const response = refused(unavailableStatus);
        response.headers.set("server-timing", 'bootstrap-metadata;desc="unavailable"');
        return response;
      });

const validContextRequest = (request: Request): boolean => {
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    url.searchParams.size === 1 &&
    ["application", "transactions"].includes(url.searchParams.get("context") ?? "")
  );
};

const sameInitialContext = (
  profile: Option.Option<typeof CurrentUserMetadata.Type>,
  row: unknown
): boolean =>
  Option.isSome(profile) &&
  Option.match(Schema.decodeUnknownOption(UserContext)(row), {
    onNone: () => false,
    onSome: (context) => context.timeZone === profile.value.data.timeZone,
  });

const finalContext = ({
  input,
  subject,
  profile,
  id,
}: Readonly<{
  input: TimedInput;
  subject: AuthenticatedWebSession;
  profile: Option.Option<typeof CurrentUserMetadata.Type>;
  id: string;
}>): Effect.Effect<Response, EntryError | Cause.UnknownError> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const page = Option.flatMap(profile, (profile) =>
      prepareInitialTransactions({ input, subject, profile, current })
    );
    const status = prepareProcessingConsentStatusRead({ subject, current });
    const context = prepareUserContext({
      db: input.db,
      userId: UserId.make(subject.userId),
      statement: {
        sql: "SELECT serviceMarket, locale, timeZone FROM identity_user_context",
        params: [],
      },
    });
    const rows = yield* measurePhase(
      "disclosure",
      Effect.tryPromise(() =>
        input.db.batch([
          ...Option.toArray(Option.map(page, (value) => value.statements)).flat(),
          context,
          input.db.prepare(status.sql).bind(...status.params),
          input.db
            .prepare("DELETE FROM canonical_request_leases WHERE id = ? AND user_id = ?")
            .bind(id, subject.userId),
        ])
      ).pipe(Effect.uninterruptible),
      input.timings
    );
    const receipt = yield* decodeProcessingConsentStatusRead(
      rows.at(finalReceiptIndex)?.results ?? []
    );
    if (Option.isNone(receipt)) return yield* reply(Option.none(), Option.none());
    if (receipt.value.status !== "Granted") {
      return yield* reply(Option.some(subject.id), Option.some(receipt.value));
    }
    if (!sameInitialContext(profile, rows.at(finalContextIndex)?.results[0])) {
      return refused(unavailableStatus);
    }
    const transactions = Option.flatMap(page, (value) =>
      Option.map(value.decode(rows), (loaded) => ({
        from: value.from,
        to: value.to,
        page: loaded,
      }))
    );
    return yield* grantedReply(subject, profile, transactions);
  });

const applicationContext = ({
  input,
  lookup,
  presented,
  current,
}: Readonly<{
  input: TimedInput;
  lookup: BoundWebSessionLookup;
  presented: OwnedStatement;
  current: number;
}>): Effect.Effect<Response, EntryError | Cause.UnknownError> =>
  Effect.gen(function* () {
    const metadata = prepareBrowserMetadata({ db: input.db, lookup, current });
    const protection = prepareBrowserObservationProtection({
      db: input.db,
      lookup,
      current,
      leaseId: Option.none(),
    });
    const status = prepareSelectedProcessingConsentRead(lookup.statement);
    const rows = yield* measurePhase(
      "source",
      Effect.tryPromise(() =>
        input.db.batch([
          ...protection,
          ...metadata.statements,
          input.db.prepare(status.sql).bind(...status.params),
          input.db.prepare(presented.sql).bind(...presented.params),
        ])
      ).pipe(Effect.uninterruptible),
      input.timings
    );
    const subject = resolveBoundCanonicalWebSession({
      lookup,
      row: rows[protection.length - 1]?.results[0],
    });
    if (Option.isNone(subject)) {
      return rows.at(-1)?.results.length === 1
        ? refused(forbiddenStatus)
        : yield* reply(Option.none(), Option.none());
    }
    const receipt = yield* decodeProcessingConsentStatusRead(
      rows.at(finalReceiptIndex)?.results ?? []
    );
    return yield* Option.match(receipt, {
      onNone: () => reply(Option.none(), Option.none()),
      onSome: (value) =>
        value.status === "Granted"
          ? metadata
              .decode(rows.slice(protection.length, protection.length + metadata.statements.length))
              .pipe(
                Effect.flatMap((profile) => grantedReply(subject.value, profile, Option.none()))
              )
          : reply(Option.some(subject.value.id), Option.some(value)),
    });
  });

const leasedContext = ({
  input,
  lookup,
  presented,
  current,
}: Readonly<{
  input: TimedInput;
  lookup: BoundWebSessionLookup;
  presented: OwnedStatement;
  current: number;
}>): Effect.Effect<Response, EntryError | Cause.UnknownError> =>
  Effect.uninterruptibleMask((restore) => {
    const id = newId();
    let released = false;
    return Effect.gen(function* () {
      const metadata = prepareBrowserMetadata({ db: input.db, lookup, current });
      const protection = prepareBrowserObservationProtection({
        db: input.db,
        lookup,
        current,
        leaseId: Option.some(id),
      });
      const rows = yield* measurePhase(
        "source",
        Effect.tryPromise(() =>
          input.db.batch([
            ...protection,
            ...metadata.statements,
            input.db.prepare(presented.sql).bind(...presented.params),
          ])
        ),
        input.timings
      );
      const subject = resolveBoundCanonicalWebSession({
        lookup,
        row: rows[protection.length - 1]?.results[0],
      });
      if (Option.isNone(subject)) {
        return rows.at(-1)?.results.length === 1
          ? refused(forbiddenStatus)
          : yield* reply(Option.none(), Option.none());
      }
      const profile = yield* metadata.decode(
        rows.slice(protection.length, protection.length + metadata.statements.length)
      );
      const response = yield* restore(finalContext({ input, subject: subject.value, profile, id }));
      released = true;
      return response;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          released ? Effect.void : releaseBrowserObservation({ db: input.db, id })
        )
      )
    );
  });

/** Resolve metadata once, then disclose dependent history under fresh credential and Consent proof. */
const readContext = (input: TimedInput): Effect.Effect<Response, EntryError | Cause.UnknownError> =>
  Effect.gen(function* () {
    if (input.request.headers.get("origin") !== input.browserOrigin) {
      return refused(forbiddenStatus);
    }
    if (!validContextRequest(input.request)) return refused(invalidStatus);
    const current = yield* Clock.currentTimeMillis;
    const lookup = yield* Effect.tryPromise(() =>
      prepareBrowserEntryLookup({ request: input.request, current })
    );
    return yield* Option.match(lookup, {
      onNone: () => reply(Option.none(), Option.none()),
      onSome: (prepared) =>
        new URL(input.request.url).searchParams.get("context") === "application"
          ? applicationContext({ input, ...prepared, current })
          : leasedContext({ input, ...prepared, current }),
    });
  });

const contextResponse = (input: Input): Effect.Effect<Response> =>
  Effect.suspend(() => {
    const timings: StartupTimings = { source: 0, disclosure: 0 };
    return readContext({ ...input, timings }).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          if (
            failure !== undefined &&
            "cause" in failure &&
            failure.cause instanceof Error &&
            /canonical_request_(rate|concurrency)/u.test(failure.cause.message)
          ) {
            return Response.json(
              {
                error: {
                  code: "rate_limited",
                  message: "Too many concurrent or recent requests. Retry later.",
                  retryAfterSeconds: 1,
                },
                next: [],
              },
              { status: 429, headers: { ...noStore, "retry-after": "1" } }
            );
          }
          const response = refused(unavailableStatus);
          response.headers.set("server-timing", 'bootstrap-read;desc="failed"');
          return response;
        })
      ),
      Effect.timed,
      Effect.map(([duration, response]) => appendStartupTimings(response, timings, duration))
    );
  });

/** Handle document binding entry only; each protected route owner validates its mounted request. */
export const initialBrowserSessionBindingResponse = (
  input: Input
): Effect.Effect<Option.Option<Response>> => {
  const url = new URL(input.request.url);
  if (url.pathname !== browserSessionBindingPath) return Effect.succeedNone;
  return url.searchParams.size > 0
    ? contextResponse(input).pipe(Effect.asSome)
    : browserSessionBindingResponse(input);
};

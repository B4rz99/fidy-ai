import { SecureRandom } from "effect/crypto";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { authenticateAccess, makeProtectedClient } from "../../apps/cli/src/direct-client/runtime";
import {
  type ProCommand,
  ProGrantEntry,
  ProGrantFailure,
  ProOperatorCommand,
  ProPage,
  ProTarget,
  betaProPath,
  maximumProGrants,
} from "../../apps/server/src/shell/pro-grants/contract";

const unauthorizedStatus = 401,
  forbiddenStatus = 403,
  conflictStatus = 409,
  invalidStatus = 400;

const okStatus = 200,
  missingStatus = 404;

const url = `https://api.fidyapp.com${betaProPath}` as const;

const failed = (reason: ProGrantFailure["reason"]): ProGrantFailure =>
  new ProGrantFailure({ reason });

type Submit = (command: typeof ProOperatorCommand.Type) => Effect.Effect<unknown, ProGrantFailure>;

const makeProClient = Effect.fn(function* () {
  const proof = yield* authenticateAccess(url).pipe(Effect.mapError(() => failed("unavailable")));
  yield* Effect.addFinalizer(() => Effect.sync(() => Redacted.wipeUnsafe(proof)));

  const client = makeProtectedClient({
    client: yield* HttpClient.HttpClient,
    allowQuery: false,
    maximumRequestBytes: 1536,
    maximumResponseBytes: 4096,
    captureRetry: () => {},
    captureAllowance: () => {},
    captureTrace: () => {},
  });

  const submit: Submit = Effect.fn(function* (command) {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ProOperatorCommand))(
      command
    ).pipe(Effect.mapError(() => failed("invalid-input")));

    const response = yield* client
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("cf-access-token", Redacted.value(proof)),
          HttpClientRequest.bodyText(body, "application/json")
        )
      )
      .pipe(Effect.mapError(() => failed("unavailable")));

    if ([unauthorizedStatus, forbiddenStatus].includes(response.status)) {
      return yield* failed("denied");
    }

    if (response.status === conflictStatus) return yield* failed("conflict");

    if (response.status === invalidStatus) return yield* failed("invalid-input");

    if (response.status === missingStatus) return yield* failed("user-not-found");

    if (response.status !== okStatus) return yield* failed("unavailable");

    return yield* response.text.pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))),
      Effect.mapError(() => failed("unavailable"))
    );
  });

  return submit;
});

export class ProClient extends Context.Service<ProClient, { readonly submit: Submit }>()(
  "fidy-ai/scripts/pro/runtime/ProClient"
) {
  static readonly make = Effect.map(makeProClient(), (submit) => ({ submit }));

  static readonly layer = Layer.effect(this, this.make);
}

type Cursor = (typeof ProPage.Type)["next"];

const advances = (before: Cursor, next: Cursor): boolean =>
  next === null ||
  (next.after > (before?.after ?? 0) &&
    next.after <= next.through &&
    (before === null || before.through === next.through));

const admitPage = (
  entries: Map<string, typeof ProGrantEntry.Type>,
  rows: (typeof ProPage.Type)["entries"]
): boolean => {
  for (const row of rows) {
    if (row.action !== "grant" || entries.has(row.userId) || entries.size >= maximumProGrants) {
      return false;
    }

    entries.set(row.userId, row);
  }

  return true;
};

const list = Effect.fn(function* (submit: Submit) {
  const entries = new Map<string, typeof ProGrantEntry.Type>();
  let cursor: (typeof ProPage.Type)["next"] = null;

  do {
    const previous: typeof cursor = cursor;

    const page: typeof ProPage.Type = yield* Schema.decodeUnknownEffect(ProPage)(
      yield* submit(cursor === null ? { action: "list" } : { action: "list", cursor })
    ).pipe(Effect.mapError(() => failed("unavailable")));

    if (!admitPage(entries, page.entries)) return yield* failed("unavailable");

    cursor = page.next;

    if (!advances(previous, cursor)) return yield* failed("unavailable");
  } while (cursor !== null);

  return [...entries.values()].sort((first, second) => first.userId.localeCompare(second.userId));
});

const resolveTarget = Effect.fn(function* (
  selector: Extract<ProCommand, { selector: unknown }>["selector"],
  submit: Submit
) {
  if ("userId" in selector) return { userId: selector.userId };

  const selected = yield* Schema.decodeUnknownEffect(ProTarget)(
    yield* submit({ action: "resolve", email: selector.email })
  ).pipe(Effect.mapError(() => failed("unavailable")));

  return {
    userId: selected.userId,
    mailbox: { email: selector.email, revision: selected.revision },
  };
});

export const runProCommand = Effect.fn(function* (command: ProCommand, submit: Submit) {
  if (command.action === "list") return yield* list(submit);
  const target = yield* resolveTarget(command.selector, submit);

  const change = {
    action: command.action,
    ...target,
    requestId: yield* (yield* SecureRandom.SecureRandom)
      .uuidV4()
      .pipe(Effect.mapError(() => failed("unavailable"))),
  };

  const raw = yield* submit(change).pipe(
    Effect.catchIf(
      (err) => err.reason === "unavailable",
      () => submit(change)
    )
  );

  const entry = yield* Schema.decodeUnknownEffect(ProGrantEntry)(raw).pipe(
    Effect.mapError(() => failed("unavailable"))
  );

  if (entry.action !== command.action || entry.userId !== target.userId) {
    return yield* failed("unavailable");
  }

  return [entry];
});

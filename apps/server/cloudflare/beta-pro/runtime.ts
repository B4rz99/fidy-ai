import { Clock, Effect, Option, Schema } from "effect";
import type { EmailAddress } from "../../src/core/email-authentication/contract";
import { UserId } from "../../src/core/identity/contract";
import { AccessSigningKeysHttp } from "../../src/shell/outbound-http/operations";
import {
  type ProGrantEntry,
  ProOperatorCommand,
  ProTarget,
} from "../../src/shell/pro-grants/contract";
import type { CoreHttpEnvironment } from "../core-http/contract";
import { directoryName, emailRouteUrl } from "../directory/contract";
import { maintenanceName } from "../maintenance/contract";
import { boundedJsonBody } from "../http/operations";
import { RequestBodyPolicy } from "../http/contract";
import { authenticateOperator } from "../operator-access/operations";
import {
  type BetaAuthority,
  BetaRegistryPage,
  BetaUserCommand,
  betaRegistryUrl,
  betaStatus,
  betaUserUrl,
} from "./contract";

const refused = (status: number): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1536,
  deadlineMilliseconds: 5000,
});

const userRequest = Effect.fn(function* (
  environment: CoreHttpEnvironment,
  input: typeof BetaUserCommand.Type
) {
  const store = environment.USER_STORE;

  if (store === undefined) return refused(betaStatus.unavailable);
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(BetaUserCommand))(input);

  return yield* Effect.tryPromise(() =>
    store.getByName(input.command.userId).fetch(betaUserUrl, { method: "POST", body })
  );
});

const page = Effect.fn(function* (
  environment: CoreHttpEnvironment,
  input: Extract<typeof ProOperatorCommand.Type, { action: "list" }>,
  authority: typeof BetaAuthority.Type
) {
  const registry = environment.MAINTENANCE;

  if (registry === undefined) return refused(betaStatus.unavailable);

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    input.cursor ?? null
  );

  const response = yield* Effect.tryPromise(() =>
    registry.getByName(maintenanceName).fetch(betaRegistryUrl, { method: "POST", body })
  );

  if (!response.ok) return refused(betaStatus.unavailable);

  const found = yield* Schema.decodeUnknownEffect(BetaRegistryPage)(
    yield* Effect.tryPromise(() => response.json())
  );

  const active = yield* Effect.forEach(
    found.users,
    Effect.fn(function* (userId) {
      const checked = yield* userRequest(environment, {
        command: { action: "inspect", userId },
        authority,
      });

      if (checked.status === betaStatus.notFound) return Option.none<typeof ProGrantEntry.Type>();

      if (!checked.ok) return yield* Effect.fail(Error("Incomplete grant list"));

      const record = yield* Schema.decodeUnknownEffect(Schema.Struct({ active: Schema.Boolean }))(
        yield* Effect.tryPromise(() => checked.json())
      );

      return record.active
        ? Option.some({ userId, action: "grant" as const })
        : Option.none<typeof ProGrantEntry.Type>();
    }),
    { concurrency: 4 }
  );

  return Response.json({ entries: active.flatMap(Option.toArray), next: found.next });
});

const resolve = Effect.fn(function* (
  environment: CoreHttpEnvironment,
  email: EmailAddress,
  authority: typeof BetaAuthority.Type
) {
  const directory = environment.DIRECTORY;

  if (directory === undefined) return refused(betaStatus.unavailable);

  const route = yield* Effect.tryPromise(() =>
    directory.getByName(directoryName).fetch(emailRouteUrl, { method: "POST", body: email })
  );

  if (route.status === betaStatus.notFound) return refused(betaStatus.notFound);

  if (!route.ok) return refused(betaStatus.unavailable);

  const target = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ user_id: UserId, revision: Schema.Int })
  )(yield* Effect.tryPromise(() => route.json()));

  const confirmed = yield* userRequest(environment, {
    authority,
    command: {
      action: "resolve",
      userId: target.user_id,
      mailbox: { email, revision: target.revision },
    },
  });

  if (!confirmed.ok) return confirmed;

  return Response.json(
    yield* Schema.decodeUnknownEffect(ProTarget)(yield* Effect.tryPromise(() => confirmed.json()))
  );
});

const verifyOperator = Effect.fn(function* (
  request: Request,
  environment: CoreHttpEnvironment,
  { issuer, email }: { issuer: string; email: string }
) {
  return yield* authenticateOperator({
    request,
    configuration: {
      issuer,
      audience: environment.BETA_PRO_AUDIENCE ?? "",
      requiredEmail: Option.some(email),
      otherAudiences: [
        environment.CLOUDFLARE_ACCESS_AUDIENCE,
        environment.SAMPLE_REVIEW_AUDIENCE ?? "",
        environment.ERASURE_SUPPORT_AUDIENCE ?? "",
        environment.BILLING_SUPPORT_AUDIENCE ?? "",
        environment.PRICING_PUBLISH_AUDIENCE ?? "",
      ],
    },
    http: (yield* AccessSigningKeysHttp.make).forIssuer(issuer),
  });
});

const invalidTransport = (request: Request): boolean =>
  request.method !== "POST" || request.headers.has("origin") || new URL(request.url).search !== "";

export const handleBetaPro = Effect.fn(
  function* (request: Request, environment: CoreHttpEnvironment) {
    if (invalidTransport(request)) return refused(betaStatus.forbidden);

    const issuer = environment.CLOUDFLARE_ACCESS_ISSUER,
      configuredEmail = Schema.decodeUnknownOption(Schema.String)(
        environment.BETA_PRO_OPERATOR_EMAIL
      );

    if (Option.isNone(configuredEmail)) return refused(betaStatus.unauthenticated);

    const email = configuredEmail.value;
    const operator = yield* verifyOperator(request, environment, { issuer, email });

    if (Option.isNone(operator)) return refused(betaStatus.unauthenticated);
    const body = yield* boundedJsonBody({ request, policy, schema: Schema.Unknown });

    const command = Option.flatMap(
      body,
      Schema.decodeUnknownOption(ProOperatorCommand, { onExcessProperty: "error" })
    );

    if (Option.isNone(command)) return refused(betaStatus.invalid);
    const now = yield* Clock.currentTimeMillis;

    const authority = {
      issuer,
      subject: operator.value.operatorRef,
      email,
      deadline: operator.value.expiresAtMs,
    };

    if (now >= authority.deadline) return refused(betaStatus.unauthenticated);

    if (command.value.action === "list") return yield* page(environment, command.value, authority);

    if (command.value.action === "resolve") {
      return yield* resolve(environment, command.value.email, authority);
    }

    return yield* userRequest(environment, { command: command.value, authority });
  },
  Effect.tapError(() =>
    Effect.logWarning({ component: "beta-pro", operation: "handleBetaPro", outcome: "unavailable" })
  ),
  Effect.orElseSucceed(() => refused(betaStatus.unavailable))
);

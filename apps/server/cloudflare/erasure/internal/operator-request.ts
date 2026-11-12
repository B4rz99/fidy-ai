import { initializeRegistry } from "./initialize";
import { releaseRestore, restoreNext } from "./restore";
import { Clock, Effect, Option, Schema } from "effect";
import type { OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import {
  ErasureOperatorAction,
  type ErasureOperatorConfiguration,
  type ErasureOperatorEnvironment,
  ErasureRegistryMigration,
  erasureRegistryName,
} from "../contract";
import { authenticateOperator } from "./operator";
import { ErasureUnavailable } from "../../erasure-store/contract";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16384,
  deadlineMilliseconds: 2000,
});
const admissionLifetimeMs = 5000;
const unavailableStatus = 503;
const invalidStatus = 400;
const unauthorizedStatus = 401;
const reply = (status: number): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });
export const operatorRequest = (
  input: Readonly<{
    request: Request;
    environment: ErasureOperatorEnvironment;
    storeIds: ReadonlyArray<string>;
    http: OutboundHttpService;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (!validRequest(input.request)) return reply(invalidStatus);
    const operator = yield* authenticateOperator({
      ...input,
      configuration: operatorConfiguration(input.environment),
    });
    if (Option.isNone(operator)) return reply(unauthorizedStatus);
    const raw = yield* boundedJsonBody({ request: input.request, policy, schema: Schema.Unknown });
    const action = Option.flatMap(
      raw,
      Schema.decodeUnknownOption(ErasureOperatorAction, { onExcessProperty: "error" })
    );
    if (Option.isNone(action)) return reply(invalidStatus);
    const current = yield* Clock.currentTimeMillis;
    if (operator.value.expiresAtMs <= current) return reply(unauthorizedStatus);
    return yield* dispatchOperator({
      ...input,
      command: action.value,
      operator: operator.value,
      current,
    });
  }).pipe(Effect.orElseSucceed(() => reply(unavailableStatus)));

const dispatchOperator = (
  input: Readonly<{
    request: Request;
    environment: ErasureOperatorEnvironment;
    storeIds: ReadonlyArray<string>;
    http: OutboundHttpService;
    command: typeof ErasureOperatorAction.Type;
    operator: Readonly<{ operatorRef: string; expiresAtMs: number }>;
    current: number;
  }>
): Effect.Effect<Response, ErasureUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { command, operator, current } = input;
    if (command.action === "MigrateRegistry") {
      return yield* forwardMigration({
        environment: input.environment,
        request: input.request,
        operator,
        current,
      });
    }
    if (command.action === "Initialize") return yield* initializeRegistry(input.environment);
    if (command.action === "Restore") {
      return yield* restoreNext({
        ...input,
        operator,
        signal: input.request.signal,
      });
    }
    if (command.action === "ReleaseRestore") {
      return yield* releaseRestore({
        ...input,
        operator,
        signal: input.request.signal,
      });
    }
    return yield* forwardCommand({
      ...input,
      command,
      operator,
      current,
    });
  });

const forwardMigration = (
  input: Readonly<{
    environment: ErasureOperatorEnvironment;
    request: Request;
    operator: Readonly<{ operatorRef: string; expiresAtMs: number }>;
    current: number;
  }>
): Effect.Effect<Response, Schema.SchemaError | ErasureUnavailable> =>
  Effect.gen(function* () {
    const namespace = input.environment.ERASURE_REGISTRY_COORDINATOR;
    const expectedRelease = input.environment.RELEASE_GIT_SHA;
    if (namespace === undefined || expectedRelease === undefined) return reply(unavailableStatus);
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureRegistryMigration))({
      expectedRelease,
      deadlineMs: Math.min(input.current + admissionLifetimeMs, input.operator.expiresAtMs),
      authority: { permission: "titular.erase", ...input.operator },
    });
    return yield* Effect.tryPromise({
      try: () =>
        namespace.getByName(erasureRegistryName, { locationHint: "enam" }).fetch(
          new Request("https://erasure-registry.invalid/migrate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: input.request.signal,
          })
        ),
      catch: () => new ErasureUnavailable(),
    });
  });

type UserCommand = Exclude<
  typeof ErasureOperatorAction.Type,
  { action: "Restore" | "ReleaseRestore" | "Initialize" | "MigrateRegistry" }
>;
const forwardCommand = (
  input: Readonly<{
    request: Request;
    environment: ErasureOperatorEnvironment;
    command: UserCommand;
    operator: Readonly<{ operatorRef: string; expiresAtMs: number }>;
    current: number;
  }>
): Effect.Effect<Response, ErasureUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { command, current } = input;
    const admission = {
      userId: command.userId,
      deadlineMs: Math.min(current + admissionLifetimeMs, input.operator.expiresAtMs),
      authority: { permission: "titular.erase", ...input.operator },
    };
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      commandBody(command, admission)
    );
    const path = commandPath(command);
    return yield* Effect.tryPromise({
      try: () =>
        input.environment.USER_TRANSACTION_COORDINATOR.getByName(admission.userId).fetch(
          new Request(`https://coordinator.internal/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: input.request.signal,
          })
        ),
      catch: () => new ErasureUnavailable(),
    });
  });

const commandPath = (
  command: Exclude<
    typeof ErasureOperatorAction.Type,
    { action: "Restore" | "ReleaseRestore" | "Initialize" | "MigrateRegistry" }
  >
): string => {
  switch (command.action) {
    case "Continue":
      return "erasure-continue";
    case "Receipt":
      return "erasure-receipt";
    case "CustodyEvidence":
      return "erasure-custody-evidence";
  }
};
const commandBody = (
  command: Exclude<
    typeof ErasureOperatorAction.Type,
    { action: "Restore" | "ReleaseRestore" | "Initialize" | "MigrateRegistry" }
  >,
  admission: Readonly<{
    userId: string;
    deadlineMs: number;
    authority: Readonly<{ permission: string; operatorRef: string; expiresAtMs: number }>;
  }>
): unknown => {
  if (command.action === "CustodyEvidence") {
    return { ...admission, reference: command.evidence.reference, evidence: command.evidence };
  }
  return { ...admission, reference: command.reference };
};

const operatorConfiguration = (
  environment: ErasureOperatorEnvironment
): ErasureOperatorConfiguration => ({
  issuer: environment.CLOUDFLARE_ACCESS_ISSUER,
  audience: environment.ERASURE_SUPPORT_AUDIENCE ?? "",
  recoveryAudience: environment.CLOUDFLARE_ACCESS_AUDIENCE,
  billingAudience: environment.BILLING_SUPPORT_AUDIENCE ?? "",
});

const validRequest = (request: Request): boolean =>
  request.method === "POST" && new URL(request.url).search === "" && !request.headers.has("origin");

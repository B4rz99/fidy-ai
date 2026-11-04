import { verifyCandidate } from "./candidate";
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
    http: OutboundHttpService;
    candidateTargetId: Option.Option<string>;
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
    return yield* executeCommand({
      ...input,
      command: action.value,
      operator: operator.value,
      current,
    });
  }).pipe(Effect.orElseSucceed(() => reply(unavailableStatus)));

type UserCommand = Exclude<
  typeof ErasureOperatorAction.Type,
  { action: "Restore" | "ReleaseRestore" | "Initialize" | "VerifyCandidate" }
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
    { action: "Restore" | "ReleaseRestore" | "Initialize" | "VerifyCandidate" }
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
    { action: "Restore" | "ReleaseRestore" | "Initialize" | "VerifyCandidate" }
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

const candidateCommand = (
  input: Readonly<{
    candidateTargetId: Option.Option<string>;
    environment: ErasureOperatorEnvironment;
    request: Request;
    command: typeof ErasureOperatorAction.Type;
    expiresAtMs: number;
  }>
): Effect.Effect<Option.Option<Response>, ErasureUnavailable> => {
  if (Option.isNone(input.candidateTargetId)) return Effect.succeedNone;
  const action = input.command.action;
  if (action === "Initialize" || action === "ReleaseRestore" || action === "CustodyEvidence") {
    return Effect.succeedSome(reply(invalidStatus));
  }
  if (action !== "VerifyCandidate") return Effect.succeedNone;
  return verifyCandidate({
    environment: input.environment,
    targetId: input.candidateTargetId.value,
    signal: input.request.signal,
    expiresAtMs: input.expiresAtMs,
  }).pipe(Effect.asSome);
};

const executeCommand = (
  input: Readonly<{
    request: Request;
    environment: ErasureOperatorEnvironment;
    candidateTargetId: Option.Option<string>;
    operator: Readonly<{ operatorRef: string; expiresAtMs: number }>;
    command: typeof ErasureOperatorAction.Type;
    current: number;
  }>
): Effect.Effect<Response, ErasureUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const command = input.command;
    const candidate = yield* candidateCommand({
      ...input,
      command,
      expiresAtMs: input.operator.expiresAtMs,
    });
    if (Option.isSome(candidate)) return candidate.value;
    if (command.action === "VerifyCandidate") return reply(invalidStatus);
    if (command.action === "Initialize") return yield* initializeRegistry(input.environment);
    if (command.action === "Restore") {
      return yield* restoreNext({
        ...input,
        operator: input.operator,
        signal: input.request.signal,
      });
    }
    if (command.action === "ReleaseRestore") {
      return yield* releaseRestore({
        ...input,
        operator: input.operator,
        signal: input.request.signal,
      });
    }
    return yield* forwardCommand({
      ...input,
      command,
      operator: input.operator,
      current: input.current,
    });
  });

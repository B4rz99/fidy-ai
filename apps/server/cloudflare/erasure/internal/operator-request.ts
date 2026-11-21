import { Clock, Effect, Option, Schema } from "effect";
import type { OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import {
  ErasureOperatorAction,
  type ErasureRegistryNamespace,
  erasureRegistryName,
} from "../contract";
import {
  type OperatorAccessConfiguration,
  authenticateOperator,
} from "../../operator-access/operations";
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
type NativeEnvironment = Readonly<{
  CLOUDFLARE_ACCESS_ISSUER: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
}> &
  Partial<
    Readonly<{
      ERASURE_SUPPORT_AUDIENCE: string;
      BILLING_SUPPORT_AUDIENCE: string;
      PRICING_PUBLISH_AUDIENCE: string;
      BETA_PRO_AUDIENCE: string;
      SAMPLE_REVIEW_AUDIENCE: string;
      ERASURE: ErasureRegistryNamespace;
    }>
  >;
type OperatorCall = { request: Request; environment: NativeEnvironment; http: OutboundHttpService };
type Admitted = {
  command: typeof ErasureOperatorAction.Type;
  operator: { operatorRef: string; expiresAtMs: number };
  current: number;
};
const admittedCommand = (
  input: OperatorCall,
  apply: (admission: Admitted) => Effect.Effect<Response, ErasureUnavailable | Schema.SchemaError>
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
    return yield* apply({ command: action.value, operator: operator.value, current });
  }).pipe(Effect.orElseSucceed(() => reply(unavailableStatus)));

export const nativeOperatorRequest = (input: OperatorCall): Effect.Effect<Response> =>
  admittedCommand(input, (admission) => {
    const erasure = input.environment.ERASURE;
    if (erasure === undefined) return Effect.succeed(reply(unavailableStatus));
    const command = admission.command;
    if ("userId" in command) {
      return forwardCommand({
        ...admission,
        command,
        request: input.request,
        target: () => erasure.getByName(erasureRegistryName),
      });
    }
    return Effect.succeed(reply(invalidStatus));
  });

type UserCommand = Exclude<
  typeof ErasureOperatorAction.Type,
  { action: "Restore" | "ReleaseRestore" | "Initialize" | "MigrateRegistry" }
>;
const forwardCommand = (
  input: Readonly<{
    request: Request;
    target: () => Pick<Fetcher, "fetch">;
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
        input.target().fetch(
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
    case "CustodyScope":
      return "erasure-custody-scope";
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
  if (command.action === "CustodyScope") {
    return {
      ...admission,
      reference: command.reference,
      custodian: command.custodian,
      after: command.after,
    };
  }
  return { ...admission, reference: command.reference };
};

const operatorConfiguration = (environment: NativeEnvironment): OperatorAccessConfiguration => ({
  issuer: environment.CLOUDFLARE_ACCESS_ISSUER,
  audience: environment.ERASURE_SUPPORT_AUDIENCE ?? "",
  requiredEmail: Option.some("obarboza@fidyapp.com"),
  otherAudiences: [
    environment.BETA_PRO_AUDIENCE ?? "",
    environment.CLOUDFLARE_ACCESS_AUDIENCE,
    environment.BILLING_SUPPORT_AUDIENCE ?? "",
    environment.PRICING_PUBLISH_AUDIENCE ?? "",
    environment.SAMPLE_REVIEW_AUDIENCE ?? "",
  ],
});

const validRequest = (request: Request): boolean =>
  request.method === "POST" && new URL(request.url).search === "" && !request.headers.has("origin");

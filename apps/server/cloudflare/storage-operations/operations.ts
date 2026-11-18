import { StorageCommand } from "../../src/shell/storage-operations/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { makeAccessSigningKeysOutboundHttp } from "../../src/shell/outbound-http/operations";
import type { CoreHttpEnvironment } from "../core-http/contract";
import { directoryName } from "../directory/contract";
import { erasureRegistryName } from "../erasure/contract";
import { RequestBodyPolicy } from "../http/contract";
import { boundedJsonBody } from "../http/operations";
import { maintenanceName } from "../maintenance/contract";
import { authenticateOperator } from "../operator-access/operations";
import { pricingName } from "../subscription/contract";
import { StorageAdmission, localStorageOperatorUrl, storagePermission } from "./contract";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 5000,
});
const denied = (status: number): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });
const storageActor = Effect.fnUntraced(function* (request: Request, env: CoreHttpEnvironment) {
  const issuer = env.CLOUDFLARE_ACCESS_ISSUER;
  const operatorEmail = env.STORAGE_OPERATOR_EMAIL ?? "";
  if (operatorEmail === "") return Option.none();
  return yield* authenticateOperator({
    request,
    configuration: {
      issuer,
      requiredEmail: Option.some(operatorEmail),
      audience: env.STORAGE_OPERATOR_AUDIENCE ?? "",
      otherAudiences: [
        env.CLOUDFLARE_ACCESS_AUDIENCE,
        env.SAMPLE_REVIEW_AUDIENCE ?? "",
        env.BILLING_SUPPORT_AUDIENCE ?? "",
        env.PRICING_PUBLISH_AUDIENCE ?? "",
        env.ERASURE_SUPPORT_AUDIENCE ?? "",
      ],
    },
    http: makeAccessSigningKeysOutboundHttp({ issuer, httpClient: yield* HttpClient.HttpClient }),
  });
});
const storageOwner = (
  command: StorageCommand,
  env: CoreHttpEnvironment
): Option.Option<Pick<Fetcher, "fetch">> => {
  const [binding, name] =
    command.owner === "user"
      ? ([env.USER_STORE, command.userId] as const)
      : (
          {
            pricing: [env.PRICING, pricingName],
            directory: [env.DIRECTORY, directoryName],
            maintenance: [env.MAINTENANCE, maintenanceName],
            erasure: [env.ERASURE, erasureRegistryName],
          } as const
        )[command.owner];
  return Option.map(Option.fromUndefinedOr(binding), (owner) => owner.getByName(name));
};
const validStorageRequest = (request: Request): boolean =>
  request.method === "POST" && !request.headers.has("origin") && new URL(request.url).search === "";
const statuses = { invalid: 400, unauthorized: 401, forbidden: 403, unavailable: 503 } as const;
const admissionLifetime = 5000;
export const storageOperatorRequest = Effect.fn(
  function* (request: Request, env: CoreHttpEnvironment) {
    if (!validStorageRequest(request)) return denied(statuses.forbidden);
    const actor = yield* storageActor(request, env);
    const issuer = env.CLOUDFLARE_ACCESS_ISSUER;
    if (Option.isNone(actor)) return denied(statuses.unauthorized);
    const raw = yield* boundedJsonBody({ request, policy, schema: Schema.Unknown });
    const decoded = Option.flatMap(
      raw,
      Schema.decodeUnknownOption(StorageCommand, { onExcessProperty: "error" })
    );
    if (Option.isNone(decoded)) return denied(statuses.invalid);
    const command = decoded.value;
    const permission = storagePermission(command);
    if (permission === "storage.repair" && env.STORAGE_REPAIR_ENABLED !== "enabled") {
      return denied(statuses.forbidden);
    }
    const now = yield* Clock.currentTimeMillis;
    if (actor.value.expiresAtMs <= now) return denied(statuses.unauthorized);
    const owner = storageOwner(command, env);
    if (Option.isNone(owner)) return denied(statuses.unavailable);
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(StorageAdmission))({
      issuer,
      operator: actor.value.operatorRef,
      permission,
      command,
      deadline: Math.min(now + admissionLifetime, actor.value.expiresAtMs),
    });
    return yield* Effect.tryPromise((signal) =>
      owner.value.fetch(localStorageOperatorUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.any([signal, request.signal]),
      })
    ).pipe(Effect.timeout("5 seconds"));
  },
  Effect.orElseSucceed(() => denied(statuses.unavailable))
);

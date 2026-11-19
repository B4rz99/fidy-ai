import {
  PendingBrowserLoginPairing,
  browserLoginPairingInvalidBody,
} from "../../apps/server/src/shell/browser-login/contract";
import { browserLoginPairingLifetime } from "../../apps/server/src/core/browser-login/contract";
import { isDeepStrictEqual } from "node:util";
import type { ErasureContinuation, ErasureProgress } from "./native-erasure-continuation";
import { type ErasureObservation, verifyIndependentErasure } from "./native-erasure";
import { ErasureReceipt } from "../../apps/server/src/core/erasure/contract";
import { UserId } from "../../apps/server/src/core/identity/contract";
import {
  WompiBillingEvent,
  pricePublicationPath,
  refundSupportBasePath,
} from "../../apps/server/cloudflare/subscription/contract";
import { Clock, DateTime, Duration, Effect, Option, Redacted, Schedule, Schema } from "effect";
import { installedOrigins } from "@fidy/server/browser-transport";
import { ProcessingAuthorization } from "../../apps/server/src/shell/processing-consent/contract";
import { webSignupDisclosure } from "../../apps/server/src/shell/consent/operations";
import { signAcceptanceRequest } from "../../apps/server/cloudflare/release-isolation/operations";
import {
  acceptanceLifetimeMs,
  acceptanceProofHeader,
} from "../../apps/server/cloudflare/release-isolation/contract";
import { acceptancePaymentToken } from "../../apps/server/cloudflare/release-fixture/contract";
import { issueAcceptanceProviderCode } from "../../apps/server/cloudflare/release-fixture/operations";

type Inputs = {
  revision: string;
  proof: Redacted.Redacted<string>;
  origins: (typeof installedOrigins)[keyof typeof installedOrigins];
  erasure: Option.Option<ErasureObservation>;
  send: (request: Request) => Effect.Effect<Response, Error>;
};
const ok = 200,
  seeOther = 303,
  accepted = 202,
  unauthorized = 401,
  invalid = 400,
  absent = 404,
  isolated = 503,
  millisecondsPerSecond = 1000;
const validStatus = Effect.fn(function* (reply: Response, expected: number) {
  if (reply.status !== expected) {
    return yield* Effect.fail(
      Error(`Closed acceptance expected HTTP ${expected}; received ${reply.status}`)
    );
  }
  return reply;
});
const consume = Effect.fn(function* (reply: Response, expected: number) {
  yield* validStatus(reply, expected);
  yield* Effect.tryPromise(() => reply.arrayBuffer());
});
const json = Schema.fromJsonString(Schema.Unknown);
const result = Effect.fn(function* <Value, Encoded>(
  reply: Response,
  schema: Schema.Codec<Value, Encoded>
) {
  yield* validStatus(reply, ok);
  return yield* Schema.decodeUnknownEffect(schema)(yield* Effect.tryPromise(() => reply.json()));
});
const phase = Schema.Struct({ status: Schema.String });
type Driver = Readonly<{
  call: (path: string, init: RequestInit, scoped?: boolean) => Effect.Effect<Response, Error>;
  post: (
    path: string,
    body: unknown,
    headers?: Readonly<Record<string, string>>
  ) => Effect.Effect<Response, Error>;
}>;
const runner = ({ origins, send, proof, revision }: Inputs): Driver => {
  const environment = {
    BROWSER_ORIGIN: origins.browser,
    NATIVE_STORAGE_ADMISSION: "closed",
    RECOVERY_ISOLATION: "isolated",
    RELEASE_GIT_SHA: revision,
    SMOKE_PROOF: Redacted.value(proof),
  };
  const call = Effect.fn(function* (path: string, init: RequestInit, scoped: boolean = true) {
    const headers = new Headers(init.headers);
    if (!path.startsWith("/internal/")) headers.set("origin", origins.browser);
    const req = new Request(origins.api + path, { ...init, headers, redirect: "manual" });
    if (scoped) {
      const signature = yield* signAcceptanceRequest({
        environment,
        request: req,
        boundary: "ingress",
        deadline: (yield* Clock.currentTimeMillis) + acceptanceLifetimeMs,
      });
      req.headers.set(acceptanceProofHeader, signature);
    }
    return yield* send(req);
  });
  const post = Effect.fn(function* (
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>> = {}
  ) {
    return yield* call(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: yield* Schema.encodeEffect(json)(body),
    });
  });
  return { call, post };
};
const cookie = Effect.fn(function* (reply: Response, name: string) {
  const [first, ...attributes] = (reply.headers.get("set-cookie") ?? "")
    .split(";")
    .map((item) => item.trim());
  const required = ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"];
  if (
    first === undefined ||
    !first.startsWith(name + "=") ||
    first.length <= name.length + 1 ||
    !required.every((item) => attributes.includes(item)) ||
    attributes.some((item) => item.toLowerCase().startsWith("domain="))
  ) {
    return yield* Effect.fail(Error("Missing host-only browser credential in protected signup"));
  }
  return first;
});
const verifyOriginalDisclosure = Effect.fn(function* (
  call: Driver["call"],
  headers: Readonly<Record<string, string>>
) {
  const legal = yield* result(
    yield* call("/web/consent/authorization", { headers }),
    ProcessingAuthorization
  );
  if (legal.authorization?.disclosure.contentSha256 !== webSignupDisclosure().contentSha256) {
    return yield* Effect.fail(Error("Missing original provider signup disclosure"));
  }
});
type Member = "smoke-1" | "smoke-2" | "erasure-1";
const verifyProvider = Effect.fn(function* (
  input: Inputs,
  member: Member,
  intent: "login" | "signup"
) {
  const { post, call } = runner(input),
    { expiresAt, ...proof } = yield* result(
      yield* post("/web/pairings", {}),
      Schema.Struct({
        pairingId: Schema.String,
        privateVerifier: Schema.String,
        expiresAt: Schema.DateTimeUtcFromString,
      })
    );
  const start = yield* post("/web/providers/google/start", {
    ...proof,
    intent,
    consentRevision: webSignupDisclosure().revision,
  });
  const transient = yield* cookie(start, "__Host-fidy_google"),
    auth = new URL(
      (yield* result(start, Schema.Struct({ authorizationUrl: Schema.String }))).authorizationUrl
    );
  const subject = `fidy-acceptance-${input.revision}-${member}`;
  const key = new Bun.CryptoHasher("sha256", Redacted.value(input.proof))
    .update(input.revision + "/oidc-code")
    .digest("hex");
  if (auth.searchParams.get("redirect_uri") !== input.origins.api + "/providers/google/callback") {
    return yield* Effect.fail(Error("Protected signup selected another callback origin"));
  }
  const code = yield* issueAcceptanceProviderCode(
    {
      provider: "google",
      host: input.origins.api === installedOrigins.production.api ? "production" : "acceptance",
      subject,
      nonce: auth.searchParams.get("nonce") ?? "",
      challenge: auth.searchParams.get("code_challenge") ?? "",
      deadline: (yield* Clock.currentTimeMillis) + acceptanceLifetimeMs,
    },
    key
  );
  const location = new URLSearchParams({ state: auth.searchParams.get("state") ?? "", code });
  const callback = yield* call("/providers/google/callback?" + location, {
    headers: { cookie: transient },
  });
  yield* consume(callback, seeOther);
  const confirmed = yield* result(yield* post("/web/providers/google/status", proof), phase);
  if (confirmed.status !== "verified") {
    return yield* Effect.fail(Error("Provider did not verify the synthetic pairing"));
  }
  return {
    subject,
    proof,
    expiresAt,
    completion: yield* post("/web/providers/google/complete", proof),
  };
});
const boot = Effect.fn(function* (
  input: Inputs,
  member: Member,
  intent: "login" | "signup" = "signup"
) {
  const { subject, proof, completion } = yield* verifyProvider(input, member, intent);
  const { call, post } = runner(input);
  const complete = yield* result(completion, phase);
  if (!(intent === "signup" && complete.status === "created") && complete.status !== "approved") {
    return yield* Effect.fail(Error("Original User did not complete synthetic signup"));
  }
  const session = yield* validStatus(yield* post("/web/pairings/redeem", proof), ok);
  const mounted = yield* cookie(session, "__Host-fidy_session");
  yield* Effect.tryPromise(() => session.arrayBuffer());
  const { binding } = yield* result(
    yield* call("/web/session/binding", { headers: { cookie: mounted } }),
    Schema.Struct({ binding: Schema.NonEmptyString })
  );
  const headers = { cookie: mounted, "fidy-session-binding": binding };
  yield* verifyOriginalDisclosure(call, headers);
  yield* consume(yield* call("/transactions", { headers }), ok);
  yield* consume(yield* call("/transactions", { headers }, false), isolated);
  return { headers, subject, outcome: complete.status };
});
const receipt = Effect.fn(function* (input: Inputs) {
  const { call } = runner(input);
  const response = yield* call(
    "/internal/release-smoke?acceptance=charge-receipt&cohort=smoke&ordinal=1",
    { headers: { "x-fidy-smoke-proof": Redacted.value(input.proof) } },
    false
  );
  if (response.status === absent) {
    yield* consume(response, absent);
    return Option.none();
  }
  return Option.some(
    yield* result(
      response,
      Schema.Struct({
        id: Schema.NonEmptyString,
        reference: Schema.String,
        finalizedAt: Schema.DateTimeUtcFromString,
      })
    )
  );
});
const paymentStatus = Effect.fn(function* (
  input: Inputs,
  id: string,
  headers: Readonly<Record<string, string>>
) {
  return yield* runner(input).call("/web/subscription/billing-attempts/" + id, { headers });
});
type User = Effect.Success<ReturnType<typeof boot>>;
const submitCard = Effect.fn(function* (input: Inputs, user: User) {
  const { post } = runner(input);
  const prefix = "/web/subscription/payment-enrollments/",
    initialPrice = "22700000-0000-4000-8000-000000000002";
  const form = yield* result(
    yield* post(prefix + "prepare", { method: "card", priceId: initialPrice }, user.headers),
    Schema.Struct({ enrollmentId: Schema.String })
  );
  const submitted = yield* result(
    yield* post(
      prefix + "submit",
      {
        method: "card",
        paymentSourceMode: "create",
        billingEmail: user.subject + "@example.test",
        cardToken: acceptancePaymentToken({ kind: "CARD", subject: user.subject }),
        enrollmentId: form.enrollmentId,
        paymentRequestId: "22570000-0000-4000-8000-000000000001",
        decisions: {
          acceptedEndUserPolicy: true,
          acceptedPersonalDataAuthorization: true,
          authorizedRecurringCharges: true,
        },
      },
      user.headers
    ),
    Schema.Struct({
      status: Schema.String,
      billingAttempt: Schema.Struct({
        id: Schema.NonEmptyString,
        status: Schema.Literal("pending"),
      }),
    })
  );
  if (submitted.status !== "payment-pending") {
    return yield* Effect.fail(Error("Synthetic enrollment did not reach pending collection"));
  }
  return submitted.billingAttempt.id;
});
const deliverCallback = Effect.fn(function* (
  input: Inputs,
  saved: { id: string; finalizedAt: DateTime.Utc }
) {
  const { post } = runner(input);
  const stamp = Math.floor(DateTime.toEpochMillis(saved.finalizedAt) / millisecondsPerSecond),
    secret =
      "test_events_" +
      new Bun.CryptoHasher("sha256", Redacted.value(input.proof))
        .update(input.revision + "/wompi-events")
        .digest("hex");
  const checksum = new Bun.CryptoHasher("sha256")
    .update(saved.id + "APPROVED" + stamp + secret)
    .digest("hex");
  const event = {
    event: "transaction.updated",
    timestamp: stamp,
    environment: "test",
    signature: { properties: ["transaction.id", "transaction.status"], checksum },
    data: { transaction: { id: saved.id, status: "APPROVED" } },
  };
  const deliver = Effect.fn(function* () {
    const response = yield* post("/providers/wompi/billing-events", event, {
      "x-event-checksum": checksum,
    });
    yield* consume(response, ok);
  });
  yield* deliver();
  yield* deliver();
  const canonical = yield* Schema.encodeEffect(Schema.fromJsonString(WompiBillingEvent))({
    _tag: "WompiBillingEvent",
    environment: "sandbox",
    transactionId: saved.id,
    signedAt: stamp,
    signedStatus: "APPROVED",
  });
  return "wompi-event-" + new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
});
const charge = Effect.fn(function* (input: Inputs, user: User, other: User) {
  const prior = yield* receipt(input);
  const expectedId = Option.isNone(prior)
    ? Option.some(yield* submitCard(input, user))
    : Option.none();
  const saved = Option.isSome(prior)
    ? prior.value
    : yield* receipt(input).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(Error("Synthetic provider has no charge receipt")),
            onSome: Effect.succeed,
          })
        ),
        Effect.retry({ times: 30, schedule: Schedule.spaced("500 millis") })
      );
  const id = saved.reference.slice("fidy-".length);
  if (Option.isSome(expectedId) && id !== expectedId.value) {
    return yield* Effect.fail(
      Error("Synthetic charge does not match the submitted BillingAttempt")
    );
  }
  const state = Effect.fn(function* () {
    return (yield* result(yield* paymentStatus(input, id, user.headers), phase)).status;
  });
  const before = yield* state();
  if (before !== "pending" && !(Option.isSome(prior) && before === "succeeded")) {
    return yield* Effect.fail(Error("Original User charge did not have the expected prior state"));
  }
  yield* consume(yield* paymentStatus(input, id, other.headers), invalid);
  const workflow = yield* deliverCallback(input, saved);
  yield* state().pipe(
    Effect.filterOrFail(
      (value) => value === "succeeded",
      () => Error("Original User charge has not settled")
    ),
    Effect.retry({ times: 30, schedule: Schedule.spaced("500 millis") })
  );
  return { workflow, before, owner: "succeeded" as const, other: invalid, deliveries: 2 };
});
const renewWork = Effect.fn(function* (input: Inputs) {
  const { call } = runner(input);
  const lease = yield* call(
    "/internal/release-smoke?acceptance=work",
    { method: "POST", headers: { "x-fidy-smoke-proof": Redacted.value(input.proof) } },
    false
  );
  if (lease.status !== ok) {
    yield* Effect.logError("Protected background work lease returned HTTP " + lease.status);
  }
  yield* result(
    lease,
    Schema.Struct({ revision: Schema.Literal(input.revision), deadline: Schema.Int })
  );
});
const erasureEvidence = Effect.fn(function* (
  input: Inputs,
  pair: readonly [User, User],
  observation: ErasureObservation
) {
  const { call, post } = runner(input);
  const identity = Effect.fn(function* (user: User) {
    const current = yield* result(
      yield* call("/user", { headers: user.headers }),
      Schema.Struct({ data: Schema.Struct({ id: UserId }) })
    );
    return current.data.id;
  });
  return yield* verifyIndependentErasure({
    ...observation,
    survivors: () => Effect.forEach(pair, identity),
    signup: () =>
      boot(input, "erasure-1").pipe(
        Effect.flatMap((user) => identity(user).pipe(Effect.map((id) => ({ ...user, id }))))
      ),
    renew: () => renewWork(input),
    admit: Effect.fn(function* (user) {
      const reply = yield* validStatus(
        yield* post("/web/privacy/erasure", { confirm: true }, user.headers),
        accepted
      );
      const admitted = yield* Schema.decodeUnknownEffect(ErasureReceipt)(
        yield* Effect.tryPromise(() => reply.json())
      );
      if (admitted.state !== "Draining" || admitted.next !== "admitted-work") {
        return yield* Effect.fail(Error("Missing fresh User erasure admission"));
      }
      return admitted.reference;
    }),
    denied: Effect.fn(function* (user) {
      yield* consume(yield* call("/transactions", { headers: user.headers }), unauthorized);
    }),
  });
});
const ungrantedPairing = Effect.fn(function* (input: Inputs, record: ErasureProgress) {
  const privateLogin = {
    ...input,
    send: Effect.fn(function* (request: Request) {
      const reply = yield* input.send(request);
      if (reply.headers.getSetCookie().some((value) => /(?:^|,\s*)__Host-fidy_session=/u.test(value))) {
        return yield* Effect.fail(Error("Erased subject received a browser session"));
      }
      return reply;
    }),
  };
  const { proof, expiresAt, completion } = yield* verifyProvider(
    privateLogin,
    "erasure-1",
    "login"
  );
  yield* record("erased-provider-verified");
  if (completion.status !== invalid && completion.status !== isolated) {
    return yield* Effect.fail(Error("Unexpected erased provider completion"));
  }
  const outcome = completion.status === invalid ? "invalid" : "unavailable";
  yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.Literal(outcome) }))(
    yield* Effect.tryPromise(() => completion.json())
  );
  yield* record(outcome === "invalid" ? "completion-invalid" : "completion-unavailable");
  const { post } = runner(privateLogin);
  const redeem = (): ReturnType<typeof post> => post("/web/pairings/redeem", proof);
  const pending = yield* validStatus(yield* redeem(), accepted);
  const observed = yield* Schema.decodeUnknownEffect(PendingBrowserLoginPairing)(
    yield* Effect.tryPromise(() => pending.json())
  );
  const remaining = DateTime.toEpochMillis(expiresAt) - (yield* Clock.currentTimeMillis);
  const skewMs = 2000;
  if (
    DateTime.toEpochMillis(observed.expiresAt) !== DateTime.toEpochMillis(expiresAt) ||
    remaining <= 0 ||
    remaining > Duration.toMillis(browserLoginPairingLifetime) + skewMs
  ) {
    return yield* Effect.fail(Error("Erased subject pairing expiry differs"));
  }
  yield* record("pairing-pending");
  yield* Effect.sleep(remaining + skewMs);
  const terminal = yield* validStatus(yield* redeem(), invalid);
  if (
    !isDeepStrictEqual(
      yield* Effect.tryPromise(() => terminal.json()),
      browserLoginPairingInvalidBody
    )
  ) {
    return yield* Effect.fail(Error("Missing terminal pairing refusal"));
  }
  yield* record("pairing-expired");
  return outcome;
});
/** The continuation authenticates the installed revision's existing subjects with login intent only. */
export const admittedErasureLogins = (
  input: Omit<Inputs, "erasure">
): Pick<ErasureContinuation, "renew" | "logins" | "refused"> => {
  const transport = { ...input, erasure: Option.none<ErasureObservation>() };
  const { call } = runner(transport);
  return {
    renew: () => renewWork(transport),
    logins: () =>
      Effect.forEach(
        ["smoke-1", "smoke-2"] as const,
        Effect.fn(function* (member) {
          const user = yield* boot(transport, member, "login");
          const current = yield* result(
            yield* call("/user", { headers: user.headers }),
            Schema.Struct({ data: Schema.Struct({ id: UserId }) })
          );
          return current.data.id;
        })
      ),
    refused: (record) => ungrantedPairing(transport, record),
  };
};
/** Exercise actual auth, private provider exchange and native financial callback through the installed protected release.
 * Callers verify the deterministic callback Workflow and the User-facing final projections before accepting its receipt.
 */
export const exerciseClosedUsers = Effect.fn(function* (input: Inputs) {
  const { call } = runner(input);
  const ordinary = yield* call(
    "/web/pairings",
    { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    false
  );
  yield* consume(ordinary, isolated);
  yield* renewWork(input);
  const deniedStatuses = [];
  for (const operation of [pricePublicationPath, refundSupportBasePath]) {
    const reply = yield* call(operation, {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": "unassigned-synthetic-identity",
        "content-type": "application/json",
      },
      body: "{}",
    });
    yield* consume(reply, unauthorized);
    deniedStatuses.push(reply.status);
  }
  const first = yield* boot(input, "smoke-1"),
    second = yield* boot(input, "smoke-2");
  const callback = yield* charge(input, first, second);
  return {
    signup: [first.outcome, second.outcome],
    callback,
    ...(Option.isNone(input.erasure)
      ? {}
      : { erasure: yield* erasureEvidence(input, [first, second], input.erasure.value) }),
    unassignedCommercialAuthorities: deniedStatuses,
  };
});

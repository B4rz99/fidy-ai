import {
  WompiBillingEvent,
  pricePublicationPath,
  refundSupportBasePath,
} from "../../apps/server/cloudflare/subscription/contract";
import { Clock, DateTime, Effect, Option, Redacted, Schedule, Schema } from "effect";
import { installedOrigins } from "@fidy/server/browser-transport";
import { ProcessingAuthorization } from "../../apps/server/src/shell/processing-consent/contract";
import { webSignupDisclosure } from "../../apps/server/src/shell/consent/operations";
import { signAcceptanceRequest } from "../../apps/server/cloudflare/release-isolation/operations";
import {
  acceptanceLifetimeMs,
  acceptanceProofHeader,
} from "../../apps/server/cloudflare/release-isolation/contract";
import {
  acceptancePaymentToken,
  issueAcceptanceProviderCode,
} from "../../apps/server/cloudflare/release-fixture/operations";

type Inputs = {
  revision: string;
  proof: Redacted.Redacted<string>;
  origins: (typeof installedOrigins)[keyof typeof installedOrigins];
  send: (request: Request) => Effect.Effect<Response, Error>;
};
const ok = 200,
  seeOther = 303,
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
const boot = Effect.fn(function* (input: Inputs, ordinal: number) {
  const { post, call } = runner(input),
    proof = yield* result(
      yield* post("/web/pairings", {}),
      Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
    );
  const start = yield* post("/web/providers/google/start", {
    ...proof,
    intent: "signup",
    consentRevision: webSignupDisclosure().revision,
  });
  const transient = yield* cookie(start, "__Host-fidy_google"),
    auth = new URL(
      (yield* result(start, Schema.Struct({ authorizationUrl: Schema.String }))).authorizationUrl
    );
  const subject = `fidy-acceptance-${input.revision}-smoke-${ordinal}`;
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
  const complete = yield* result(yield* post("/web/providers/google/complete", proof), phase);
  if (!["created", "approved"].includes(complete.status)) {
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
        cardToken: acceptancePaymentToken("CARD", user.subject),
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
  const lease = yield* call(
    "/internal/release-smoke?acceptance=work",
    { method: "POST", headers: { "x-fidy-smoke-proof": Redacted.value(input.proof) } },
    false
  );
  yield* result(
    lease,
    Schema.Struct({ revision: Schema.Literal(input.revision), deadline: Schema.Int })
  );
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
    const unauthorized = 401;
    yield* consume(reply, unauthorized);
    deniedStatuses.push(reply.status);
  }
  const first = yield* boot(input, 1),
    second = yield* boot(input, 2);
  const callback = yield* charge(input, first, second);
  return {
    signup: [first.outcome, second.outcome],
    callback,
    unassignedCommercialAuthorities: deniedStatuses,
  };
});

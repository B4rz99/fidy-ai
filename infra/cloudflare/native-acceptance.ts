import type { PerformanceMember } from "../../apps/server/cloudflare/release-isolation/contract";
import type { FleetOrdinal } from "./native-ten-fleet";
import type { FleetPilotBrowser } from "./native-fleet-pilot";
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
import {
  Clock,
  Config,
  DateTime,
  Duration,
  Effect,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
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

const configuredProviderRevision = (revision: string): Config.Config<string> =>
  Config.String("FIDY_NATIVE_FIXTURE_PROVIDER_REVISION").pipe(Config.withDefault(revision));

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

type Member =
  | "smoke-1"
  | "smoke-2"
  | "erasure-1"
  | "performance-1"
  | "performance-2"
  | `fleet-${FleetOrdinal}`;

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

  const generation = yield* configuredProviderRevision(input.revision);
  const subject = `fidy-acceptance-${generation}-${member}`;

  const key = new Bun.CryptoHasher("sha256", Redacted.value(input.proof))
    .update(generation + "/oidc-code")
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
  };
});

const boot = Effect.fn(function* (
  input: Inputs,
  member: Member,
  intent: "login" | "signup" = "signup"
) {
  const { subject, proof } = yield* verifyProvider(input, member, intent);
  const { call, post } = runner(input);
  const complete = yield* result(yield* post("/web/providers/google/complete", proof), phase);

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

export const openPerformanceBrowser = Effect.fn(function* (
  input: Pick<Inputs, "revision" | "proof" | "send">,
  member: "performance-1" | "performance-2"
) {
  const user = yield* boot(
    { ...input, origins: installedOrigins.acceptance, erasure: Option.none() },
    member
  );

  return Redacted.make(user.headers.cookie.slice("__Host-fidy_session=".length));
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
        .update((yield* configuredProviderRevision(input.revision)) + "/wompi-events")
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

  const canonical = yield* Schema.encodeEffect(Schema.fromJsonString(WompiBillingEvent))(
    WompiBillingEvent.make({
      environment: "sandbox",
      transactionId: saved.id,
      signedAt: stamp,
      signedStatus: "APPROVED",
    })
  );

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

const admitBrowserErasure = Effect.fn(function* (
  input: Inputs,
  user: { headers: Readonly<Record<string, string>> }
) {
  const { post } = runner(input);

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
});

const identity = Effect.fn(function* (call: Driver["call"], user: User) {
  const current = yield* result(
    yield* call("/user", { headers: user.headers }),
    Schema.Struct({ data: Schema.Struct({ id: UserId }) })
  );

  return current.data.id;
});

type FleetSubject = `fleet-${FleetOrdinal}`;

export const fleetBrowser = (
  input: Inputs & { subject: FleetSubject }
): FleetPilotBrowser & {
  read: () => Effect.Effect<void, Error>;
  refused: (record: ErasureProgress) => Effect.Effect<void, Error>;
  beginRefusal: (record: ErasureProgress) => Effect.Effect<Effect.Effect<void, Error>, Error>;
} => {
  let browser: Option.Option<User> = Option.none();

  const session = Effect.fn(function* (intent: "signup" | "login") {
    const member = yield* boot(input, input.subject, intent);
    browser = Option.some(member);

    return {
      id: yield* identity(runner(input).call, member),
      outcome: member.outcome,
      erase: (): Effect.Effect<string, Error> => admitBrowserErasure(input, member),
      denied: (): Effect.Effect<void, Error> =>
        runner(input)
          .call("/transactions", { headers: member.headers })
          .pipe(Effect.flatMap((reply) => consume(reply, unauthorized))),
    };
  });

  const beginRefusal = (
    record: ErasureProgress
  ): Effect.Effect<Effect.Effect<void, Error>, Error> =>
    refusedPairing(input, input.subject, record).pipe(
      Effect.map((pending) => pending.finish.pipe(Effect.asVoid))
    );

  return {
    renew: () => renewWork(input),
    register: () => session("signup"),
    login: () => session("login"),
    read: Effect.fn(function* () {
      const user = yield* Effect.fromOption(browser, () => Error("No signed fleet session"));
      yield* consume(yield* runner(input).call("/transactions", { headers: user.headers }), ok);
    }),
    beginRefusal,
    refused: (record) => beginRefusal(record).pipe(Effect.flatten),
  };
};

const erasureEvidence = Effect.fn(function* (
  input: Inputs,
  pair: readonly [User, User],
  observation: ErasureObservation
) {
  const { call } = runner(input);

  return yield* verifyIndependentErasure({
    ...observation,
    survivors: () => Effect.forEach(pair, (user) => identity(call, user)),
    signup: () =>
      boot(input, "erasure-1").pipe(
        Effect.flatMap((user) => identity(call, user).pipe(Effect.map((id) => ({ ...user, id }))))
      ),
    renew: () => renewWork(input),
    admit: (user) => admitBrowserErasure(input, user),
    denied: Effect.fn(function* (user) {
      yield* consume(yield* call("/transactions", { headers: user.headers }), unauthorized);
    }),
  });
});

const completionOutcome = Effect.fn(function* (completion: Response) {
  if (completion.status !== invalid && completion.status !== isolated) {
    return yield* Effect.fail(Error("Unexpected erased provider completion"));
  }

  const outcome = completion.status === invalid ? "invalid" : "unavailable";
  yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.Literal(outcome) }))(
    yield* Effect.tryPromise(() => completion.json())
  );

  return outcome;
});

const refusedPairing = Effect.fn(function* (
  input: Inputs,
  member: "erasure-1" | PerformanceMember | FleetSubject,
  record: ErasureProgress
) {
  const privateLogin = {
    ...input,
    send: Effect.fn(function* (request: Request) {
      const reply = yield* input.send(request);

      if (
        reply.headers.getSetCookie().some((value) => /(?:^|,\s*)__Host-fidy_session=/u.test(value))
      ) {
        return yield* Effect.fail(Error("Erased subject received a browser session"));
      }

      return reply;
    }),
  };

  const { proof, expiresAt } = yield* verifyProvider(privateLogin, member, "login");
  yield* record("erased-provider-verified");
  const { post } = runner(privateLogin);
  const outcome = yield* completionOutcome(yield* post("/web/providers/google/complete", proof));
  yield* record(outcome === "invalid" ? "completion-invalid" : "completion-unavailable");
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

  return {
    finish: Effect.gen(function* () {
      const delay = DateTime.toEpochMillis(expiresAt) + skewMs - (yield* Clock.currentTimeMillis);
      yield* Effect.sleep(Math.max(0, delay));
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
    }),
  };
});

type CohortBrowser = {
  open: (
    intent: "signup" | "login"
  ) => Effect.Effect<
    { id: string; outcome: string; headers: Readonly<Record<string, string>> },
    Error
  >;
  survivors: () => Effect.Effect<ReadonlyArray<string>, Error>;
  beforeSignup: () => Effect.Effect<void, Error>;
  erase: (headers: Readonly<Record<string, string>>) => Effect.Effect<string, Error>;
  denied: (headers: Readonly<Record<string, string>>) => Effect.Effect<void, Error>;
  refused: () => Effect.Effect<string, Error>;
  renew: () => Effect.Effect<void, Error>;
  call: Driver["call"];
};

export const performanceCohortBrowser = ({
  member,
  ...input
}: Omit<Inputs, "erasure" | "origins"> &
  Readonly<{ member: PerformanceMember }>): CohortBrowser => {
  const closed = {
    ...input,
    origins: installedOrigins.acceptance,
    erasure: Option.none<ErasureObservation>(),
  };

  const { call, post } = runner(closed);

  const open = Effect.fn(function* (intent: "signup" | "login") {
    const user = yield* boot(closed, member, intent);

    return { id: yield* identity(call, user), outcome: user.outcome, headers: user.headers };
  });

  return {
    open,
    survivors: admittedErasureLogins({ ...input, origins: installedOrigins.acceptance }).logins,
    beforeSignup: Effect.fn(function* () {
      const { proof } = yield* verifyProvider(closed, member, "login");

      const response = yield* validStatus(
        yield* post("/web/providers/google/complete", proof),
        invalid
      );

      yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.Literal("invalid") }))(
        yield* Effect.tryPromise(() => response.json())
      );
    }),
    erase: (headers: Readonly<Record<string, string>>) => admitBrowserErasure(closed, { headers }),
    denied: (headers: Readonly<Record<string, string>>) =>
      call("/transactions", { headers }).pipe(
        Effect.flatMap((reply) => consume(reply, unauthorized))
      ),
    refused: () =>
      refusedPairing(closed, member, () => Effect.void).pipe(
        Effect.flatMap((pending) => pending.finish)
      ),
    renew: () => renewWork(closed),
    call,
  };
};

export const retainedFinancialControls = Effect.fn(function* (input: Omit<Inputs, "erasure">) {
  const transport = { ...input, erasure: Option.none<ErasureObservation>() };
  const { call } = runner(transport);

  return yield* Effect.forEach(
    ["smoke-1", "smoke-2"] as const,
    Effect.fn(function* (member) {
      const user = yield* boot(transport, member, "login");
      const id = yield* identity(call, user);

      const reply = yield* validStatus(
        yield* call("/transactions?limit=25", { headers: user.headers }),
        ok
      );

      const body = yield* Effect.tryPromise(() => reply.text());
      yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({ data: Schema.Array(Schema.Unknown), next: Schema.Tuple([]) })
        )
      )(body);

      return { id, historyDigest: new Bun.CryptoHasher("sha256").update(body).digest("hex") };
    })
  );
});

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

          return yield* identity(call, user);
        })
      ),
    refused: (record) =>
      refusedPairing(transport, "erasure-1", record).pipe(
        Effect.flatMap((pending) => pending.finish)
      ),
  };
};

export const establishSmokeUsers = Effect.fn(function* (input: Inputs) {
  return [yield* boot(input, "smoke-1"), yield* boot(input, "smoke-2")] as const;
});

export const exerciseClosedUsers = Effect.fn(function* (input: Inputs) {
  const { call } = runner(input);

  const ordinary = yield* call(
    "/web/pairings",
    { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    false
  );

  yield* consume(ordinary, isolated);
  yield* renewWork(input);

  const deniedStatuses = yield* Effect.forEach(
    [pricePublicationPath, refundSupportBasePath],
    Effect.fnUntraced(function* (operation) {
      const reply = yield* call(operation, {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": "unassigned-synthetic-identity",
          "content-type": "application/json",
        },
        body: "{}",
      });

      yield* consume(reply, unauthorized);

      return reply.status;
    })
  );

  const [first, second] = yield* establishSmokeUsers(input);
  const callback = yield* charge(input, first, second);

  if (Option.isNone(input.erasure)) {
    return {
      signup: [first.outcome, second.outcome],
      callback,
      unassignedCommercialAuthorities: deniedStatuses,
    };
  }

  return {
    signup: [first.outcome, second.outcome],
    callback,
    erasure: yield* erasureEvidence(input, [first, second], input.erasure.value),
    unassignedCommercialAuthorities: deniedStatuses,
  };
});

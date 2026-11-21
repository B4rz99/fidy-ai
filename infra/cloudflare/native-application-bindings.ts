import retainedProvider from "./native-retained-provider.json" with { type: "json" };
import { fixtureArtifacts } from "./native-fixture-signer";
import { Hex } from "effect/encoding";
import * as Cloudflare from "alchemy/Cloudflare";
import { type Output, map } from "alchemy/Output";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { ApprovedOpenAiModel } from "@fidy/server/hosted-inference-contract";
import { EmailAddress } from "@fidy/server/email-authentication-contract";
import { WhatsAppBusinessPhoneNumberId } from "@fidy/server/whatsapp-contract";
import { resolveLocalCanonicalReadBearer } from "../../apps/server/cloudflare/runtime/operations";
import { browserOrigins, productionTopology } from "../../apps/server/cloudflare/runtime/contract";
import { resolveDeploymentConfiguration } from "./deployment-configuration";
import { buildStorageRelease, storageReleaseBinding, storageReleaseCodec } from "./storage-release";
import { nativeIngressHost } from "./storage-installation";

const origins = {
  local: { browser: browserOrigins.local, api: "http://localhost:8787" },
  acceptance: { browser: browserOrigins.nativeAcceptance, api: "https://" + nativeIngressHost },
  staged: {
    browser: browserOrigins.production,
    api: "https://" + productionTopology.ingress.hostname,
  },
};

const pairedOrigin = (
  closed: boolean,
  hosts: keyof typeof origins
): (typeof origins)[keyof typeof origins] => (closed ? origins.acceptance : origins[hosts]);

export const nativeReleaseContext = Effect.fn(function* (development: boolean, stage: string) {
  const config = (name: string): Config.Config<string> =>
    Config.String(name).pipe(Config.withDefault(""));

  const release = yield* Effect.fromResult(
    resolveDeploymentConfiguration({
      development,
      stage,
      gitRevision: yield* config("RELEASE_GIT_SHA"),
      contractDigest: yield* config("CONTRACT_DIGEST"),
      releaseAttemptId: yield* config("RELEASE_ATTEMPT_ID"),
    })
  ).pipe(Effect.orDie);

  const admission = development
    ? "local"
    : yield* Config.Literals(["closed", "open"], "NATIVE_STORAGE_ADMISSION");

  const hosts = development
    ? "local"
    : yield* Config.Literals(["acceptance", "staged"], "NATIVE_STORAGE_HOSTS").pipe(
        Config.withDefault("acceptance")
      );

  if (admission === "open" && hosts !== "staged") {
    return yield* Effect.die(Error("Native opening requires the reviewed staged hosts"));
  }

  const proof = yield* development
    ? Config.Redacted("SMOKE_PROOF").pipe(Config.withDefault(Redacted.make("")))
    : Config.Redacted("SMOKE_PROOF");

  const storage = yield* buildStorageRelease().pipe(
    Effect.flatMap(Schema.encodeEffect(storageReleaseCodec)),
    Effect.orDie
  );

  const closed = admission === "closed",
    origin = pairedOrigin(closed, hosts);

  const artifacts = yield* fixtureArtifacts(release.gitRevision);

  const fixtureSecret = (
    name: string,
    prefix = "",
    generation = release.gitRevision
  ): Redacted.Redacted<string> =>
    Redacted.make(
      prefix +
        new Bun.CryptoHasher("sha256", Redacted.value(proof))
          .update(generation + "/" + name)
          .digest("hex")
    );

  const shared = {
    RECOVERY_ISOLATION: closed ? "isolated" : "",
    NATIVE_STORAGE_ADMISSION: development ? "open" : admission,
    [storageReleaseBinding]: storage,
    BROWSER_ORIGIN: origin.browser,
    RELEASE_GIT_SHA: release.gitRevision,
    CONTRACT_DIGEST: release.contractDigest,
    CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
    SMOKE_PROOF: proof,
  };

  return { release, development, closed, hosts, origin, shared, fixtureSecret, ...artifacts };
});

export type NativeRelease = Effect.Success<ReturnType<typeof nativeReleaseContext>>;

const liveProviders = Effect.fn(function* (development: boolean) {
  const plain = (name: string, local = ""): Config.Config<string> =>
    development ? Config.String(name).pipe(Config.withDefault(local)) : Config.String(name);

  const secret = (name: string): Config.Config<Redacted.Redacted<string>> =>
    development
      ? Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")))
      : Config.Redacted(name);

  return yield* Effect.all({
    OPENAI_API_KEY: secret("OPENAI_API_KEY"),
    KAPSO_API_KEY: secret("KAPSO_API_KEY"),
    KAPSO_WEBHOOK_SECRET: secret("KAPSO_WEBHOOK_SECRET"),
    RESEND_API_KEY: secret("RESEND_API_KEY"),
    GOOGLE_CLIENT_ID: plain("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: secret("GOOGLE_CLIENT_SECRET"),
    MICROSOFT_CLIENT_ID: plain("MICROSOFT_CLIENT_ID"),
    MICROSOFT_CLIENT_SECRET: secret("MICROSOFT_CLIENT_SECRET"),
    WOMPI_ENVIRONMENT: plain("WOMPI_ENVIRONMENT", "sandbox"),
    WOMPI_PUBLIC_KEY: plain("WOMPI_PUBLIC_KEY"),
    WOMPI_PRIVATE_KEY: secret("WOMPI_PRIVATE_KEY"),
    WOMPI_INTEGRITY_SECRET: secret("WOMPI_INTEGRITY_SECRET"),
    WOMPI_EVENT_SECRET: secret("WOMPI_EVENT_SECRET"),
    WOMPI_DAVIPLATA_ACTIVATED: Config.String("WOMPI_DAVIPLATA_ACTIVATED").pipe(
      Config.withDefault("disabled")
    ),
    WOMPI_DAVIPLATA_OTP_SEND_URL: Config.String("WOMPI_DAVIPLATA_OTP_SEND_URL").pipe(
      Config.withDefault("")
    ),
    WOMPI_DAVIPLATA_OTP_CONFIRM_URL: Config.String("WOMPI_DAVIPLATA_OTP_CONFIRM_URL").pipe(
      Config.withDefault("")
    ),
    WHATSAPP_BUSINESS_PORTFOLIO_ID: plain("WHATSAPP_BUSINESS_PORTFOLIO_ID"),
    WHATSAPP_SANDBOX_PHONE_NUMBER_ID: Config.schema(
      Schema.Union([Schema.Literal(""), WhatsAppBusinessPhoneNumberId]),
      "WHATSAPP_SANDBOX_PHONE_NUMBER_ID"
    ).pipe(Config.withDefault("")),
    BANCOLOMBIA_SANDBOX_CLIENT_ID: Config.String("BANCOLOMBIA_SANDBOX_CLIENT_ID").pipe(
      Config.withDefault("")
    ),
    BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: Config.Redacted(
      "BANCOLOMBIA_SANDBOX_CONSENT_PROFILE"
    ).pipe(Config.withDefault(Redacted.make(""))),
    BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: Config.Redacted(
      "BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM"
    ).pipe(Config.withDefault(Redacted.make(""))),
    BANCOLOMBIA_SANDBOX_GRANT_KEY: Config.Redacted("BANCOLOMBIA_SANDBOX_GRANT_KEY").pipe(
      Config.withDefault(Redacted.make(""))
    ),
  });
});

const fixtureProviders = (
  secret: NativeRelease["fixtureSecret"]
): Effect.Success<ReturnType<typeof liveProviders>> => ({
  OPENAI_API_KEY: secret("openai"),
  KAPSO_API_KEY: secret("kapso"),
  KAPSO_WEBHOOK_SECRET: secret("kapso-webhook"),
  RESEND_API_KEY: secret("resend"),
  GOOGLE_CLIENT_ID: "fidy-native-google",
  GOOGLE_CLIENT_SECRET: secret("google"),
  MICROSOFT_CLIENT_ID: "fidy-native-microsoft",
  MICROSOFT_CLIENT_SECRET: secret("microsoft"),
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "pub_test_fidy_native_release",
  WOMPI_PRIVATE_KEY: secret("wompi", "prv_test_"),
  WOMPI_INTEGRITY_SECRET: secret("wompi-integrity", "test_integrity_"),
  WOMPI_EVENT_SECRET: secret("wompi-events", "test_events_"),
  WOMPI_DAVIPLATA_ACTIVATED: "disabled",
  WOMPI_DAVIPLATA_OTP_SEND_URL: "",
  WOMPI_DAVIPLATA_OTP_CONFIRM_URL: "",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "123456789012345",
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: WhatsAppBusinessPhoneNumberId.make("123456789012345"),
  BANCOLOMBIA_SANDBOX_CLIENT_ID: "",
  BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: Redacted.make(""),
  BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: Redacted.make(""),
  BANCOLOMBIA_SANDBOX_GRANT_KEY: Redacted.make(""),
});

export const providerBindings = Effect.fn(function* (release: NativeRelease) {
  const selected = release.closed
    ? fixtureProviders((name, prefix) =>
        release.fixtureSecret(
          name,
          prefix,
          release.retainProvider ? retainedProvider.revision : release.release.gitRevision
        )
      )
    : yield* liveProviders(release.development);

  return {
    ...selected,
    HOSTED_AI_MODEL: yield* Config.schema(ApprovedOpenAiModel, "HOSTED_AI_MODEL"),
    GOOGLE_REDIRECT_URI: release.origin.api + "/providers/google/callback",
    MICROSOFT_REDIRECT_URI: release.origin.api + "/providers/microsoft/callback",
  };
});

const admissionKeyBytes = 32;

export const ingressBindings = Effect.fn(function* (release: NativeRelease) {
  let key = release.fixtureSecret("anonymous-admission");

  if (!release.closed) {
    key = yield* release.development
      ? Config.Redacted("PAT_ADMISSION_KEY").pipe(
          Config.withDefault(
            Redacted.make(Hex.encode(crypto.getRandomValues(new Uint8Array(admissionKeyBytes))))
          )
        )
      : Config.Redacted("PAT_ADMISSION_KEY");
  }

  return {
    PAT_ADMISSION_KEY: key,
    LOCAL_CANONICAL_READ_BEARER: resolveLocalCanonicalReadBearer(release.development),
  };
});

export const operatingBindings = Effect.gen(function* () {
  const bound = (name: string, defaultValue = ""): Config.Config<string> =>
    Config.String(name).pipe(Config.withDefault(defaultValue));

  return yield* Effect.all({
    ASYNC_HEALTH_ENABLED: Effect.succeed("enabled" as const),
    SQLITE_STORE_CAPACITY_BYTES: bound("SQLITE_STORE_CAPACITY_BYTES", "1000000000"),
    WEEKLY_SUMMARY_ENABLED: bound("WEEKLY_SUMMARY_ENABLED", "disabled"),
    WEEKLY_SUMMARY_TEMPLATE_JSON: bound("WEEKLY_SUMMARY_TEMPLATE_JSON"),
    WEEKLY_QUESTION_TEMPLATE_JSON: bound("WEEKLY_QUESTION_TEMPLATE_JSON"),
    PROACTIVITY_ENABLED: bound("PROACTIVITY_ENABLED", "disabled"),
    PROACTIVITY_TEMPLATE_JSON: bound("PROACTIVITY_TEMPLATE_JSON"),
    PROACTIVITY_ASK_AFTER: bound("PROACTIVITY_ASK_AFTER", "4"),
    PROACTIVITY_PAUSE_AFTER: bound("PROACTIVITY_PAUSE_AFTER", "2"),
    PRICING_PUBLISH_AUDIENCE: bound("PRICING_PUBLISH_AUDIENCE"),
    BILLING_SUPPORT_AUDIENCE: bound("BILLING_SUPPORT_AUDIENCE"),
  });
});

const accessRoles = {
  SupportRecoveryAccess: {
    name: "Fidy native support recovery",
    path: "/internal/support-recovery",
  },
  TitularErasureAccess: { name: "Fidy native Titular erasure", path: "/internal/titular-erasure" },
  IngestSampleReviewAccess: {
    name: "Fidy native IngestSample review",
    path: "/internal/sample-review",
  },
  BetaProAccess: { name: "Fidy native beta Pro operator", path: "/internal/beta-pro" },
} as const;

const recoveryPin = map(Cloudflare.Access.getIdentityProvider({ type: "onetimepin" }), (provider) =>
  Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(provider?.identityProviderId)
);

const supportApplication = Effect.fn(function* (
  logicalId: keyof typeof accessRoles,
  member: Option.Option<string>,
  context: {
    release: NativeRelease;
    group: Cloudflare.Access.Group;
  }
) {
  const { name, path } = accessRoles[logicalId];
  const { release, group } = context;

  const hosts =
    release.hosts === "staged"
      ? [nativeIngressHost, productionTopology.ingress.hostname]
      : [nativeIngressHost];

  const include = Option.isNone(member)
    ? [{ group: group.groupId }]
    : [{ email: { email: member.value } }];

  return yield* Cloudflare.Access.Application(logicalId, {
    type: "self_hosted",
    name,
    destinations: hosts.map((host) => ({ type: "public", uri: host + path })),
    sessionDuration: "15m",
    appLauncherVisible: false,
    allowedIdps: [recoveryPin],
    autoRedirectToIdentity: true,
    policies: [{ name, decision: "allow", precedence: 1, sessionDuration: "15m", include }],
  });
});

export const bindPlannedText = Effect.fn(function* (
  worker: Cloudflare.Worker,
  values: Readonly<Record<string, string | Output<string>>>
) {
  yield* Effect.forEach(
    Object.entries(values),
    Effect.fnUntraced(function* ([name, text]) {
      yield* worker.bind`${name}`({ bindings: [{ name, type: "plain_text", text }] });
    }),
    { discard: true }
  );
});

export const privateAccessBindings = Effect.fn(function* (release: NativeRelease) {
  if (release.development) {
    return {
      CLOUDFLARE_ACCESS_ISSUER: "",
      CLOUDFLARE_ACCESS_AUDIENCE: "",
      ERASURE_SUPPORT_AUDIENCE: "",
      BETA_PRO_AUDIENCE: "",
      BETA_PRO_OPERATOR_EMAIL: "",
      SAMPLE_REVIEW_AUDIENCE: "",
      SAMPLE_REVIEWER_EMAIL: "",
    };
  }

  const issuer = yield* Config.String("CLOUDFLARE_ACCESS_ISSUER");
  const operator = yield* Config.schema(EmailAddress, "RECOVERY_OPERATOR_EMAIL");
  const reviewer = yield* Config.Literal("obarboza@fidyapp.com", "SAMPLE_REVIEWER_EMAIL");

  const group = yield* Cloudflare.Access.Group("RecoveryOperators", {
    name: "Fidy native recovery operators",
    include: [{ email: { email: operator } }],
  });

  const betaOperator = yield* Config.Literal("obarboza@fidyapp.com", "BETA_PRO_OPERATOR_EMAIL");
  const context = { release, group };
  const recovery = yield* supportApplication("SupportRecoveryAccess", Option.none(), context);

  const erasure = yield* supportApplication(
    "TitularErasureAccess",
    Option.some("obarboza@fidyapp.com"),
    context
  );

  const sample = yield* supportApplication(
    "IngestSampleReviewAccess",
    Option.some(reviewer),
    context
  );

  const beta = yield* supportApplication("BetaProAccess", Option.some(betaOperator), context);

  return {
    BETA_PRO_OPERATOR_EMAIL: betaOperator,
    BETA_PRO_AUDIENCE: beta.aud,
    CLOUDFLARE_ACCESS_ISSUER: issuer,
    CLOUDFLARE_ACCESS_AUDIENCE: recovery.aud,
    ERASURE_SUPPORT_AUDIENCE: erasure.aud,
    SAMPLE_REVIEW_AUDIENCE: sample.aud,
    SAMPLE_REVIEWER_EMAIL: reviewer,
  };
});

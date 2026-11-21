import retainedProvider from "./native-retained-provider.json" with { type: "json" };
import { installedOrigins } from "../../apps/server/src/shell/browser-transport/contract";
import { Schema } from "effect";

export const nativeResourceInventory = (revision: string): ReadonlyMap<string, string> => {
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw Error("Missing native release revision");

  const resources = {
    "Cloudflare.Access.Group": ["RecoveryOperators"],
    "Cloudflare.Access.Application": [
      "SupportRecoveryAccess",
      "TitularErasureAccess",
      "IngestSampleReviewAccess",
      "BetaProAccess",
    ],
    "Cloudflare.R2.Bucket": [
      "StatementStagingBucket",
      "ApprovedIngestSamples",
      "ForwardedEmailBucket",
      "ReleaseSmokeBucket",
    ],
    "Cloudflare.Queues.Queue": [
      "ForwardedEmailQueue",
      "ConnectionSynchronizationQueue",
      "StatementExtractionQueue",
      "AsyncDeadLetters",
      "OperationalCanaryQueue",
      `ReleaseSmokeQueue-${revision}`,
      "BillingCollectionQueue",
      "HostedWhatsAppQueue",
      "WeeklyDeliveryQueue",
      "BrowserPairingEmailQueue",
    ],
    "Cloudflare.Worker": [`ReleaseSmoke-${revision}`, "Core", "ForwardedEmail", "Ingress", "Web"],
    "Cloudflare.Workflow": [
      `ReleaseSmokeWorkflowV2-${revision}`,
      "ConnectionSynchronizationWorkflow",
      "WeeklyDeliveryWorkflow",
      "StatementExtractionWorkflowV1",
      "OperationalCanaryWorkflowV1",
      "BillingCollectionWorkflowV1",
      "BillingRefundWorkflowV1",
      "BrowserPairingEmailWorkflowV1",
    ],
    "Cloudflare.Queues.Consumer": [
      "OperationalCanaryConsumer",
      `ReleaseSmokeConsumer-${revision}`,
      "ForwardedEmailConsumer",
      "ConnectionSynchronizationConsumer",
      "StatementExtractionConsumer",
      "BillingCollectionConsumer",
      "BrowserPairingEmailConsumer",
      "WeeklyDeliveryConsumer",
      "HostedWhatsAppConsumer",
    ],
    "Command.Build": ["Build"],
  };

  return new Map(
    Object.entries(resources).flatMap(([type, ids]) => ids.map((id) => [id, type] as const))
  );
};

export type NativeRole = "Core" | "Ingress" | "Web" | "ForwardedEmail" | "Smoke";

const kinds: Readonly<Record<NativeRole, Readonly<Record<string, ReadonlyArray<string>>>>> = {
  Smoke: {
    r2_bucket: ["SMOKE_BUCKET"],
    version_metadata: ["CF_VERSION_METADATA"],
    plain_text: [
      "SMOKE_QUEUE_NAME",
      "RELEASE_GIT_SHA",
      "CONTRACT_DIGEST",
      "NATIVE_STORAGE_ADMISSION",
      "ACCEPTANCE_API_ORIGIN",
    ],
    secret_text: ["ACCEPTANCE_CODE_KEY", "ACCEPTANCE_GOOGLE_SECRET", "ACCEPTANCE_MICROSOFT_SECRET"],
    workflow: ["SMOKE_WORKFLOW"],
  },
  Core: {
    plain_text: [
      "RECOVERY_ISOLATION",
      "NATIVE_STORAGE_ADMISSION",
      "SQLITE_STORAGE_RELEASE",
      "BANCOLOMBIA_SANDBOX_CLIENT_ID",
      "SMOKE_QUEUE_NAME",
      "CONTRACT_DIGEST",
      "CONNECTION_SYNCHRONIZATION_QUEUE_NAME",
      "WEEKLY_SUMMARY_ENABLED",
      "WEEKLY_SUMMARY_TEMPLATE_JSON",
      "WEEKLY_QUESTION_TEMPLATE_JSON",
      "PROACTIVITY_ENABLED",
      "PROACTIVITY_TEMPLATE_JSON",
      "PROACTIVITY_ASK_AFTER",
      "PROACTIVITY_PAUSE_AFTER",
      "SQLITE_STORE_CAPACITY_BYTES",
      "PRICING_PUBLISH_AUDIENCE",
      "HOSTED_AI_MODEL",
      "ASYNC_HEALTH_ENABLED",
      "OPERATIONAL_CANARY_QUEUE_NAME",
      "ERASURE_SUPPORT_AUDIENCE",
      "BILLING_SUPPORT_AUDIENCE",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_REDIRECT_URI",
      "MICROSOFT_CLIENT_ID",
      "MICROSOFT_REDIRECT_URI",
      "BROWSER_ORIGIN",
      "WOMPI_ENVIRONMENT",
      "WOMPI_PUBLIC_KEY",
      "WOMPI_DAVIPLATA_ACTIVATED",
      "WOMPI_DAVIPLATA_OTP_SEND_URL",
      "WOMPI_DAVIPLATA_OTP_CONFIRM_URL",
      "CLOUDFLARE_ACCESS_ISSUER",
      "CLOUDFLARE_ACCESS_AUDIENCE",
      "SAMPLE_REVIEW_AUDIENCE",
      "SAMPLE_REVIEWER_EMAIL",
      "BETA_PRO_OPERATOR_EMAIL",
      "BETA_PRO_AUDIENCE",
      "WHATSAPP_BUSINESS_PORTFOLIO_ID",
      "WHATSAPP_SANDBOX_PHONE_NUMBER_ID",
      "RELEASE_GIT_SHA",
    ],
    secret_text: [
      "BANCOLOMBIA_SANDBOX_CONSENT_PROFILE",
      "BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM",
      "BANCOLOMBIA_SANDBOX_GRANT_KEY",
      "OPENAI_API_KEY",
      "SMOKE_PROOF",
      "KAPSO_API_KEY",
      "KAPSO_WEBHOOK_SECRET",
      "RESEND_API_KEY",
      "GOOGLE_CLIENT_SECRET",
      "MICROSOFT_CLIENT_SECRET",
      "WOMPI_PRIVATE_KEY",
      "WOMPI_INTEGRITY_SECRET",
      "WOMPI_EVENT_SECRET",
    ],
    version_metadata: ["CF_VERSION_METADATA"],
    ratelimit: ["SMOKE_LIMITER"],
    r2_bucket: ["SMOKE_BUCKET", "EMAIL_BUCKET", "STATEMENT_STAGING_BUCKET", "SAMPLE_BUCKET"],
    queue: [
      "SMOKE_QUEUE",
      "CONNECTION_SYNCHRONIZATION_QUEUE",
      "STATEMENT_EXTRACTION_QUEUE",
      "HOSTED_WHATSAPP_QUEUE",
      "WEEKLY_DELIVERY_QUEUE",
      "ASYNC_DEAD_LETTERS",
      "OPERATIONAL_CANARY_QUEUE",
      "FORWARDED_EMAIL_QUEUE",
      "BILLING_COLLECTION_QUEUE",
      "BROWSER_PAIRING_EMAIL_QUEUE",
    ],
    workflow: [
      "SMOKE_WORKFLOW",
      "CONNECTION_SYNCHRONIZATION_WORKFLOW",
      "WEEKLY_DELIVERY_WORKFLOW",
      "STATEMENT_EXTRACTION_WORKFLOW",
      "OPERATIONAL_CANARY_WORKFLOW",
      "BILLING_COLLECTION_WORKFLOW",
      "BILLING_REFUND_WORKFLOW",
      "BROWSER_PAIRING_EMAIL_WORKFLOW",
    ],
    service: ["RELEASE_FIXTURE"],
    durable_object_namespace: ["USER_STORE", "DIRECTORY", "PRICING", "MAINTENANCE", "ERASURE"],
  },
  ForwardedEmail: {
    plain_text: ["RELEASE_GIT_SHA"],
  },
  Ingress: {
    plain_text: [
      "RECOVERY_ISOLATION",
      "NATIVE_STORAGE_ADMISSION",
      "SQLITE_STORAGE_RELEASE",
      "BROWSER_ORIGIN",
      "CONTRACT_DIGEST",
      "LOCAL_CANONICAL_READ_BEARER",
      "RELEASE_GIT_SHA",
    ],
    version_metadata: ["CF_VERSION_METADATA"],
    secret_text: ["SMOKE_PROOF", "PAT_ADMISSION_KEY"],
    service: ["CORE", "RELEASE_FIXTURE"],
  },
  Web: {
    plain_text: ["CONTRACT_DIGEST", "RELEASE_GIT_SHA"],
    assets: ["ASSETS"],
  },
};

export const nativeBindingInventory = ({
  role,
  fingerprint,
}: {
  role: NativeRole;
  fingerprint: string;
}): ReadonlyMap<string, string> => {
  const expected = new Map(
    Object.entries(kinds[role]).flatMap(([type, names]) =>
      names.map((name) => [name, type] as const)
    )
  );

  if (fingerprint !== "" && !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw Error("Invalid expected native fixture signer fingerprint");
  }

  if (fingerprint !== "" && role === "Core") {
    expected.set("ACCEPTANCE_PROVIDER_REVISION", "plain_text");
    expected.set("NATIVE_FIXTURE_SIGNING_KEY", "secret_text");
    expected.set("NATIVE_FIXTURE_SIGNER_SHA256", "plain_text");
  }

  return expected;
};

const Binding = Schema.StructWithRest(Schema.Struct({ name: Schema.String, type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

export type NativeBinding = typeof Binding.Type;

export const NativeBindings = Schema.Array(Binding);

const requireClosedRole = (
  role: NativeRole,
  bindings: ReadonlyArray<NativeBinding>,
  fingerprint: string
): void => {
  const textIs = (name: string, expected: string): boolean =>
    bindings.find((binding) => binding.name === name)?.text === expected;

  if (
    fingerprint !== "" &&
    role === "Core" &&
    (!textIs("ACCEPTANCE_PROVIDER_REVISION", retainedProvider.revision) ||
      !textIs("NATIVE_FIXTURE_SIGNER_SHA256", fingerprint) ||
      !textIs("BROWSER_ORIGIN", installedOrigins.acceptance.browser))
  ) {
    throw Error("Actual candidate receipt signer or closed acceptance origin differs");
  }

  if (!textIs("RECOVERY_ISOLATION", "isolated") || !textIs("NATIVE_STORAGE_ADMISSION", "closed")) {
    throw Error("Closed admission is required");
  }
};

export const requireRoleBindings = ({
  role,
  bindings,
  fingerprint,
}: {
  role: NativeRole;
  bindings: ReadonlyArray<NativeBinding>;
  fingerprint: string;
}): void => {
  const expected = nativeBindingInventory({ role, fingerprint });

  if (
    bindings.length !== expected.size ||
    new Set(bindings.map((binding) => binding.name)).size !== expected.size ||
    bindings.some((binding) => expected.get(binding.name) !== binding.type)
  ) {
    throw Error("Missing, extra or unexpected native Worker binding for " + role);
  }

  if (role === "Ingress" || role === "Core") requireClosedRole(role, bindings, fingerprint);
};

export const requireSuccessorCoreBindings = ({
  bindings,
  fingerprint,
}: {
  bindings: ReadonlyArray<NativeBinding>;
  fingerprint: string;
}): void => {
  const members = bindings.filter((binding) => binding.name === "NATIVE_FIXTURE_MEMBER");
  const [member] = members;

  if (
    fingerprint === "" ||
    members.length !== 1 ||
    member?.type !== "plain_text" ||
    member.text !== "performance-2"
  ) {
    throw Error("Successor Core must select the second fixture member");
  }

  requireRoleBindings({
    role: "Core",
    fingerprint,
    bindings: bindings.filter((binding) => binding.name !== "NATIVE_FIXTURE_MEMBER"),
  });
};

export const smokeResource = (id: string): boolean =>
  /^(?:ReleaseSmoke(?:Queue|WorkflowV2|Consumer)?)-[0-9a-f]{40}$/u.test(id);

const Planned = Schema.Struct({
  action: Schema.String,
  resourceType: Schema.String,
  logicalId: Schema.String,
});

const retainedSmoke = (row: typeof Planned.Type, revision: string): boolean => {
  if (row.action !== "delete" || !smokeResource(row.logicalId)) return false;
  const prior = row.logicalId.slice(-revision.length);

  return (
    prior !== revision && nativeResourceInventory(prior).get(row.logicalId) === row.resourceType
  );
};

const validChange = (row: typeof Planned.Type, first: boolean): boolean => {
  if (first) return row.action === "create";

  return (
    row.action === "noop" ||
    row.action === "update" ||
    (row.action === "create" && smokeResource(row.logicalId))
  );
};

export const requireNativeResourcePlan = ({
  plan,
  revision,
  first,
}: {
  plan: { resources: ReadonlyArray<unknown>; actions: ReadonlyArray<unknown> };
  revision: string;
  first: boolean;
}): void => {
  const expected = new Map(nativeResourceInventory(revision));
  const rows = Schema.decodeUnknownSync(Schema.Array(Planned))(plan.resources);

  if (plan.actions.length !== 0) throw Error("Unexpected remote plan action");

  for (const row of rows) {
    if (!first && retainedSmoke(row, revision)) continue;

    if (row.resourceType !== expected.get(row.logicalId) || !validChange(row, first)) {
      throw Error("Unexpected native resource or lifecycle for " + row.logicalId);
    }

    expected.delete(row.logicalId);
  }

  if (expected.size !== 0) throw Error("Incomplete native application plan");
};

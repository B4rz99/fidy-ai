#!/usr/bin/env bun

import { Result, Schema } from "effect";

const cloudflareApi = "https://api.cloudflare.com/client/v4";
const CloudflareFailure = Schema.Struct({
  success: Schema.Literal(false),
  errors: Schema.Array(Schema.Struct({ message: Schema.String })),
});
const Zone = Schema.Struct({ id: Schema.String, name: Schema.String });
const ZonesResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(Zone),
});
const DnsRecord = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  name: Schema.String,
  content: Schema.String,
});
const RecordsResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(DnsRecord),
});
const RecordResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: DnsRecord,
});

type HttpRequest = (input: string | URL | Request, init: RequestInit) => Promise<Response>;

type ProductionDns = {
  readonly apiToken: string;
  readonly accountId: string;
  readonly zoneName: string;
  readonly cnameTarget: string;
  readonly verificationName: string;
  readonly verificationValue: string;
  readonly ingestMxTarget: string;
  readonly ingestDkimName: string;
  readonly ingestDkimValue: string;
  readonly ingestSendingMxTarget: string;
  readonly ingestSpfValue: string;
};

export type CloudflareDnsDependencies = {
  readonly request: HttpRequest;
};

type CloudflareRequest<Value> = {
  readonly request: HttpRequest;
  readonly token: string;
  readonly url: URL;
  readonly init: RequestInit;
  readonly decode: (value: unknown) => Value;
};

const mailExchangePriority = 10;

type DesiredRecord =
  | {
      readonly type: "CNAME";
      readonly name: string;
      readonly content: string;
      readonly proxied: false;
    }
  | {
      readonly type: "TXT";
      readonly name: string;
      readonly content: string;
    }
  | {
      readonly type: "MX";
      readonly name: string;
      readonly content: string;
      readonly priority: typeof mailExchangePriority;
    };

const liveDependencies: CloudflareDnsDependencies = {
  request: (input, init): Promise<Response> => Bun.fetch(input, init),
};

const cloudflareRequest = async <Value>(input: CloudflareRequest<Value>): Promise<Value> => {
  const response = await input.request(input.url, {
    ...input.init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) throw new Error(`Cloudflare returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  const failure = Schema.decodeUnknownResult(CloudflareFailure)(body);
  if (Result.isSuccess(failure)) {
    const messages = failure.success.errors.map(({ message }) => message).join("; ");
    throw new Error(`Cloudflare API failed: ${messages || "unknown provider failure"}`);
  }
  return input.decode(body);
};

const findZone = async (
  input: ProductionDns,
  dependencies: CloudflareDnsDependencies
): Promise<string> => {
  const url = new URL(`${cloudflareApi}/zones`);
  url.searchParams.set("name", input.zoneName);
  url.searchParams.set("account.id", input.accountId);
  const response = await cloudflareRequest({
    request: dependencies.request,
    token: input.apiToken,
    url,
    init: {},
    decode: Schema.decodeUnknownSync(ZonesResponse),
  });
  if (response.result.length !== 1 || response.result[0]?.name !== input.zoneName) {
    throw new Error(`Cloudflare did not return exactly one ${input.zoneName} zone`);
  }
  return response.result[0].id;
};

const reconcileRecord = async (
  target: { readonly zoneId: string; readonly desired: DesiredRecord },
  input: ProductionDns,
  dependencies: CloudflareDnsDependencies
): Promise<void> => {
  const { desired, zoneId } = target;
  const recordsUrl = new URL(`${cloudflareApi}/zones/${zoneId}/dns_records`);
  recordsUrl.searchParams.set("type", desired.type);
  recordsUrl.searchParams.set("name", desired.name);
  const existing = await cloudflareRequest({
    request: dependencies.request,
    token: input.apiToken,
    url: recordsUrl,
    init: {},
    decode: Schema.decodeUnknownSync(RecordsResponse),
  });
  if (existing.result.length > 1) {
    throw new Error(`Cloudflare returned duplicate ${desired.type} records for ${desired.name}`);
  }
  const current = existing.result[0];
  const writeUrl =
    current === undefined
      ? new URL(`${cloudflareApi}/zones/${zoneId}/dns_records`)
      : new URL(`${cloudflareApi}/zones/${zoneId}/dns_records/${current.id}`);
  const method = current === undefined ? "POST" : "PUT";
  const written = await cloudflareRequest({
    request: dependencies.request,
    token: input.apiToken,
    url: writeUrl,
    init: { method, body: JSON.stringify({ ...desired, ttl: 1 }) },
    decode: Schema.decodeUnknownSync(RecordResponse),
  });
  if (
    written.result.type !== desired.type ||
    written.result.name !== desired.name ||
    written.result.content !== desired.content
  ) {
    throw new Error(`Cloudflare returned a different ${desired.type} record`);
  }
};

const validateProductionDns = (input: ProductionDns): void => {
  if (Object.values(input).some((value) => value === "")) {
    throw new Error("Production DNS configuration is incomplete");
  }
  const exactIngestDkimName = `resend._domainkey.ingest.${input.zoneName}`;
  if (input.ingestDkimName !== exactIngestDkimName) {
    throw new Error(`Resend DKIM name must be exactly ${exactIngestDkimName}`);
  }
};

const desiredProductionRecords = (input: ProductionDns): ReadonlyArray<DesiredRecord> => [
  {
    type: "CNAME",
    name: `api.${input.zoneName}`,
    content: input.cnameTarget,
    proxied: false,
  },
  { type: "TXT", name: input.verificationName, content: input.verificationValue },
  {
    type: "MX",
    name: `ingest.${input.zoneName}`,
    content: input.ingestMxTarget,
    priority: mailExchangePriority,
  },
  { type: "TXT", name: input.ingestDkimName, content: input.ingestDkimValue },
  {
    type: "MX",
    name: `send.ingest.${input.zoneName}`,
    content: input.ingestSendingMxTarget,
    priority: mailExchangePriority,
  },
  {
    type: "TXT",
    name: `send.ingest.${input.zoneName}`,
    content: input.ingestSpfValue,
  },
];

/**
 * Reconciles the exact Railway API/ownership and Resend receiving, sending, DKIM, SPF, API, and
 * verification records inside one Cloudflare zone. Records are replaced by identity while
 * unrelated records, including root Workspace mail records, remain unchanged; duplicates and
 * provider failures stop the release before Railway or web promotion.
 */
export const reconcileProductionDns = async (
  input: ProductionDns,
  dependencies: CloudflareDnsDependencies = liveDependencies
): Promise<void> => {
  validateProductionDns(input);
  const zoneId = await findZone(input, dependencies);
  for (const desired of desiredProductionRecords(input)) {
    await reconcileRecord({ zoneId, desired }, input, dependencies);
  }
};

const requiredEnvironment = (name: string): string => {
  const value = Bun.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

if (import.meta.main) {
  await reconcileProductionDns({
    apiToken: requiredEnvironment("CLOUDFLARE_API_TOKEN"),
    accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
    zoneName: requiredEnvironment("PRODUCTION_DNS_ZONE"),
    cnameTarget: requiredEnvironment("PRODUCTION_API_CNAME_TARGET"),
    verificationName: requiredEnvironment("PRODUCTION_API_VERIFICATION_NAME"),
    verificationValue: requiredEnvironment("PRODUCTION_API_VERIFICATION_VALUE"),
    ingestMxTarget: requiredEnvironment("RESEND_INGEST_MX_TARGET"),
    ingestDkimName: requiredEnvironment("RESEND_INGEST_DKIM_NAME"),
    ingestDkimValue: requiredEnvironment("RESEND_INGEST_DKIM_VALUE"),
    ingestSendingMxTarget: requiredEnvironment("RESEND_INGEST_SENDING_MX_TARGET"),
    ingestSpfValue: requiredEnvironment("RESEND_INGEST_SPF_VALUE"),
  });
}

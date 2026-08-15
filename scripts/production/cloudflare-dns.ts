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

/**
 * Reconciles the public API's direct Railway CNAME and Railway ownership proof inside exactly one
 * Cloudflare zone. Existing records are replaced by identity; duplicate records and provider
 * failures stop the release before Railway or web promotion.
 */
export const reconcileProductionDns = async (
  input: ProductionDns,
  dependencies: CloudflareDnsDependencies = liveDependencies
): Promise<void> => {
  if (
    input.apiToken === "" ||
    input.accountId === "" ||
    input.zoneName === "" ||
    input.cnameTarget === "" ||
    input.verificationName === "" ||
    input.verificationValue === ""
  ) {
    throw new Error("Production DNS configuration is incomplete");
  }
  const zoneId = await findZone(input, dependencies);
  await reconcileRecord(
    {
      zoneId,
      desired: {
        type: "CNAME",
        name: `api.${input.zoneName}`,
        content: input.cnameTarget,
        proxied: false,
      },
    },
    input,
    dependencies
  );
  await reconcileRecord(
    {
      zoneId,
      desired: {
        type: "TXT",
        name: input.verificationName,
        content: input.verificationValue,
      },
    },
    input,
    dependencies
  );
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
  });
}

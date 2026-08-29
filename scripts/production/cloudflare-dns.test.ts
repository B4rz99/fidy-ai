import { describe, expect, it } from "vitest";
import { type CloudflareDnsDependencies, reconcileProductionDns } from "./cloudflare-dns";

const productionDns = {
  accountId: "cloudflare-account",
  apiToken: "cloudflare-token",
  cnameTarget: "server.up.railway.app",
  verificationName: "_railway-verify.api.fidyapp.com",
  verificationValue: "railway-verify=proof",
  ingestMxTarget: "inbound-smtp.us-east-1.amazonaws.com",
  ingestDkimName: "resend._domainkey.ingest.fidyapp.com",
  ingestDkimValue: "p=public-key",
  ingestSendingMxTarget: "feedback-smtp.sa-east-1.amazonses.com",
  ingestSpfValue: "v=spf1 include:amazonses.com ~all",
  zoneName: "fidyapp.com",
};

const jsonResponse = (value: unknown): Response => Response.json(value);

type RecordedRequest = {
  readonly url: string;
  readonly init: RequestInit;
};

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const dependencies = (
  responses: ReadonlyArray<Response>,
  requests: Array<RecordedRequest>
): CloudflareDnsDependencies => {
  const pending = [...responses];
  return {
    request: async (input, init): Promise<Response> => {
      requests.push({ url: requestUrl(input), init });
      const response = pending.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    },
  };
};

const requiredRequest = (
  requests: ReadonlyArray<RecordedRequest>,
  index: number
): RecordedRequest => {
  const request = requests[index];
  if (request === undefined) throw new Error(`missing request ${index}`);
  return request;
};

const record = (
  id: string,
  type: string,
  value: { readonly name: string; readonly content: string }
): {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
} => ({
  id,
  type,
  ...value,
});

describe("Cloudflare Production DNS adapter", () => {
  it("replaces the API route and creates Railway ownership proof in one exact zone", async () => {
    const requests: Array<RecordedRequest> = [];
    const adapter = dependencies(
      [
        jsonResponse({ success: true, result: [{ id: "zone-1", name: "fidyapp.com" }] }),
        jsonResponse({
          success: true,
          result: [
            record("record-1", "CNAME", {
              name: "api.fidyapp.com",
              content: "vercel.example",
            }),
          ],
        }),
        jsonResponse({
          success: true,
          result: record("record-1", "CNAME", {
            name: "api.fidyapp.com",
            content: "server.up.railway.app",
          }),
        }),
        jsonResponse({ success: true, result: [] }),
        jsonResponse({
          success: true,
          result: record("record-2", "TXT", {
            name: "_railway-verify.api.fidyapp.com",
            content: "railway-verify=proof",
          }),
        }),
        jsonResponse({ success: true, result: [] }),
        jsonResponse({
          success: true,
          result: record("record-3", "MX", {
            name: "ingest.fidyapp.com",
            content: "inbound-smtp.us-east-1.amazonaws.com",
          }),
        }),
        jsonResponse({ success: true, result: [] }),
        jsonResponse({
          success: true,
          result: record("record-4", "TXT", {
            name: "resend._domainkey.ingest.fidyapp.com",
            content: "p=public-key",
          }),
        }),
        jsonResponse({ success: true, result: [] }),
        jsonResponse({
          success: true,
          result: record("record-5", "MX", {
            name: "send.ingest.fidyapp.com",
            content: "feedback-smtp.sa-east-1.amazonses.com",
          }),
        }),
        jsonResponse({ success: true, result: [] }),
        jsonResponse({
          success: true,
          result: record("record-6", "TXT", {
            name: "send.ingest.fidyapp.com",
            content: "v=spf1 include:amazonses.com ~all",
          }),
        }),
      ],
      requests
    );

    await expect(reconcileProductionDns(productionDns, adapter)).resolves.toBeUndefined();
    const zoneRequest = requiredRequest(requests, 0);
    const apiWrite = requiredRequest(requests, 2);
    const verificationWrite = requiredRequest(requests, 4);
    const receivingMxWrite = requiredRequest(requests, 6);
    const sendingMxWrite = requiredRequest(requests, 10);
    expect(zoneRequest.url).toContain("/zones?name=fidyapp.com&account.id=cloudflare-account");
    expect(zoneRequest.init.headers).toMatchObject({ Authorization: "Bearer cloudflare-token" });
    expect(apiWrite.url).toContain("/dns_records/record-1");
    expect(apiWrite.init.method).toBe("PUT");
    expect(apiWrite.init.body).toContain('"proxied":false');
    expect(verificationWrite.init.method).toBe("POST");
    expect(receivingMxWrite.init.body).toContain('"name":"ingest.fidyapp.com"');
    expect(receivingMxWrite.init.body).toContain('"priority":10');
    expect(sendingMxWrite.init.body).toContain('"name":"send.ingest.fidyapp.com"');
    expect(
      requests.some(
        (request) => request.url.includes("type=MX") && request.url.includes("name=fidyapp.com")
      )
    ).toBe(false);
  });

  it("rejects any DKIM name that could overwrite the root Workspace record", async () => {
    await expect(
      reconcileProductionDns(
        { ...productionDns, ingestDkimName: "google._domainkey.fidyapp.com" },
        dependencies([], [])
      )
    ).rejects.toThrow("Resend DKIM name must be exactly resend._domainkey.ingest.fidyapp.com");
  });

  it("fails closed when Cloudflare reports duplicate route records", async () => {
    const requests: Array<RecordedRequest> = [];
    const adapter = dependencies(
      [
        jsonResponse({ success: true, result: [{ id: "zone-1", name: "fidyapp.com" }] }),
        jsonResponse({
          success: true,
          result: [
            record("record-1", "CNAME", {
              name: "api.fidyapp.com",
              content: "one.example",
            }),
            record("record-2", "CNAME", {
              name: "api.fidyapp.com",
              content: "two.example",
            }),
          ],
        }),
      ],
      requests
    );

    await expect(reconcileProductionDns(productionDns, adapter)).rejects.toThrow(
      "Cloudflare returned duplicate CNAME records for api.fidyapp.com"
    );
  });

  it("surfaces Cloudflare provider failures", async () => {
    const adapter = dependencies(
      [jsonResponse({ success: false, errors: [{ message: "DNS edit denied" }] })],
      []
    );

    await expect(reconcileProductionDns(productionDns, adapter)).rejects.toThrow(
      "Cloudflare API failed: DNS edit denied"
    );
  });
});

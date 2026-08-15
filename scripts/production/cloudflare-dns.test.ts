import { describe, expect, it } from "vitest";
import { type CloudflareDnsDependencies, reconcileProductionDns } from "./cloudflare-dns";

const productionDns = {
  accountId: "cloudflare-account",
  apiToken: "cloudflare-token",
  cnameTarget: "server.up.railway.app",
  verificationName: "_railway-verify.api.fidyapp.com",
  verificationValue: "railway-verify=proof",
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
      ],
      requests
    );

    await expect(reconcileProductionDns(productionDns, adapter)).resolves.toBeUndefined();
    expect(requests[0]?.url).toContain("/zones?name=fidyapp.com&account.id=cloudflare-account");
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: "Bearer cloudflare-token",
    });
    expect(requests[2]?.url).toContain("/dns_records/record-1");
    expect(requests[2]?.init.method).toBe("PUT");
    expect(requests[2]?.init.body).toContain('"proxied":false');
    expect(requests[4]?.init.method).toBe("POST");
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

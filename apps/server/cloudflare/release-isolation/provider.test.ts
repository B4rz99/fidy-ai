import { expect, it } from "vitest";
import { Effect } from "effect";
import { fetchForInstalledRelease } from "./runtime";

it("sends closed provider work only to the private fixture and fetches human Access keys without incoming credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const publicCalls: Request[] = [],
        fixtureCalls: Request[] = [];

      const capture = (calls: Request[]): typeof fetch =>
        Object.assign(
          (input: string | URL | Request, init?: RequestInit) => {
            calls.push(new Request(input, init));

            return Promise.resolve(new Response(null, { status: 204 }));
          },
          { preconnect: () => undefined }
        );

      const settings = {
        NATIVE_STORAGE_ADMISSION: "closed",
        RECOVERY_ISOLATION: "isolated",
        CLOUDFLARE_ACCESS_ISSUER: "https://fixture-team.cloudflareaccess.com",
        RELEASE_FIXTURE: { fetch: capture(fixtureCalls) },
      };

      const network = capture(publicCalls),
        closed = fetchForInstalledRelease({ transport: network, bindings: settings }),
        request = (url: string): Request =>
          new Request(url, {
            headers: { authorization: "Bearer fixture", "x-test-secret": "fixture" },
          });

      yield* Effect.tryPromise(() =>
        closed(request("https://api.resend.com/emails"), { method: "POST" })
      );
      yield* Effect.tryPromise(() =>
        closed(request(settings.CLOUDFLARE_ACCESS_ISSUER + "/cdn-cgi/access/certs"))
      );
      yield* Effect.tryPromise(() =>
        closed(request("https://other.cloudflareaccess.com/cdn-cgi/access/certs"))
      );
      expect(fixtureCalls.map((item) => item.url)).toEqual([
        "https://api.resend.com/emails",
        "https://other.cloudflareaccess.com/cdn-cgi/access/certs",
      ]);
      expect(publicCalls.map((item) => [item.url, item.redirect, [...item.headers]])).toEqual([
        [
          settings.CLOUDFLARE_ACCESS_ISSUER + "/cdn-cgi/access/certs",
          "manual",
          [["accept", "application/json"]],
        ],
      ]);

      const absent = fetchForInstalledRelease({
        transport: network,
        bindings: {
          NATIVE_STORAGE_ADMISSION: "closed",
          RECOVERY_ISOLATION: "isolated",
        },
      });

      expect((yield* Effect.tryPromise(() => absent("https://api.openai.com"))).status).toBe(503);
      expect(publicCalls.length).toBe(1);
    })
  ));

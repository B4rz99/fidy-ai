import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import webWorker from "./worker";

const appOrigin = "https://app.fidyapp.com";
const binding = "10000000-0000-4000-8000-000000000061";
const cookie = "__Host-fidy_session=test-only-browser-proof";
const html = '<main data-dashboard-read-state="ready"><h1>Tablero</h1></main>';
const assets = {
  fetch: (): Promise<Response> =>
    Promise.resolve(
      new Response('<html><div id="root"></div></html>', {
        headers: { "content-type": "text/html", "cache-control": "public, max-age=3600" },
      })
    ),
};

describe("same-origin Dashboard document transport", () => {
  it("derives the current cookie binding and releases one complete private document without using a supplied binding", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observed: Request[] = [];
        const response = yield* Effect.tryPromise(() =>
          webWorker.fetch(
            new Request(`${appOrigin}/app/dashboard`, {
              headers: { cookie, "Fidy-Session-Binding": "forged-mounted-binding" },
            }),
            {
              ASSETS: assets,
              BROWSER_ORIGIN: appOrigin,
              API: {
                fetch: (request): Promise<Response> => {
                  observed.push(request);
                  if (new URL(request.url).pathname === "/web/session/binding") {
                    return Promise.resolve(Response.json({ binding }));
                  }
                  return Promise.resolve(
                    new Response(html, { headers: { "content-type": "text/html" } })
                  );
                },
              },
            }
          )
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("fidy-dashboard-status")).toBe("200");
        expect(yield* Effect.tryPromise(() => response.text())).toContain(html);
        expect(observed.map((request) => new URL(request.url).origin)).toEqual([
          "https://api.fidyapp.com",
          "https://api.fidyapp.com",
        ]);
        expect(observed[0]?.headers.has("Fidy-Session-Binding")).toBe(false);
        expect(observed[1]?.headers.get("Fidy-Session-Binding")).toBe(binding);
        expect(observed[1]?.headers.get("cookie")).toBe(cookie);
      })
    ));

  it("keeps session establishment cookies host-only while forwarding only to the fixed public ingress", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const issued = `${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict`;
        const observed: Request[] = [];
        const response = yield* Effect.tryPromise(() =>
          webWorker.fetch(
            new Request(`${appOrigin}/web/pairings/redeem`, {
              method: "POST",
              headers: { origin: appOrigin },
              body: "proof",
            }),
            {
              ASSETS: assets,
              BROWSER_ORIGIN: appOrigin,
              API: {
                fetch: (request): Promise<Response> => {
                  observed.push(request);
                  return Promise.resolve(new Response(null, { headers: { "set-cookie": issued } }));
                },
              },
            }
          )
        );
        expect(response.headers.get("set-cookie")).toBe(issued);
        expect(new URL(observed[0]?.url ?? "").origin).toBe("https://api.fidyapp.com");
        expect(observed[0]?.redirect).toBe("manual");
      })
    ));

  it("bounds streamed private content and cancels an oversized response before releasing a document", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let canceled = false;
        const response = yield* Effect.tryPromise(() =>
          webWorker.fetch(new Request(`${appOrigin}/app/dashboard`), {
            ASSETS: assets,
            BROWSER_ORIGIN: appOrigin,
            API: {
              fetch: (request): Promise<Response> => {
                if (new URL(request.url).pathname === "/web/session/binding") {
                  return Promise.resolve(Response.json({ binding }));
                }
                return Promise.resolve(
                  new Response(
                    new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(new Uint8Array(1_048_577));
                      },
                      cancel() {
                        canceled = true;
                      },
                    }),
                    { headers: { "content-type": "text/html" } }
                  )
                );
              },
            },
          })
        );
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(yield* Effect.tryPromise(() => response.text())).not.toContain("dashboard-initial");
        expect(canceled).toBe(true);
      })
    ));

  it("refuses alternate hosts and internal control-plane paths before they reach a binding", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const forbidden = (): Promise<never> =>
          Promise.reject(new Error("Unexpected binding access"));
        const environment = {
          ASSETS: { fetch: forbidden },
          API: { fetch: forbidden },
          BROWSER_ORIGIN: appOrigin,
        };
        expect(
          (yield* Effect.tryPromise(() =>
            webWorker.fetch(new Request("https://untrusted.example/dashboard/view"), environment)
          )).status
        ).toBe(403);
        expect(
          (yield* Effect.tryPromise(() =>
            webWorker.fetch(new Request(`${appOrigin}/internal/titular-erasure`), environment)
          )).status
        ).toBe(404);
        expect(
          (yield* Effect.tryPromise(() =>
            webWorker.fetch(new Request(`${appOrigin}/web/arbitrary`), environment)
          )).status
        ).toBe(404);
        expect(
          (yield* Effect.tryPromise(() =>
            webWorker.fetch(
              new Request(`${appOrigin}/dashboard/view`, { method: "POST" }),
              environment
            )
          )).status
        ).toBe(404);
      })
    ));
});

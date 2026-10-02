import { expect, it } from "@effect/vitest";
import publicWorker from "../public-worker";
import { Effect } from "effect";
import { deriveAnonymousSource } from "./operations";

const admissionKey = "test-only-admission-key-with-32-bytes";

it.effect(
  "keeps anonymous admission bound to the Cloudflare source despite forged forwarding metadata",
  () =>
    deriveAnonymousSource({
      request: new Request("https://api.fidyapp.com/pat-pairings", {
        headers: {
          "cf-connecting-ip": "198.51.100.10",
          "x-forwarded-for": "198.51.100.11",
          "x-pat-source": "forged-source",
        },
      }),
      browserOrigin: "https://app.fidyapp.com",
      admissionKey,
    }).pipe(
      // Fixed HMAC-SHA256 vector independently produced by Node's crypto implementation.
      Effect.map((value) =>
        expect(value).toBe("2eea6d81082ac0ab24b3694acf738bdea4155622f325ba3fc904e6f00eca50d8")
      )
    )
);

it.effect("separates two trusted visitor sources without exposing either address", () =>
  Effect.gen(function* () {
    const source = yield* deriveAnonymousSource({
      request: new Request("https://api.fidyapp.com/pat-pairings", {
        headers: { "cf-connecting-ip": "198.51.100.11" },
      }),
      browserOrigin: "https://app.fidyapp.com",
      admissionKey,
    });
    expect(source).toBe("a582a80e248392163c9bc888a52d8ab0d66b5bd05cf48901908bdea1bf4c8bb3");
  })
);

it.effect("admits a fixed source only in the configured local development topology", () =>
  Effect.gen(function* () {
    const request = new Request("http://127.0.0.1:8787/pat-pairings");
    const local = yield* deriveAnonymousSource({
      request,
      browserOrigin: "http://127.0.0.1:5173",
      admissionKey,
    });
    expect(local).toBe("dcc0529af14ac6092d694ce4d9a09ff70c2081eeb3b0ae958c6c731c89f6ad0f");
    const production = yield* Effect.exit(
      deriveAnonymousSource({
        request,
        browserOrigin: "https://app.fidyapp.com",
        admissionKey,
      })
    );
    expect(production._tag).toBe("Failure");
  })
);

it.effect(
  "refuses missing source and short admission keys before forwarding any anonymous work",
  () =>
    Effect.gen(function* () {
      for (const headers of [
        new Headers({ "x-forwarded-for": "198.51.100.10", "x-pat-source": "forged-source" }),
        new Headers({ "cf-connecting-ip": "198.51.100.10" }),
      ]) {
        let forwarded = false;
        const response = yield* Effect.tryPromise(() =>
          publicWorker.fetch(
            new Request("https://api.fidyapp.com/pat-pairings", {
              method: "POST",
              headers,
            }),
            {
              BROWSER_ORIGIN: "https://app.fidyapp.com",
              LOCAL_CANONICAL_READ_BEARER: "",
              PAT_ADMISSION_KEY: headers.has("cf-connecting-ip") ? "too-short" : admissionKey,
              RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
              CORE: {
                fetch: () => {
                  forwarded = true;
                  return Promise.resolve(new Response());
                },
              },
            }
          )
        );
        expect(response.status).toBe(503);
        expect(forwarded).toBe(false);
      }
    })
);

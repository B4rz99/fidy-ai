import { makeOAuthClient } from "alchemy/Auth/OAuthFlow";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import { Effect } from "effect";
import { Base64Url } from "effect/encoding";
import { expect, it } from "@effect/vitest";

it.layer(PlatformServices)((test) =>
  test.effect(
    "Alchemy supplies separate randomness and digest services for PKCE without contacting the provider",
    () =>
      Effect.gen(function* () {
        const client = makeOAuthClient({
          clientId: "synthetic-client",
          endpoints: {
            authorize: "https://identity.example/authorize",
            token: "https://identity.example/token",
          },
          redirectUri: "https://client.example/callback",
          localCallbackUri: "http://localhost:12345/callback",
          auth: { kind: "pkce" },
        });
        const authorization = yield* client.authorize(["read"]);
        expect(authorization.verifier).toBeDefined();
        const url = new URL(authorization.url);
        const challenge = yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization.verifier))
        ).pipe(Effect.orDie);
        expect(url.searchParams.get("code_challenge")).toBe(
          Base64Url.encode(new Uint8Array(challenge))
        );
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("state")).toBe(authorization.state);
        expect(url.searchParams.get("scope")).toBe("read");
      })
  )
);

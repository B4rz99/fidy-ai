import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";
import type { Miniflare } from "miniflare";
import {
  type Credential,
  type CredentialStore,
  apiOrigin,
} from "../../apps/cli/src/credential/contract";
import { makePairingClient } from "../../apps/cli/src/direct-client/runtime";
import type { PublicProgress } from "../../apps/cli/src/login/contract";
import { runCommand } from "../../apps/cli/src/command/operations";
import { runOperationCommand } from "../../apps/cli/src/canonical/operations";
import { canonicalClientFactory } from "../../apps/cli/src/canonical/runtime";
import { alice, seed } from "../../apps/server/cloudflare/financial-user-store.test-fixture";
import { browserOrigins } from "../../apps/server/cloudflare/runtime/contract";
import { native, nativeUserPlatform } from "../../apps/server/cloudflare/user-store.test-fixture";

const transport = (runtime: Miniflare): HttpClient.HttpClient =>
  HttpClient.make((request, url) => {
    const body =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined;

    const headers = { ...request.headers, "cf-connecting-ip": "192.0.2.49" };

    return native(() =>
      runtime.dispatchFetch(url.href, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
      })
    ).pipe(
      Effect.flatMap((response) =>
        native(() => response.text()).pipe(
          Effect.map((text) =>
            HttpClientResponse.fromWeb(
              request,
              new Response(text, {
                status: response.status,
                headers: Object.fromEntries(response.headers),
              })
            )
          )
        )
      )
    );
  });

const browserApproval = Effect.fnUntraced(function* (runtime: Miniflare, event: PublicProgress) {
  if (event._tag !== "ApprovalRequired") return;

  const post = (
    path: string,
    payload: unknown
  ): Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>> =>
    native(() =>
      runtime.dispatchFetch(apiOrigin + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.49",
          origin: browserOrigins.production,
          cookie: "__Host-fidy_session=" + alice.bearer,
          "Fidy-Session-Binding": alice.session,
        },
        body: JSON.stringify(payload),
      })
    );

  const inspect = yield* post("/pats/pairings/inspect", { publicCode: event.publicCode });
  expect(inspect.status).toBe(200);

  const { data } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.Struct({ pairingId: Schema.String }) })
  )(yield* native(() => inspect.json())).pipe(Effect.orDie);

  const approved = yield* post("/pats/pairings/approve", data);
  expect(approved.status).toBe(200);
  yield* native(() => approved.text());
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("logs the CLI in against the native Worker and uses its saved read grant", () =>
    Effect.gen(function* () {
      const create = yield* nativeUserPlatform,
        runtime = yield* create();

      yield* seed(runtime, alice);

      const httpClient = transport(runtime),
        pairing = yield* makePairingClient(httpClient);

      const saved: Credential[] = [];

      const store: CredentialStore = {
        load: Effect.sync(() => Option.fromUndefinedOr(saved[0])),
        clear: Effect.void,
        save: (credential) =>
          Effect.sync(() => {
            saved.push(credential);
          }),
      };

      yield* runCommand(
        ["login", "--recipient", "Terminal", "--scopes", "read", "--lifetime", "7", "--no-browser"],
        {
          store,
          pairing,
          verifyStorage: Effect.void,
          readLine: () => Effect.die("Unexpected prompt"),
          emit: (event) =>
            event._tag === "ApprovalRequired" ? browserApproval(runtime, event) : Effect.void,
        }
      );
      const [credential] = saved;

      if (credential === undefined) return yield* Effect.die("Missing CLI credential");
      expect(credential.grant.pat.recipientLabel).toBe("Terminal");
      const output: string[] = [];

      const failed = yield* runOperationCommand(["categories", "listCategories"], {
        store,
        httpClient,
        clientFactory: canonicalClientFactory,
        readInput: () => Effect.die("Unexpected file read"),
        stdout: (text) =>
          Effect.sync(() => {
            output.push(text);
          }),
        stderr: () => Effect.void,
        json: true,
      });

      expect(failed).toBe(false);
      expect(output.join("")).toContain("Mercado");
      expect(output.join("")).not.toContain(Redacted.value(credential.bearer));
    })
  );
});

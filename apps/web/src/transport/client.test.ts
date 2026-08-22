// @vitest-environment node

import { DateTime, Effect, Layer, Option } from "effect";
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/unstable/http";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";
import { makeFidyClient } from "./client";

const responseJson = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  );

const makeHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
): HttpClient.HttpClient =>
  HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >((effect) => Effect.flatMap(effect, handler), Effect.succeed);

describe("canonical browser transport", () => {
  it("keeps the typed Atom client while substituting only HttpClient", async () => {
    const requests: string[] = [];
    const httpClient = makeHttpClient((request) => {
      requests.push(request.url);
      return Effect.succeed(
        responseJson(request, {
          data: { url: "https://upgrade.fidyapp.com" },
          next: [],
        })
      );
    });
    const client = makeFidyClient(
      "https://api.test.fidyapp.com",
      Layer.succeed(HttpClient.HttpClient, httpClient)
    );
    const atom = client.query("subscription", "getUpgradeUrl", {
      serializationKey: "upgrade",
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);

    try {
      const response = await Effect.runPromise(AtomRegistry.getResult(registry, atom));

      expect(response.data.url.href).toBe("https://upgrade.fidyapp.com/");
      expect(requests).toEqual(["https://api.test.fidyapp.com/subscription/upgrade-url"]);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("serializes exact half-open UTC Transaction bounds through the derived client", async () => {
    const requests: Array<
      Readonly<{
        url: string;
        from: Option.Option<string>;
        to: Option.Option<string>;
      }>
    > = [];
    const httpClient = makeHttpClient((request) => {
      requests.push({
        url: request.url,
        from: UrlParams.getFirst(request.urlParams, "from"),
        to: UrlParams.getFirst(request.urlParams, "to"),
      });
      return Effect.succeed(responseJson(request, { data: [], next: [] }));
    });
    const client = makeFidyClient(
      "https://api.test.fidyapp.com",
      Layer.succeed(HttpClient.HttpClient, httpClient)
    );
    const atom = client.query("transactions", "listTransactions", {
      query: {
        from: DateTime.makeUnsafe("2026-03-01T05:00:00Z"),
        to: DateTime.makeUnsafe("2026-04-01T04:00:00Z"),
      },
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);

    try {
      await Effect.runPromise(AtomRegistry.getResult(registry, atom));
      expect(requests).toEqual([
        {
          url: "https://api.test.fidyapp.com/transactions",
          from: Option.some("2026-03-01T05:00:00.000Z"),
          to: Option.some("2026-04-01T04:00:00.000Z"),
        },
      ]);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("notifies the authentication lifetime when the canonical API rejects the session", async () => {
    let expirations = 0;
    const httpClient = makeHttpClient((request) =>
      Effect.succeed(
        responseJson(
          request,
          {
            error: { code: "unauthenticated", message: "Authentication expired." },
            next: [],
          },
          401
        )
      )
    );
    const client = makeFidyClient(
      "https://api.test.fidyapp.com",
      Layer.succeed(HttpClient.HttpClient, httpClient),
      { onAuthenticationExpired: () => expirations++ }
    );
    const atom = client.query("identity", "getCurrentUser", {});
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);

    try {
      await Effect.runPromise(Effect.result(AtomRegistry.getResult(registry, atom)));
      expect(expirations).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

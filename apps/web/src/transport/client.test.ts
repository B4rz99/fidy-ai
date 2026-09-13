// @vitest-environment node

import assert from "node:assert/strict";
import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientRequest as HttpClientRequestType,
  HttpClientResponse,
  UrlParams,
} from "effect/unstable/http";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { type BrowserHttpBoundary, browserHttpClientLayer } from "./browser-http-policy";
import { presentCanonicalQuery } from "./canonical-query";
import {
  ManualPATRequestId,
  PATRecipientLabel,
  makeFidyClient,
  makeSubscriptionEnrollmentClient,
} from "./client";

const responseJson = (
  request: HttpClientRequestType.HttpClientRequest,
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
    request: HttpClientRequestType.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
): HttpClient.HttpClient =>
  HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >((effect) => Effect.flatMap(effect, handler), Effect.succeed);

const interruptibleWork = (
  onStarted: () => void,
  onInterrupted: () => void
): Effect.Effect<never> =>
  Effect.callback<never>(() => {
    onStarted();
    return Effect.sync(onInterrupted);
  });

const policyTestOrigin = "https://api.test.fidyapp.com";
const makePolicyTestClient = (
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  boundary: BrowserHttpBoundary = "canonical"
): Effect.Effect<HttpClient.HttpClient> =>
  Layer.build(httpClient.pipe(browserHttpClientLayer(boundary, policyTestOrigin))).pipe(
    Effect.map((context) => Context.get(context, HttpClient.HttpClient)),
    Effect.scoped
  );

const boundaryExitKind = (
  exit: Exit.Exit<unknown, unknown>
): "http-defect" | "interrupted" | "schema-defect" | "typed-failure" => {
  if (Exit.isSuccess(exit)) throw new Error("Expected a boundary failure");
  if (Cause.hasInterrupts(exit.cause)) return "interrupted";
  const defect = Cause.findDefect(exit.cause);
  if (Result.isFailure(defect)) return "typed-failure";
  if (HttpClientError.isHttpClientError(defect.success)) return "http-defect";
  if (Schema.isSchemaError(defect.success)) return "schema-defect";
  throw new Error("Expected an HTTP or Schema boundary defect");
};

const manualPATDisclosureBody = (bearer: string): unknown => ({
  data: {
    pat: {
      _tag: "PAT",
      id: "f1d1a000-0000-4000-8000-000000000248",
      shortId: "created1",
      recipientLabel: "Automatización casa",
      scopes: ["read", "dashboard"],
      lifetimeDays: 90,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: "2026-08-10T12:00:00Z",
      expiresAt: "2026-11-08T12:00:00Z",
      idleExpiresAt: "2026-11-08T12:00:00Z",
    },
    bearer,
  },
  next: [],
});

describe("subscription enrollment transport", () => {
  it("interrupts in-flight work and refuses access as soon as its runtime is disposed", async () => {
    const started = Deferred.makeUnsafe<void>();
    let interrupted = 0;
    const client = makeSubscriptionEnrollmentClient("https://api.test.fidyapp.com");
    const request = client.execute(() =>
      interruptibleWork(
        () => Effect.runSync(Deferred.succeed(started, undefined)),
        () => {
          interrupted += 1;
        }
      )
    );

    await Effect.runPromise(Deferred.await(started));
    const disposal = client.dispose();

    await expect(request).rejects.toBeDefined();
    await disposal;
    expect(interrupted).toBe(1);
    await expect(client.execute(() => Effect.succeed("stale"))).rejects.toBeDefined();
  });
});

describe("browser HTTP policy", () => {
  it.effect("terminates a request when its browser deadline expires", () =>
    Effect.gen(function* () {
      const neverClient = makeHttpClient(() => Effect.never);
      const client = yield* makePolicyTestClient(Layer.succeed(HttpClient.HttpClient, neverClient));
      const fiber = yield* Effect.forkChild(client.get("https://api.test.fidyapp.com/health"));

      yield* TestClock.adjust("15 seconds");
      const exit = yield* Fiber.await(fiber);

      assert.deepStrictEqual(
        exit,
        Exit.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: HttpClientRequest.make("GET")("https://browser-api.invalid"),
              description: "browser request deadline exceeded",
            }),
          })
        )
      );
    })
  );

  it.effect("refuses cross-origin destinations before sending a credentialed request", () =>
    Effect.gen(function* () {
      let executions = 0;
      const httpClient = makeHttpClient((request) => {
        executions++;
        return Effect.succeed(responseJson(request, { ok: true }));
      });
      const client = yield* makePolicyTestClient(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        "web-auth"
      );

      const exit = yield* client.get("https://attacker.example/collect").pipe(Effect.exit);

      expect(executions).toBe(0);
      assert.deepStrictEqual(
        exit,
        Exit.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: HttpClientRequest.make("GET")("https://browser-api.invalid"),
              description: "request destination origin refused",
            }),
          })
        )
      );
    })
  );

  it.effect("refuses invalid destinations before invoking the browser transport", () =>
    Effect.gen(function* () {
      let executions = 0;
      const httpClient = makeHttpClient((request) => {
        executions++;
        return Effect.succeed(responseJson(request, { ok: true }));
      });
      const client = yield* makePolicyTestClient(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        "web-auth"
      );

      const exit = yield* client.get("not a URL").pipe(Effect.exit);

      expect(executions).toBe(0);
      assert.deepStrictEqual(
        exit,
        Exit.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: HttpClientRequest.make("GET")("https://browser-api.invalid"),
              description: "request destination invalid",
            }),
          })
        )
      );
    })
  );

  it.effect("refuses redirect responses without following their destination", () =>
    Effect.gen(function* () {
      let executions = 0;
      const httpClient = makeHttpClient((request) => {
        executions++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              status: 302,
              headers: { location: "https://attacker.example/collect" },
            })
          )
        );
      });
      const client = yield* makePolicyTestClient(Layer.succeed(HttpClient.HttpClient, httpClient));

      const exit = yield* client.get("https://api.test.fidyapp.com/redirect").pipe(Effect.exit);

      expect(executions).toBe(1);
      const diagnosticRequest = HttpClientRequest.make("GET")("https://browser-api.invalid");
      assert.deepStrictEqual(
        exit,
        Exit.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({
              request: diagnosticRequest,
              response: HttpClientResponse.fromWeb(
                diagnosticRequest,
                new Response(null, { status: 302 })
              ),
              description: "redirect response refused",
            }),
          })
        )
      );
    })
  );

  it.effect("stops consuming a response after the boundary byte cap", () =>
    Effect.gen(function* () {
      const oversized = new Uint8Array(64 * 1024 + 1);
      const httpClient = makeHttpClient((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(oversized, { headers: { "content-type": "application/json" } })
          )
        )
      );
      const client = yield* makePolicyTestClient(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        "web-auth"
      );

      const exit = yield* client.get("https://api.test.fidyapp.com/large").pipe(Effect.exit);

      const diagnosticRequest = HttpClientRequest.make("GET")("https://browser-api.invalid");
      assert.deepStrictEqual(
        exit,
        Exit.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({
              request: diagnosticRequest,
              response: HttpClientResponse.fromWeb(
                diagnosticRequest,
                new Response(null, {
                  headers: { "content-type": "application/json" },
                })
              ),
            }),
          })
        )
      );
    })
  );

  it.effect("rejects a declared response length above the boundary byte cap", () =>
    Effect.gen(function* () {
      const httpClient = makeHttpClient((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("{}", {
              headers: {
                "content-length": String(64 * 1024 + 1),
                "content-type": "application/json",
              },
            })
          )
        )
      );
      const client = yield* makePolicyTestClient(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        "web-auth"
      );

      const exit = yield* client.get("https://api.test.fidyapp.com/large").pipe(Effect.exit);

      const diagnosticRequest = HttpClientRequest.make("GET")("https://browser-api.invalid");
      assert.deepStrictEqual(
        exit,
        Exit.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({
              request: diagnosticRequest,
              response: HttpClientResponse.fromWeb(
                diagnosticRequest,
                new Response(null, {
                  headers: { "content-type": "application/json" },
                })
              ),
            }),
          })
        )
      );
    })
  );

  it.effect("keeps credentials out of transport failure diagnostics", () =>
    Effect.gen(function* () {
      const secret = "secret-proof-value";
      const httpClient = makeHttpClient((request) => {
        const credentialed = request.pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${secret}`)
        );
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: credentialed,
              cause: new Error(secret),
              description: secret,
            }),
          })
        );
      });
      const client = yield* makePolicyTestClient(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        "enrollment"
      );

      const exit = yield* client.post("https://api.test.fidyapp.com/submit").pipe(Effect.exit);

      assert.deepStrictEqual(
        exit,
        Exit.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: HttpClientRequest.make("POST")("https://browser-api.invalid"),
            }),
          })
        )
      );
    })
  );

  it.effect("sanitizes request encoding failures from the underlying transport", () =>
    Effect.gen(function* () {
      const httpClient = makeHttpClient((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.EncodeError({
              request,
              cause: new Error("sensitive encoder detail"),
            }),
          })
        )
      );
      const client = yield* makePolicyTestClient(Layer.succeed(HttpClient.HttpClient, httpClient));

      const exit = yield* client.post("https://api.test.fidyapp.com/write").pipe(Effect.exit);

      assert.deepStrictEqual(
        exit,
        Exit.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.EncodeError({
              request: HttpClientRequest.make("POST")("https://browser-api.invalid"),
            }),
          })
        )
      );
    })
  );

  it.effect("retries one transport failure only for safe request methods", () =>
    Effect.gen(function* () {
      const executions: Array<string> = [];
      const httpClient = makeHttpClient((request) => {
        executions.push(request.method);
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          })
        );
      });
      const client = yield* makePolicyTestClient(Layer.succeed(HttpClient.HttpClient, httpClient));

      yield* client.get("https://api.test.fidyapp.com/read").pipe(Effect.exit);
      yield* client.head("https://api.test.fidyapp.com/read-metadata").pipe(Effect.exit);
      yield* client.post("https://api.test.fidyapp.com/write").pipe(Effect.exit);

      expect(executions).toEqual(["GET", "GET", "HEAD", "HEAD", "POST"]);
    })
  );

  it.effect("uses credentialed manual no-store Fetch requests at every browser boundary", () =>
    Effect.gen(function* () {
      const requestOptions: Array<RequestInit> = [];
      const fakeFetch: typeof globalThis.fetch = Object.assign(
        (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          requestOptions.push(init ?? {});
          return Promise.resolve(
            new Response("{}", { headers: { "content-type": "application/json" } })
          );
        },
        { preconnect: globalThis.fetch.preconnect }
      );

      for (const boundary of ["canonical", "web-auth", "enrollment"] as const) {
        const client = yield* makePolicyTestClient(FetchHttpClient.layer, boundary);
        yield* client
          .get("https://api.test.fidyapp.com/policy")
          .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      }

      expect(requestOptions).toHaveLength(3);
      for (const options of requestOptions) {
        expect(options).toMatchObject({
          credentials: "include",
          redirect: "manual",
          cache: "no-store",
        });
      }
    })
  );
});

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

  it("keeps malformed schemas and HTTP failures as distinguishable boundary defects", async () => {
    const malformedClient = makeFidyClient(
      "https://api.test.fidyapp.com",
      Layer.succeed(
        HttpClient.HttpClient,
        makeHttpClient((request) =>
          Effect.succeed(responseJson(request, { unexpected: "secret parser material" }))
        )
      )
    );
    const malformedAtom = malformedClient.query("subscription", "getUpgradeUrl", {});
    const malformedRegistry = AtomRegistry.make();
    const unmountMalformed = malformedRegistry.mount(malformedAtom);

    const transportClient = makeFidyClient(
      "https://api.test.fidyapp.com",
      Layer.succeed(
        HttpClient.HttpClient,
        makeHttpClient((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            })
          )
        )
      )
    );
    const transportAtom = transportClient.query("subscription", "getUpgradeUrl", {});
    const transportRegistry = AtomRegistry.make();
    const unmountTransport = transportRegistry.mount(transportAtom);

    try {
      const malformedExit = await Effect.runPromise(
        Effect.exit(AtomRegistry.getResult(malformedRegistry, malformedAtom))
      );
      const transportExit = await Effect.runPromise(
        Effect.exit(AtomRegistry.getResult(transportRegistry, transportAtom))
      );
      expect(Exit.isFailure(malformedExit)).toBe(true);
      expect(Exit.isFailure(transportExit)).toBe(true);
      if (Exit.isFailure(malformedExit) && Exit.isFailure(transportExit)) {
        expect(boundaryExitKind(malformedExit)).toBe("schema-defect");
        expect(boundaryExitKind(transportExit)).toBe("http-defect");
      }
    } finally {
      unmountMalformed();
      malformedRegistry.dispose();
      unmountTransport();
      transportRegistry.dispose();
    }
  });

  it("preserves endpoint-declared failures as typed product outcomes", async () => {
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
      Layer.succeed(HttpClient.HttpClient, httpClient)
    );
    const atom = client.query("identity", "getCurrentUser", {});
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);

    try {
      const exit = await Effect.runPromise(Effect.exit(AtomRegistry.getResult(registry, atom)));
      expect(boundaryExitKind(exit)).toBe("typed-failure");
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("decodes a one-time PAT disclosure into redacted shared client state", async () => {
    const rawBearer = "fin_created1_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const httpClient = makeHttpClient((request) =>
      Effect.succeed(responseJson(request, manualPATDisclosureBody(rawBearer)))
    );
    const client = makeFidyClient(
      "https://api.test.fidyapp.com",
      Layer.succeed(HttpClient.HttpClient, httpClient)
    );
    const mutation = client.mutation("pats", "createManualPAT", {});
    const registry = AtomRegistry.make();
    const unmount = registry.mount(mutation);

    try {
      registry.set(mutation, {
        payload: {
          requestId: ManualPATRequestId.make("0d3e1c52-8c92-4c94-9d2f-5c7d0aef2d61"),
          grant: {
            recipientLabel: PATRecipientLabel.make("Automatización casa"),
            scopes: ["read", "dashboard"],
            lifetimeDays: 90,
          },
        },
      });

      const response = await Effect.runPromise(AtomRegistry.getResult(registry, mutation));

      expect(response.data.pat.shortId).toBe("created1");
      expect(Redacted.value(response.data.bearer)).toBe(rawBearer);
      expect(Redacted.isRedacted(response.data.bearer)).toBe(true);
      expect(JSON.stringify(registry.get(mutation))).not.toContain(rawBearer);
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

  it("preserves query data through a real refresh failure and retries the same atom", async () => {
    const refreshResponse = Promise.withResolvers<HttpClientResponse.HttpClientResponse>();
    let requestCount = 0;
    let pendingRequest = Option.none<HttpClientRequest.HttpClientRequest>();
    const httpClient = makeHttpClient((request) => {
      requestCount += 1;
      if (requestCount === 1 || requestCount === 3) {
        return Effect.succeed(responseJson(request, { data: [], next: [] }));
      }
      pendingRequest = Option.some(request);
      return Effect.promise(() => refreshResponse.promise);
    });
    const client = makeFidyClient(
      "https://api.test.fidyapp.com",
      Layer.succeed(HttpClient.HttpClient, httpClient)
    );
    const atom = client.query("transactions", "listTransactions", { query: {} });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);

    try {
      await Effect.runPromise(AtomRegistry.getResult(registry, atom));
      expect(presentCanonicalQuery(registry.get(atom))).toMatchObject({
        _tag: "Ready",
        waiting: false,
      });

      registry.refresh(atom);
      await vi.waitFor(() => expect(requestCount).toBe(2));
      expect(presentCanonicalQuery(registry.get(atom))).toMatchObject({
        _tag: "Ready",
        waiting: true,
      });
      const failedRefresh = Effect.runPromise(
        Effect.result(AtomRegistry.getResult(registry, atom))
      );

      refreshResponse.resolve(
        responseJson(
          Option.getOrThrow(pendingRequest),
          {
            error: {
              code: "validation_failed",
              message: "The query was rejected.",
              fields: [],
            },
            next: [],
          },
          400
        )
      );
      await failedRefresh;
      await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
      expect(presentCanonicalQuery(registry.get(atom))).toMatchObject({
        _tag: "Ready",
        waiting: false,
        refreshFailure: { _tag: "Some", value: { _tag: "DeclaredFailure" } },
      });

      registry.refresh(atom);
      await vi.waitFor(() => expect(requestCount).toBe(3));
      await Effect.runPromise(AtomRegistry.getResult(registry, atom));
      expect(presentCanonicalQuery(registry.get(atom))).toMatchObject({
        _tag: "Ready",
        waiting: false,
      });
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("classifies a real initial declared failure without previous data", async () => {
    const httpClient = makeHttpClient((request) =>
      Effect.succeed(
        responseJson(
          request,
          {
            error: { code: "validation_failed", message: "The query was rejected.", fields: [] },
            next: [],
          },
          400
        )
      )
    );
    const client = makeFidyClient(
      "https://api.test.fidyapp.com",
      Layer.succeed(HttpClient.HttpClient, httpClient)
    );
    const atom = client.query("transactions", "listTransactions", { query: {} });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);

    try {
      await Effect.runPromise(Effect.result(AtomRegistry.getResult(registry, atom)));
      expect(presentCanonicalQuery(registry.get(atom))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "DeclaredFailure" },
      });
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it.each([
    ["defect", Effect.die("private decoder defect"), "BoundaryFailure"],
    ["interruption", Effect.interrupt, "Interrupted"],
  ] as const)(
    "classifies a real initial %s without exposing its Cause",
    async (_label, request, tag) => {
      const httpClient = makeHttpClient(() => request);
      const client = makeFidyClient(
        "https://api.test.fidyapp.com",
        Layer.succeed(HttpClient.HttpClient, httpClient)
      );
      const atom = client.query("transactions", "listTransactions", { query: {} });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(atom);

      try {
        await Effect.runPromise(Effect.result(AtomRegistry.getResult(registry, atom))).catch(
          () => undefined
        );
        await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
        expect(presentCanonicalQuery(registry.get(atom))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: tag },
        });
      } finally {
        unmount();
        registry.dispose();
      }
    }
  );

  it("starts the same canonical query without prior-principal success in a replacement registry", async () => {
    const httpClient = makeHttpClient((request) =>
      Effect.succeed(responseJson(request, { data: [], next: [] }))
    );
    const client = makeFidyClient(
      "https://api.test.fidyapp.com",
      Layer.succeed(HttpClient.HttpClient, httpClient)
    );
    const atom = client.query("transactions", "listTransactions", { query: {} });
    const priorRegistry = AtomRegistry.make();
    const priorUnmount = priorRegistry.mount(atom);
    await Effect.runPromise(AtomRegistry.getResult(priorRegistry, atom));
    expect(presentCanonicalQuery(priorRegistry.get(atom))._tag).toBe("Ready");
    priorUnmount();
    priorRegistry.dispose();

    const replacementRegistry = AtomRegistry.make();
    expect(presentCanonicalQuery(replacementRegistry.get(atom))).toMatchObject({
      _tag: "Initial",
    });
    replacementRegistry.dispose();
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

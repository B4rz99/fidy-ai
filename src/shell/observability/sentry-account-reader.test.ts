import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Redacted } from "effect";
import {
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  SentryAccountReadError,
  type SentryAccountReaderConfig,
  inspectSentryAccount,
} from "./sentry-account-reader";

const responseJson = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
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

const unauthorizedStatus = 401;
const forbiddenStatus = 403;
const rateLimitedStatus = 429;
const unavailableStatus = 500;
const unexpectedStatus = 418;

const statusClient = (status: number): HttpClient.HttpClient =>
  makeHttpClient((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("private", { status })))
  );

const assertReadFailure =
  (reason: SentryAccountReadError["reason"]) =>
  (exit: Exit.Exit<unknown, SentryAccountReadError>): Effect.Effect<void> =>
    Effect.sync(() =>
      assert.deepStrictEqual(exit, Exit.fail(SentryAccountReadError.make({ reason })))
    );

const readerConfig = (
  input: {
    readonly token: string;
    readonly organization: string;
    readonly production: string;
    readonly nonProduction: string;
  } = {
    token: "private-token",
    organization: "private-organization",
    production: "private-production",
    nonProduction: "private-non-production",
  }
): SentryAccountReaderConfig => ({
  authToken: Redacted.make(input.token),
  organizationSlug: Redacted.make(input.organization),
  productionProjectSlug: Redacted.make(input.production),
  nonProductionProjectSlug: Redacted.make(input.nonProduction),
});

it.effect("reads only the account facts needed by policy and returns no account locators", () =>
  Effect.gen(function* () {
    const organization = "organization-secret-sentinel";
    const production = "production-secret-sentinel";
    const nonProduction = "non-production-secret-sentinel";
    const token = "token-secret-sentinel";
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const bodyFor = (path: string): unknown => {
      if (path.endsWith(`/organizations/${organization}/`)) {
        return { dataRegion: { name: "us" } };
      }
      if (path.endsWith(`/organizations/${organization}/projects/`)) {
        return [{ slug: production }, { slug: nonProduction }];
      }
      if (path.endsWith(`/projects/${organization}/${production}/keys/`)) {
        return [{ isActive: true, rateLimit: null }];
      }
      if (path.endsWith(`/projects/${organization}/${production}/environments/`)) {
        return [{ name: "production" }];
      }
      if (path.endsWith(`/projects/${organization}/${nonProduction}/keys/`)) {
        return [{ isActive: true, rateLimit: { window: 86_400, count: 100 } }];
      }
      return [{ name: "local" }, { name: "ci" }];
    };
    const client = makeHttpClient((request) => {
      requests.push(request);
      return Effect.succeed(
        responseJson(request, bodyFor(new URL(request.url).pathname), {
          link: '<https://sentry.io/previous>; rel="previous"; results="false", <https://sentry.io/next>; rel="next"; results="false"',
        })
      );
    });

    const observation = yield* inspectSentryAccount(
      readerConfig({ token, organization, production, nonProduction })
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));

    expect(requests).toHaveLength(6);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.every((request) => request.headers.authorization === `Bearer ${token}`)).toBe(
      true
    );
    expect(observation._tag).toBe("available");
    expect(Object.keys(observation).sort()).toEqual([
      "_tag",
      "nonProduction",
      "production",
      "projectsAreDistinct",
      "storageRegion",
    ]);
    if (observation._tag !== "available") throw new Error("expected available observation");
    expect(observation.projectsAreDistinct).toBe(true);
    const observationValues: ReadonlyArray<unknown> = Object.values(observation);
    expect(observationValues).not.toContain(organization);
    expect(observationValues).not.toContain(production);
    expect(observationValues).not.toContain(nonProduction);
    expect(observationValues).not.toContain(token);
  })
);

it.effect("accepts an organization response with no data region", () =>
  Effect.gen(function* () {
    const organization = "private-organization";
    const client = makeHttpClient((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/organizations/${organization}/`)) {
        return Effect.succeed(responseJson(request, { dataRegion: null }));
      }
      if (path.endsWith(`/organizations/${organization}/projects/`)) {
        return Effect.succeed(
          responseJson(request, [
            { slug: "private-production" },
            { slug: "private-non-production" },
          ])
        );
      }
      if (path.endsWith("/keys/")) {
        return Effect.succeed(responseJson(request, [{ isActive: true, rateLimit: null }]));
      }
      return Effect.succeed(responseJson(request, [{ name: "production" }]));
    });

    const observation = yield* inspectSentryAccount(
      readerConfig({
        organization,
        production: "private-production",
        nonProduction: "private-non-production",
        token: "private-token",
      })
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));

    expect(observation._tag).toBe("available");
    if (observation._tag !== "available") throw new Error("expected available observation");
    expect(observation.storageRegion._tag).toBe("None");
  })
);

it.effect("derives the organization region from the current region link", () =>
  Effect.gen(function* () {
    const organization = "private-organization";
    const client = makeHttpClient((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/organizations/${organization}/`)) {
        return Effect.succeed(
          responseJson(request, { links: { regionUrl: "https://us.sentry.io" } })
        );
      }
      if (path.endsWith(`/organizations/${organization}/projects/`)) {
        return Effect.succeed(
          responseJson(request, [
            { slug: "private-production" },
            { slug: "private-non-production" },
          ])
        );
      }
      if (path.endsWith("/keys/")) {
        return Effect.succeed(responseJson(request, [{ isActive: true, rateLimit: null }]));
      }
      return Effect.succeed(responseJson(request, [{ name: "production" }]));
    });

    const observation = yield* inspectSentryAccount(
      readerConfig({
        organization,
        production: "private-production",
        nonProduction: "private-non-production",
        token: "private-token",
      })
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));

    expect(observation._tag).toBe("available");
    if (observation._tag !== "available") throw new Error("expected available observation");
    expect(Option.isSome(observation.storageRegion)).toBe(true);
    if (Option.isNone(observation.storageRegion)) throw new Error("expected a storage region");
    expect(observation.storageRegion.value).toBe("us");
  })
);

it.effect("marks identical project roles as not separated without exposing the slug", () =>
  Effect.gen(function* () {
    const organization = "private-organization";
    const sharedProject = "private-shared-project";
    const client = makeHttpClient((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/organizations/${organization}/`)) {
        return Effect.succeed(responseJson(request, { dataRegion: { name: "us" } }));
      }
      if (path.endsWith(`/organizations/${organization}/projects/`)) {
        return Effect.succeed(responseJson(request, [{ slug: sharedProject }]));
      }
      if (path.endsWith("/keys/")) {
        return Effect.succeed(responseJson(request, [{ isActive: true, rateLimit: null }]));
      }
      return Effect.succeed(responseJson(request, [{ name: "production" }]));
    });

    const observation = yield* inspectSentryAccount(
      readerConfig({
        token: "private-token",
        organization,
        production: sharedProject,
        nonProduction: sharedProject,
      })
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));

    expect(observation._tag).toBe("available");
    if (observation._tag !== "available") throw new Error("expected available observation");
    expect(observation.projectsAreDistinct).toBe(false);
    expect(Object.values(observation)).not.toContain(sharedProject);
  })
);

it.effect("rejects incomplete paginated account observations", () =>
  Effect.gen(function* () {
    const client = makeHttpClient((request) =>
      Effect.succeed(
        responseJson(request, [], {
          link: "<https://sentry.io/api/0/organizations/private/projects/?cursor=next>; rel=next",
        })
      )
    );

    const exit = yield* inspectSentryAccount(readerConfig()).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.exit
    );

    assert.deepStrictEqual(
      exit,
      Exit.fail(SentryAccountReadError.make({ reason: "unexpected-response" }))
    );
  })
);

it.effect("rejects oversized provider responses before decoding them", () =>
  Effect.gen(function* () {
    const client = makeHttpClient((request) =>
      Effect.succeed(responseJson(request, { padding: "x".repeat(70_000) }))
    );

    const exit = yield* inspectSentryAccount(readerConfig()).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.exit
    );

    assert.deepStrictEqual(
      exit,
      Exit.fail(SentryAccountReadError.make({ reason: "unexpected-response" }))
    );
  })
);

it.effect("classifies management API failures without retaining provider responses", () =>
  Effect.gen(function* () {
    const cases = [
      { status: forbiddenStatus, reason: "forbidden" },
      { status: rateLimitedStatus, reason: "rate-limited" },
      { status: unavailableStatus, reason: "unavailable" },
      { status: unexpectedStatus, reason: "unexpected-response" },
    ] as const;

    yield* Effect.forEach(
      cases,
      ({ reason, status }) =>
        inspectSentryAccount(
          readerConfig({
            token: "private-token",
            organization: "private-organization",
            production: "private-production",
            nonProduction: "private-non-production",
          })
        ).pipe(
          Effect.provideService(HttpClient.HttpClient, statusClient(status)),
          Effect.exit,
          Effect.tap(assertReadFailure(reason))
        ),
      { discard: true }
    );
  })
);

it.effect("bounds malformed authenticated success responses and stops inspection", () =>
  Effect.gen(function* () {
    const providerSentinel = "private-provider-payload-sentinel";
    const organization = "private-organization-sentinel";
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = makeHttpClient((request) => {
      requests.push(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(`{"private":"${providerSentinel}"`, {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )
      );
    });

    const exit = yield* inspectSentryAccount(
      readerConfig({
        token: "private-token-sentinel",
        organization,
        production: "private-production-sentinel",
        nonProduction: "private-non-production-sentinel",
      })
    ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.exit);

    expect(requests).toHaveLength(1);
    assert.deepStrictEqual(
      exit,
      Exit.fail(SentryAccountReadError.make({ reason: "unexpected-response" }))
    );
    expect(String(exit)).not.toContain(providerSentinel);
    expect(String(exit)).not.toContain(organization);
  })
);

it.effect("returns a bounded failure instead of an authenticated provider response", () =>
  Effect.gen(function* () {
    const client = makeHttpClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("private-provider-body-sentinel", { status: unauthorizedStatus })
        )
      )
    );

    const exit = yield* inspectSentryAccount(
      readerConfig({
        token: "private-token-sentinel",
        organization: "private-organization-sentinel",
        production: "private-production-sentinel",
        nonProduction: "private-non-production-sentinel",
      })
    ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.exit);

    assert.deepStrictEqual(
      exit,
      Exit.fail(SentryAccountReadError.make({ reason: "unauthorized" }))
    );
  })
);

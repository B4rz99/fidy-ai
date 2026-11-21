import { installedOrigins } from "@fidy/server/browser-transport";
import { Config, Effect, Schema } from "effect";
import { FetchHttpClient, type HttpClient, HttpClientRequest } from "effect/http";

const ok = 200;

const bundle = new URL("../../apps/web/dist/", import.meta.url);

const assetPath = /^assets\/[\w.-]+\.(?:js|css)$/u;

const requestedFiles = (html: string): ReadonlyArray<string> => {
  const files = [
    ...new Set(
      [...html.matchAll(/(?:src|href)="\/(assets\/[\w.-]+\.(?:js|css))"/gu)].map(
        (match) => match[1] ?? ""
      )
    ),
  ];

  if (files.length === 0 || !files.every((path) => assetPath.test(path))) {
    throw Error("No verified browser bootstrap in build");
  }

  return files;
};

const canonicalConnectSources = [
  installedOrigins.production.api,
  "https://sandbox.wompi.co",
  "https://production.wompi.co",
  "https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox",
].join(" ");

export const installedHeaders = ({
  headers,
  origins,
}: {
  headers: Readonly<Record<string, string>>;
  origins: (typeof installedOrigins)[keyof typeof installedOrigins];
}): boolean => {
  const directives = (headers["content-security-policy"] ?? "")
    .split(";")
    .map((item) => item.trim());

  const expectedConnect =
    origins.api === installedOrigins.production.api ? canonicalConnectSources : origins.api;

  return (
    directives.filter((item) => item.startsWith("connect-src ")).join("") ===
      "connect-src " + expectedConnect &&
    directives.includes("default-src 'none'") &&
    directives.includes("frame-ancestors 'none'") &&
    headers.link === "<" + origins.api + ">; rel=preconnect; crossorigin=use-credentials" &&
    headers["x-content-type-options"] === "nosniff"
  );
};

export const verifyInstalledWebsite = Effect.fn(function* (
  client: HttpClient.HttpClient,
  revision: string,
  selected: (typeof installedOrigins)[keyof typeof installedOrigins] &
    (Readonly<Record<never, never>> | { contractDigest: string }) = installedOrigins.acceptance
) {
  const origins = selected;
  const operation = yield* Config.String("FIXTURE_RELEASE_OPERATION").pipe(Config.withDefault(""));

  const verified =
    "contractDigest" in selected
      ? selected.contractDigest
      : yield* Config.String(
          operation === "rollout-fixture-successor"
            ? "FIXTURE_WEB_CONTRACT_DIGEST"
            : "CONTRACT_DIGEST"
        );

  const local = (path: string): Effect.Effect<string, Error> =>
    Effect.tryPromise(() => Bun.file(new URL(path, bundle)).text());

  const compare = Effect.fn(function* (path: string, localPath: string) {
    const expected = yield* local(localPath);

    const response = yield* client
      .execute(HttpClientRequest.get(origins.browser + "/" + path))
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }));

    const text = yield* response.text;

    if (response.status !== ok || expected !== text) {
      return yield* Effect.fail(
        Error("Installed browser asset differs from protected build: " + localPath)
      );
    }

    return { headers: response.headers, expected };
  });

  const root = yield* compare("", "index.html");

  if (!installedHeaders({ headers: root.headers, origins })) {
    return yield* Effect.fail(
      Error("Installed frontend lacks host-specific CSP or API preconnect")
    );
  }

  const metadata = yield* compare("deployment-metadata.json", "deployment-metadata.json");
  yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        gitRevision: Schema.Literal(revision),
        contractDigest: Schema.Literal(verified),
      })
    )
  )(metadata.expected);
  const files = yield* Effect.try(() => requestedFiles(root.expected));
  yield* Effect.forEach(files, (path) => compare(path, path), { concurrency: 3, discard: true });

  return {
    browser: origins.browser,
    api: origins.api,
    entryAssets: files,
    contractDigest: verified,
    revision,
  };
});

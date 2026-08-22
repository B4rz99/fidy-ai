#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { makeBrowserLoginPairingAcceptanceServer } from "~/shell/testing/api-harness";
import { makeBrowserLoginPairingAcceptanceControlServer } from "~/shell/testing/browser-pairing-acceptance-control";

const privateKeyPath = "/tmp/fidy-browser-pairing-acceptance-key.pem";
const certificatePath = "/tmp/fidy-browser-pairing-acceptance-cert.pem";

const createCertificate = (): void => {
  const generated = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    privateKeyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  if (generated.exitCode !== 0) {
    throw new Error(
      `Could not create the browser-pairing acceptance certificate: ${new TextDecoder().decode(generated.stderr)}`
    );
  }
};

type HeaderMutation =
  | Readonly<{ _tag: "Remove"; name: string }>
  | Readonly<{ _tag: "Set"; name: string; value: string }>;
type HeaderRule = Readonly<{
  pattern: string;
  mutations: ReadonlyArray<HeaderMutation>;
}>;

const parseHeaderRules = (source: string): ReadonlyArray<HeaderRule> => {
  const rules: Array<{ pattern: string; mutations: Array<HeaderMutation> }> = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      rules.push({ pattern: trimmed, mutations: [] });
      continue;
    }
    const rule = rules.at(-1);
    if (rule === undefined) throw new Error("Cloudflare header mutation has no path rule");
    if (trimmed.startsWith("! ")) {
      rule.mutations.push({ _tag: "Remove", name: trimmed.slice(2) });
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator < 1) throw new Error(`Invalid Cloudflare header mutation: ${trimmed}`);
    rule.mutations.push({
      _tag: "Set",
      name: trimmed.slice(0, separator),
      value: trimmed.slice(separator + 1).trim(),
    });
  }
  return rules;
};

const matchesHeaderRule = (pattern: string, pathname: string): boolean => {
  const expression = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${expression}$`, "u").test(pathname);
};

const headersFor = (rules: ReadonlyArray<HeaderRule>, pathname: string): Headers => {
  const headers = new Headers();
  for (const rule of rules) {
    if (!matchesHeaderRule(rule.pattern, pathname)) continue;
    for (const mutation of rule.mutations) {
      if (mutation._tag === "Remove") {
        headers.delete(mutation.name);
      } else {
        headers.append(mutation.name, mutation.value);
      }
    }
  }
  const contentSecurityPolicy = headers.get("content-security-policy");
  if (contentSecurityPolicy !== null) {
    headers.set(
      "content-security-policy",
      contentSecurityPolicy.replace(
        "connect-src https://api.fidyapp.com",
        "connect-src https://127.0.0.1:4174"
      )
    );
  }
  return headers;
};

const privateKey = Bun.file(privateKeyPath);
const certificate = Bun.file(certificatePath);
const webDirectory = new URL("../../web/playwright-dist/", import.meta.url);
const indexFile = Bun.file(new URL("index.html", webDirectory));
const assetNamePattern = /^\/assets\/[A-Za-z0-9._-]+$/u;

const makeWebHandler = Effect.gen(function* () {
  const rules = parseHeaderRules(
    yield* Effect.promise(() => Bun.file(new URL("_headers", webDirectory)).text())
  );
  const assets = new Set(
    yield* Effect.promise(() =>
      Array.fromAsync(new Bun.Glob("assets/*").scan({ cwd: Bun.fileURLToPath(webDirectory) }))
    )
  );
  return (request: Request): Response => {
    const { pathname } = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405 });
    }
    if (assetNamePattern.test(pathname)) {
      if (!assets.has(pathname.slice(1))) return new Response(null, { status: 404 });
      const asset = Bun.file(new URL(pathname.slice(1), webDirectory));
      return new Response(request.method === "HEAD" ? null : asset, {
        headers: headersFor(rules, pathname),
      });
    }
    return new Response(request.method === "HEAD" ? null : indexFile, {
      headers: headersFor(rules, pathname),
    });
  };
});

const run = Effect.gen(function* () {
  yield* Effect.sync(createCertificate);
  const webHandler = yield* makeWebHandler;
  const webServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 4173,
    tls: { cert: certificate, key: privateKey },
    fetch: webHandler,
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => webServer.stop(true)));
  yield* Effect.all(
    [
      Layer.launch(makeBrowserLoginPairingAcceptanceServer({ certificate, privateKey })),
      Layer.launch(makeBrowserLoginPairingAcceptanceControlServer({ certificate, privateKey })),
    ],
    { concurrency: "unbounded", discard: true }
  );
});

BunRuntime.runMain(Effect.scoped(run));

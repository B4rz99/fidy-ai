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

const privateKey = Bun.file(privateKeyPath);
const certificate = Bun.file(certificatePath);
const indexFile = Bun.file(new URL("../../web/playwright-dist/index.html", import.meta.url));
const assetNamePattern = /^\/assets\/[A-Za-z0-9._-]+$/u;

const responseForWebRequest = (request: Request): Response => {
  const { pathname } = new URL(request.url);
  if (assetNamePattern.test(pathname)) {
    return new Response(Bun.file(new URL(`../../web/playwright-dist${pathname}`, import.meta.url)));
  }
  return new Response(indexFile, { headers: { "content-type": "text/html; charset=utf-8" } });
};

const run = Effect.gen(function* () {
  yield* Effect.sync(createCertificate);
  const webServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 4173,
    tls: { cert: certificate, key: privateKey },
    fetch: responseForWebRequest,
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
let fixture = "";
before(async () => {
  fixture = await mkdtemp(join(tmpdir(), "fidy-inspector-transport-"));
  const certificate = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(fixture, "key.pem"),
      "-out",
      join(fixture, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" }
  );
  assert.equal(certificate.status, 0, "openssl must create the disposable loopback certificate");
});
after(async () => rm(fixture, { recursive: true, force: true }));
await Promise.all(
  ["cancel", "concurrent"].map((mode) =>
    test(`Inspector HTTP/2 ${mode} settles with the isolated dispatcher`, () => {
      const baseline = process.env.FIDY_INSPECTOR_BASELINE === "1";
      const result = spawnSync(
        process.execPath,
        [
          ...(baseline ? [] : ["--import", "./fetch-dispatcher.mjs"]),
          "./transport-fixture.mjs",
          fixture,
          mode,
        ],
        {
          cwd: directory,
          timeout: 10_000,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            NODE_EXTRA_CA_CERTS: join(fixture, "cert.pem"),
            NODE_OPTIONS: "",
          },
        }
      );
      assert.equal(
        result.error,
        undefined,
        "owned transport child must settle before its deadline"
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        passed: true,
        http2: true,
        cancellationReceived: true,
        concurrent: mode === "concurrent",
      });
    })
  )
);

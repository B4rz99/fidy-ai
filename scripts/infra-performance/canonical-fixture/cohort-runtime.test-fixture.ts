import { Database } from "bun:sqlite";
import { Effect, Option, Redacted } from "effect";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import { establishSmokeUsers } from "../../../infra/cloudflare/native-acceptance";
import { transport } from "./bridge";
import { closedRuntime } from "./closed-runtime.test-fixture";
import { serveCohort } from "./cohort-bridge";

const revision = process.env.FIDY_NATIVE_REVISION ?? "";
const secret = process.env.SMOKE_PROOF ?? "";
const directory = process.env.FIDY_REHEARSAL_STATE;
if (!directory) throw Error("Missing disposable cohort state");
const runtime = await Effect.runPromise(closedRuntime({ revision, secret }, directory));
const send = transport(runtime);
const readObject = async (id: string): Promise<readonly [string, boolean]> => {
  if (!/^[0-9a-f]{64}$/u.test(id)) throw Error("Unknown physical object");
  const files = await Array.fromAsync(
    new Bun.Glob("**/" + id + ".sqlite").scan({ cwd: directory, absolute: true })
  );
  if (files.length !== 1 || files[0] === undefined) throw Error("Physical inventory unavailable");
  const db = new Database(files[0], { readonly: true });
  try {
    return [
      id,
      db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='users'").get() !== null,
    ] as const;
  } finally {
    db.close();
  }
};
const local = async (action: string): Promise<unknown> => {
  if (action === "seed-survivors") {
    await Effect.runPromise(
      establishSmokeUsers({
        revision,
        proof: Redacted.make(secret),
        origins: installedOrigins.acceptance,
        send,
        erasure: Option.none(),
      })
    );
    return true;
  }
  if (action === "census") {
    return Object.fromEntries(
      await Promise.all((await runtime.listDurableObjectIds("UserStore", "core")).map(readObject))
    );
  }
  if (action === "marker") {
    const bucket = await runtime.getR2Bucket("SMOKE_BUCKET", "core");
    const value = await bucket.get(
      "_release-smoke/" + revision + "/acceptance/transactions/performance-1"
    );
    return value === null ? null : value.text();
  }
  if (action === "tick") {
    const core = await runtime.getWorker("core");
    return (
      (await core.scheduled({ cron: "* * * * *", scheduledTime: new Date() })).outcome === "ok"
    );
  }
  throw Error("Unrecognized local operation");
};
try {
  await serveCohort({ revision, secret }, () => send, local);
} finally {
  await runtime.dispose();
}

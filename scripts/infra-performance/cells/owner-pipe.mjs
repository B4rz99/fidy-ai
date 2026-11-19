// Private runner pipe for the native D1 control-plane rehearsal. Only the bounded Ingress has a socket.
import { createInterface } from "node:readline";
import { Schema } from "effect";

const command = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ action: Schema.Literal("query"), batch: Schema.Array(Schema.Struct({ sql: Schema.String, params: Schema.Array(Schema.Json) })) }),
    Schema.Struct({ action: Schema.Literals(["put-marker", "get-marker", "close"]) }),
  ])
);
/**
 * @param {import("miniflare").Miniflare} runtime Disposable frozen application.
 * @param {string} key Expiring private Ingress key.
 * @param {string} version Local version binding.
 */
export const serveOwnerPipe = async (runtime, key, version) => {
  const db = await runtime.getD1Database("DB", "core");
  const bucket = await runtime.getR2Bucket("ERASURE_BUCKET", "core");
  const endpoint = await runtime.ready;
  if (endpoint.hostname !== "127.0.0.1") throw new Error("Expected runner loopback");
  process.stdout.write(JSON.stringify({ port: endpoint.port, key, version }) + "\n");
  for await (const line of createInterface({ input: process.stdin })) {
    const item = command(JSON.parse(line));
    if (item.action === "close") break;
    if (item.action === "query") {
      const result = await db.batch(item.batch.map(({ sql, params }) => db.prepare(sql).bind(...params)));
      process.stdout.write(JSON.stringify(result) + "\n");
    } else {
      if (item.action === "put-marker") await bucket.put("recovery/generation", "initial");
      const marker = await bucket.get("recovery/generation");
      process.stdout.write(JSON.stringify(await marker?.text()) + "\n");
    }
  }
};

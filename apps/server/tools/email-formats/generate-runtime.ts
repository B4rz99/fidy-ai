import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { generateNotificationEmailCatalog } from "../../src/shell/ingestion/runtime";

await Effect.runPromise(
  generateNotificationEmailCatalog(process.argv.includes("--check")).pipe(
    Effect.provide(BunServices.layer)
  )
);

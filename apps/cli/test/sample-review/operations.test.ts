import { expect, layer } from "@effect/vitest";
import { processFree } from "../support/processes";
import { Effect, Redacted } from "effect";
import { runSampleReview } from "../../src/sample-review/operations";

layer(processFree)((it) => {
  it.effect("shows only the reviewed structural artifact before sending the human decision", () =>
    Effect.gen(function* () {
      const userId = "10000000-0000-4000-8000-000000000091";
      const candidateId = "10000000-0000-4000-8000-000000000092";
      const sampleId = "10000000-0000-4000-8000-000000000093";
      const digest = "d".repeat(64);

      const artifact = {
        serviceMarket: "CO",
        sourceFormat: "notification-email",
        sourceProvider: "cloudflare-email",
        parserRevision: "cloudflare-mime-v1",
        anonymizationRevision: "structural-tags-v1",
        structure: { table: 1, tr: 1, td: 2, p: 0, span: 0, div: 0 },
      } as const;

      const prompts = [userId, "APROBAR"];
      const output: string[] = [];
      const calls: unknown[] = [];
      yield* runSampleReview(["sample-review", "review"], {
        interactive: true,
        authenticate: Effect.succeed(Redacted.make("private.assertion.fixture")),
        read: () => Effect.succeed(prompts.shift() ?? ""),
        write: (text) =>
          Effect.sync(() => {
            output.push(text);
          }),
        submit: (command) =>
          Effect.sync(() => {
            calls.push(command);

            if (command.action === "preview") {
              return { status: "preview", candidateId, revision: 2, digest, artifact } as const;
            }

            expect(output.join("")).toContain('"td": 2');

            return { status: "published", sampleId } as const;
          }),
      });
      expect(calls).toEqual([
        { action: "preview", userId },
        { action: "approve", userId, candidateId, revision: 2, digest },
      ]);
      expect(output.join("")).not.toContain("private.assertion.fixture");
    })
  );
});

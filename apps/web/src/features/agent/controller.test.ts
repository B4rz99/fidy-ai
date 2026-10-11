import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it } from "vitest";
import { makeHostedTurnClient } from "@/transport/client";
import { type ConversationController, makeConversationController } from "./controller";
import type { ConversationView } from "./model";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
const turnId = "10000000-0000-4000-8000-000000000097";
const reply = { text: "Private reply", turnId, receipt: "a".repeat(64) };
const proposal = (): Response => Response.json(reply, { status: 202 });
const setup = (
  respond: (path: string) => Response
): Readonly<{
  controller: ConversationController;
  views: ConversationView[];
  paths: string[];
}> => {
  const paths: string[] = [];
  const views: ConversationView[] = [];
  const client = makeHostedTurnClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        return Effect.succeed(HttpClientResponse.fromWeb(request, respond(path)));
      })
    ),
  });
  const registry = AtomRegistry.make();
  const controller = makeConversationController({ client, changed: (view) => views.push(view) });
  disposers.push(() => {
    controller.dispose();
    registry.dispose();
  });
  return {
    controller: {
      ...controller,
      run: (action) =>
        Effect.scoped(
          Layer.build(registry.get(client.runtime.layer)).pipe(
            Effect.flatMap((context) => controller.run(action).pipe(Effect.provideContext(context)))
          )
        ),
    },
    views,
    paths,
  };
};

it("ignores inappropriate progress and acknowledgement actions and validates drafts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { controller, views, paths } = setup(proposal);
      yield* controller.run("Visible");
      yield* controller.run("Retry");
      yield* controller.run("Progress");
      yield* controller.run("Submit");
      expect(paths).toEqual([]);
      expect(views.at(-1)?.status).toContain("No se pudo");
      controller.dispose();
      controller.edit("after disposal");
      const count = views.length;
      yield* controller.run("Submit");
      expect(views).toHaveLength(count);
    })
  ));

it("removes failed proposals from history and preserves a draft for retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { controller, views } = setup(() => new Response(null, { status: 503 }));
      controller.edit("private draft");
      yield* controller.run("Submit");
      expect(views.at(-1)?.history).toEqual([]);
      expect(views.at(-1)?.hasDraft).toBe(true);
      expect(views.at(-1)?.canSubmit).toBe(true);
    })
  ));

it("preserves exact mounted drafts after quota rejection and retries without duplicate history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let available = false;
      const { controller, views, paths } = setup(() =>
        available
          ? proposal()
          : Response.json({ status: "provider_quota_exceeded" }, { status: 429 })
      );
      const draft = "  Revisa mis transacciones\nantes de cambiar nada  ";
      controller.edit(draft);
      const input = document.createElement("textarea");
      const release = controller.mountInput(input);
      yield* controller.run("Submit");
      expect(input.value).toBe(draft);
      expect(views.at(-1)?.status).toContain("límite diario");
      expect(views.at(-1)?.history).toEqual([]);
      expect(views.at(-1)?.canSubmit).toBe(true);
      available = true;
      yield* controller.run("Submit");
      expect(input.value).toBe("");
      expect(views.at(-1)?.history).toHaveLength(1);
      expect(paths).toHaveLength(2);
      release();
    })
  ));

it("recovers uncertain progress and retries delivery without resubmitting a turn", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let progressReads = 0;
      let acknowledgements = 0;
      const { controller, views, paths } = setup((path) => {
        if (path.endsWith("/progress")) {
          return ++progressReads === 1 ? new Response(null, { status: 503 }) : proposal();
        }
        if (path.endsWith("/delivery")) {
          return ++acknowledgements === 1
            ? new Response(null, { status: 503 })
            : Response.json({ status: "completed" });
        }
        return Response.json({ status: "processing", turnId }, { status: 202 });
      });
      controller.edit("private draft");
      yield* controller.run("Submit");
      expect(views.at(-1)?.canCheckProgress).toBe(true);
      yield* controller.run("Submit");
      yield* controller.run("Progress");
      expect(views.at(-1)?.status).toContain("Una operación podría");
      yield* controller.run("Progress");
      expect(views.at(-1)?.reply).toEqual(
        Option.some({ text: reply.text, awaitingVisibility: true })
      );
      yield* controller.run("Visible");
      expect(views.at(-1)?.canRetryDelivery).toBe(true);
      yield* controller.run("Retry");
      expect(views.at(-1)?.canSubmit).toBe(true);
      expect(paths.filter((path) => path === "/web/hosted-turns")).toHaveLength(1);
    })
  ));

it("appends the delivered assistant reply before the next user turn and clears mounted drafts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { controller, views } = setup((path) =>
        path.endsWith("/delivery") ? Response.json({ status: "completed" }) : proposal()
      );
      controller.edit("First");
      const input = document.createElement("textarea");
      const release = controller.mountInput(input);
      expect(input.value).toBe("First");
      yield* controller.run("Submit");
      expect(input.value).toBe("");
      yield* controller.run("Visible");
      controller.edit("Second");
      yield* controller.run("Submit");
      expect(views.at(-1)?.history.map((entry) => entry.from)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
      release();
      expect(input.value).toBe("");
      for (const view of views) expect(view.reply).not.toHaveProperty("value.receipt");
    })
  ));

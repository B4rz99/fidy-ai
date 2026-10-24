import type { Locator, Page } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { signInDashboardThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const resizeDistance = 100;
const pointerSteps = 12;
const successStatus = 200;
const noContentStatus = 204;

const moveBoundary = Effect.fnUntraced(function* (page: Page, boundary: Locator) {
  yield* Effect.tryPromise(() => boundary.scrollIntoViewIfNeeded());
  const bounds = yield* Effect.tryPromise(() => boundary.boundingBox());
  if (bounds === null) throw new Error("Missing visible resize boundary");
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  yield* Effect.tryPromise(() => page.mouse.move(start.x, start.y));
  yield* Effect.tryPromise(() => page.mouse.down());
  yield* Effect.tryPromise(() =>
    page.mouse.move(start.x + resizeDistance, start.y, { steps: pointerSteps })
  );
});

test("a pointer resize submits the canonical edit and retains its weight after reread and reload", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reset = yield* Effect.tryPromise(() =>
        request.post("http://127.0.0.1:4175/dashboard/reset?dashboard=true")
      );
      expect(reset.status()).toBe(noContentStatus);
      yield* Effect.tryPromise(() => signInDashboardThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.clock.resume());
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Personalizar" }).click());
      const boundary = page
        .getByRole("separator", { name: /^Redimensionar límite después de /u })
        .first();
      yield* Effect.tryPromise(() =>
        expect(boundary).toHaveAttribute("aria-orientation", "vertical")
      );
      yield* Effect.tryPromise(() => expect(boundary).toHaveAttribute("aria-valuenow", "1"));
      const edits: unknown[] = [];
      page.on("request", (call) => {
        if (call.url().endsWith("/dashboard/edits")) edits.push(call.postDataJSON());
      });
      yield* moveBoundary(page, boundary);
      expect(edits).toEqual([]);
      const saved = page.waitForResponse(
        (reply) => reply.url().endsWith("/dashboard/edits") && reply.status() === successStatus
      );
      const reread = page.waitForResponse(
        (reply) => reply.url().endsWith("/dashboard/view") && reply.status() === successStatus
      );
      yield* Effect.tryPromise(() => page.mouse.up());
      yield* Effect.tryPromise(() => saved);
      yield* Effect.tryPromise(() => reread);
      yield* Effect.tryPromise(() => expect(boundary).toHaveAttribute("aria-disabled", "false"));
      yield* Effect.tryPromise(() => expect(boundary).not.toHaveAttribute("aria-valuenow", "1"));
      const weight = yield* Effect.tryPromise(() => boundary.getAttribute("aria-valuenow"));
      if (weight === null) throw new Error("Missing persisted resize weight");
      expect(edits).toEqual([
        expect.objectContaining({
          op: "resize-region",
          size: { kind: "weight", weight: Number(weight) },
        }),
      ]);
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Personalizar" }).click());
      yield* Effect.tryPromise(() => expect(boundary).toHaveAttribute("aria-valuenow", weight));
    })
  ));

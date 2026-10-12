import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { signInAccessThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const pageSize = 25;
const connectionIds = (elements: Element[]): string[] =>
  elements
    .map((element) => element.getAttribute("data-connection-id"))
    .filter((id) => typeof id === "string");

test("real Core/D1 MCP continuation stays within Accesos without duplicate connections", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInAccessThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.goto("/settings/access"));
      const rows = page.locator("tr[data-connection-id]");
      yield* Effect.tryPromise(() => expect(rows).toHaveCount(pageSize));
      const firstIds = yield* Effect.tryPromise(() => rows.evaluateAll(connectionIds));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Siguiente página" }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/settings\/access\?after=/u));
      yield* Effect.tryPromise(() => expect(rows).toHaveCount(1));
      const lastId = yield* Effect.tryPromise(() =>
        rows.first().getAttribute("data-connection-id")
      );
      expect(firstIds).not.toContain(lastId);
      expect(new Set([...firstIds, lastId]).size).toBe(pageSize + 1);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Siguiente página" })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.getByRole("link", { name: "Primera página" }).click());
      yield* Effect.tryPromise(() => expect(rows).toHaveCount(pageSize));
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/settings\/access$/u));
    })
  ));

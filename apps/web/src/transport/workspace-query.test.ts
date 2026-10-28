import { Effect } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { revalidateWorkspaceQuery } from "./workspace-query";

it.live("reuses recent display reads but respects explicit refresh and expiry", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const registry = AtomRegistry.make();
  const cleanup: Array<() => void> = [];
  return Effect.gen(function* () {
    let reads = 0;
    const source = Atom.make(Effect.sync(() => ++reads)).pipe(Atom.setIdleTTL("1 minute"));
    const mount = (): ReturnType<typeof revalidateWorkspaceQuery<number, never>> => {
      const query = revalidateWorkspaceQuery(source);
      cleanup.push(registry.mount(query));
      return query;
    };
    expect(yield* AtomRegistry.getResult(registry, mount())).toBe(1);
    now.mockReturnValue(3000);
    const recent = mount();
    expect(yield* AtomRegistry.getResult(registry, recent)).toBe(1);
    yield* Effect.sleep("20 millis");
    expect(reads).toBe(1);
    registry.refresh(recent);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(2)));
    now.mockReturnValue(9000);
    mount();
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(3)));
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        for (const unmount of cleanup) unmount();
        registry.dispose();
        now.mockRestore();
      })
    )
  );
});

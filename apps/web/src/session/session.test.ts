// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { act, createElement, useContext } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { makeFreshQuery, readFreshQuery } from "@/transport/fresh-query";
import { SessionRegistryProvider } from "./session";
import { type SessionContextValue, useSession } from "./session-context";

type Owner = Readonly<{ registry: AtomRegistry.AtomRegistry; session: SessionContextValue }>;
const SessionProbe = ({
  attach,
}: Readonly<{ attach: (owner: Owner) => void }>): React.JSX.Element => {
  const registry = useContext(RegistryContext);
  const session = useSession();
  return createElement("span", { ref: () => attach({ registry, session }) });
};

const reactWork = (work: () => void | Promise<void>): Promise<void> => Promise.resolve(act(work));

it.each([false, true])(
  "authentication replacement refuses old-registry recovery before delayed disposal (pending: %s)",
  (pending) =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        const root = createRoot(window.document.createElement("div"));
        let owner = Option.none<Owner>();
        const registries = new Set<AtomRegistry.AtomRegistry>();
        const held = Deferred.makeUnsafe<void>();
        let reads = 0;
        const query = makeFreshQuery({
          runtime: Atom.runtime(Layer.empty),
          load: Effect.sync(() => {
            reads += 1;
          }).pipe(Effect.andThen(Deferred.await(held))),
        });
        try {
          const element = createElement(
            SessionRegistryProvider,
            null,
            createElement(SessionProbe, {
              attach: (value) => {
                owner = Option.some(value);
                registries.add(value.registry);
              },
            })
          );
          yield* Effect.tryPromise(() => reactWork(() => root.render(element)));
          const previous = Option.getOrThrow(owner);
          const recovery = yield* (
            pending ? readFreshQuery({ registry: previous.registry, query }) : Effect.succeed(false)
          ).pipe(Effect.forkChild);
          if (pending) yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(1)));
          yield* Effect.tryPromise(() => reactWork(previous.session.replaceAuthenticationLifetime));
          yield* Deferred.succeed(held, undefined);
          expect(yield* Fiber.join(recovery)).toBe(false);
          expect(yield* readFreshQuery({ registry: previous.registry, query })).toBe(false);
          const current = Option.getOrThrow(owner);
          expect(current.registry).not.toBe(previous.registry);
          expect(yield* readFreshQuery({ registry: current.registry, query })).toBe(true);
          expect(reads).toBe(pending ? 2 : 1);
        } finally {
          yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
          for (const registry of registries) registry.dispose();
          vi.unstubAllGlobals();
        }
      })
    )
);

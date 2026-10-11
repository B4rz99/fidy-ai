import { waitFor } from "@testing-library/dom";
import { Effect, Option } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeAuthenticationLifetime } from "@/session/lifetime";

const listingDisposed = vi.fn();
const connectionsDisposed = vi.fn();
const manualDisposed = vi.fn();
const refreshed = vi.fn();
const issued = { current: (): void => undefined };

vi.mock("@/features/pats/feature", () => ({
  mountPATListing: (): Readonly<{ dispose: () => void; refresh: () => void }> => ({
    dispose: listingDisposed,
    refresh: refreshed,
  }),
  mountManualPAT: ({ issued: callback }: Readonly<{ issued: () => void }>): (() => void) => {
    issued.current = callback;
    return manualDisposed;
  },
}));
vi.mock("@/features/oauth-connections/feature", () => ({
  mountOAuthListing: (): (() => void) => connectionsDisposed,
}));

const owners = new Set<() => void>();
afterEach(() => {
  for (const dispose of owners) dispose();
  owners.clear();
  vi.clearAllMocks();
});

it("refreshes metadata after issuance and releases all child owners once on navigation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { mountAccessPage } = yield* Effect.tryPromise(() => import("./native-access"));
      const lifetime = makeAuthenticationLifetime({
        apiOrigin: "https://api.test",
        onExpired: () => undefined,
      });
      const container = document.createElement("div");
      container.id = "access-test";
      document.body.append(container);
      const dispose = mountAccessPage({ container, lifetime, after: Option.none() });
      owners.add(() => {
        dispose();
        lifetime.dispose();
        container.remove();
      });
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(document.querySelectorAll('[id$="-program"]')).toHaveLength(3))
      );
      issued.current();
      expect(refreshed).toHaveBeenCalledOnce();
      dispose();
      dispose();
      expect(listingDisposed).toHaveBeenCalledOnce();
      expect(connectionsDisposed).toHaveBeenCalledOnce();
      expect(manualDisposed).toHaveBeenCalledOnce();
      issued.current();
      expect(refreshed).toHaveBeenCalledOnce();
      expect(container).toBeEmptyDOMElement();
    })
  ));

it("does not admit child owners after immediate route teardown", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { mountAccessPage } = yield* Effect.tryPromise(() => import("./native-access"));
      const lifetime = makeAuthenticationLifetime({
        apiOrigin: "https://api.test",
        onExpired: () => undefined,
      });
      const container = document.createElement("div");
      const dispose = mountAccessPage({ container, lifetime, after: Option.none() });
      dispose();
      lifetime.dispose();
      yield* Effect.tryPromise(() => waitFor(() => expect(document.body).toBeEmptyDOMElement()));
      expect(listingDisposed).not.toHaveBeenCalled();
      expect(connectionsDisposed).not.toHaveBeenCalled();
      expect(manualDisposed).not.toHaveBeenCalled();
    })
  ));

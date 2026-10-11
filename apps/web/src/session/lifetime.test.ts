import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vitest";
import { makeAuthenticationLifetime } from "./lifetime";

it("isolates account capabilities and synchronously closes retained feature owners", () => {
  const first = makeAuthenticationLifetime({
    apiOrigin: "https://api.test.fidyapp.com",
    onExpired: vi.fn(),
  });
  const second = makeAuthenticationLifetime({
    apiOrigin: "https://api.test.fidyapp.com",
    onExpired: vi.fn(),
  });
  const cached = Atom.make("empty");
  first.registry.set(cached, "first-account-data");
  expect(second.registry.get(cached)).toBe("empty");
  expect(first.apiClient).not.toBe(second.apiClient);
  expect(first.enrollmentClient).not.toBe(second.enrollmentClient);
  const close = vi.fn();
  const detached = vi.fn();
  first.retain(close);
  first.retain(detached)();
  first.dispose();
  expect(close).toHaveBeenCalledOnce();
  expect(detached).not.toHaveBeenCalled();
  first.dispose();
  expect(close).toHaveBeenCalledOnce();
  const lateOwner = vi.fn();
  first.retain(lateOwner);
  expect(lateOwner).toHaveBeenCalledOnce();
  expect(second.registry.get(cached)).toBe("empty");
  second.dispose();
});

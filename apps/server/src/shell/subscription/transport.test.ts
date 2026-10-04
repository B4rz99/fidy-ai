import { expect, it } from "vitest";
import { Option } from "effect";
import { SubscriptionEnrollmentGroup } from "./contract";
import { paymentEnrollmentTransport } from "./runtime";

it("recognizes declaration-backed enrollment paths and excludes malformed or foreign paths", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  for (const endpoint of Object.values(SubscriptionEnrollmentGroup.endpoints)) {
    const path = endpoint.path.replace(/:[^/]+/u, id);
    const transport = paymentEnrollmentTransport(path);
    expect(Option.isSome(transport)).toBe(true);
    if (Option.isNone(transport)) throw new Error("Missing enrollment transport");
    expect(transport.value.operation).toBe(endpoint.identifier);
    expect(transport.value.method).toBe(endpoint.method);
    expect(transport.value.parameter).toEqual(
      endpoint.params !== undefined ? Option.some(id) : Option.none()
    );
  }
  for (const path of [
    "/web/subscription/payment-enrollments/not-an-id",
    `/web/subscription/payment-enrollments/${id}/extra`,
    `/web/subscription/other/${id}`,
    "/subscription/upgrade-url",
  ]) {
    expect(paymentEnrollmentTransport(path)).toEqual(Option.none());
  }
});

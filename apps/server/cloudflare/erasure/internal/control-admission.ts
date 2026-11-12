import type { ErasureContinuation } from "../contract";

export const admissionLifetimeMs = 5000;

export const validContinuation = (
  input: Readonly<{ admission: ErasureContinuation; current: number; userId: string }>
): boolean =>
  input.admission.userId === input.userId &&
  input.admission.deadlineMs > input.current &&
  input.admission.deadlineMs <= input.current + admissionLifetimeMs &&
  input.admission.authority.expiresAtMs > input.current;

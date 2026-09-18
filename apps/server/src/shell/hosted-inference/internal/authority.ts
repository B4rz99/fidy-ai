import { Brand } from "effect";
import {
  type HostedInferenceError,
  type HostedTextContinuation,
  type HostedTextToolPolicy,
  HostedToolCallMaximum,
  type PreparedHostedStructured,
  type PreparedHostedText,
} from "~/shell/hosted-inference/contract";

/** Lifecycle of one prepared authority: executable, mid-execution, recoverable, or consumed. */
export type PreparedLifecycle = "ready" | "executing" | "recoverable" | "consumed";

const opaque = <Behavior extends object>(properties: Behavior): Behavior => {
  const authority: Behavior = { ...properties };
  for (const key of Reflect.ownKeys(authority)) {
    Object.defineProperty(authority, key, {
      value: Reflect.get(authority, key),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  Object.setPrototypeOf(authority, null);
  return Object.freeze(authority);
};

const textAuthority = Brand.nominal<PreparedHostedText>();
const continuationAuthority = Brand.nominal<HostedTextContinuation>();

/** Wraps one prepared text behavior as an opaque, unforgeable one-shot authority. */
export const makePreparedTextAuthority = (
  behavior: Brand.Brand.Unbranded<PreparedHostedText>
): PreparedHostedText => textAuthority(opaque(behavior));

/** Wraps one adapter-local continuation behavior as an opaque one-shot authority. */
export const makeContinuationAuthority = (
  behavior: Brand.Brand.Unbranded<HostedTextContinuation>
): HostedTextContinuation => continuationAuthority(opaque(behavior));

/** Wraps one prepared strict-structured behavior as an opaque one-shot authority. */
export const makePreparedStructuredAuthority = <Output>(
  behavior: Brand.Brand.Unbranded<PreparedHostedStructured<Output>>
): PreparedHostedStructured<Output> =>
  Brand.nominal<PreparedHostedStructured<Output>>()(opaque(behavior));

/** Derives the remaining tool policy for a continuation after its consumed tool calls. */
export const continuationPolicy = (input: {
  readonly policy: HostedTextToolPolicy;
  readonly consumedToolCalls: number;
}): HostedTextToolPolicy => {
  const { policy, consumedToolCalls } = input;
  if (policy.toolChoice === "none") return policy;
  const remaining = policy.maximumToolCalls - consumedToolCalls;
  return remaining <= 0
    ? { toolChoice: "none", availableOperations: policy.availableOperations }
    : {
        toolChoice: "auto",
        maximumToolCalls: HostedToolCallMaximum.make(remaining),
        availableOperations: policy.availableOperations,
      };
};

/** Maps one execution failure to the lifecycle its authority must adopt next. */
export const failedLifecycle = (error: HostedInferenceError): PreparedLifecycle => {
  if (error.reason._tag === "InvalidOutput") return "recoverable";
  return error.reason._tag === "ProviderUnavailable" && error.retryable ? "ready" : "consumed";
};

/** One-shot availability shared by prepared authorities and adapter-local continuations. */
export type OneShotPreparation = Readonly<{
  readonly begin: () => boolean;
  readonly restore: () => void;
  readonly consume: () => void;
}>;

/** Creates a guard that is available until begun, restored after failure, and spent after success. */
export const makeOneShotPreparation = (): OneShotPreparation => {
  let available = true;
  return {
    begin: () => {
      if (!available) return false;
      available = false;
      return true;
    },
    restore: () => {
      available = true;
    },
    consume: () => {
      available = false;
    },
  };
};

/** Lifecycle transitions shared by every prepared text authority. */
export type PreparedLifecycleTransitions = Readonly<{
  readonly current: () => PreparedLifecycle;
  readonly beginExecution: () => boolean;
  readonly completeExecution: () => void;
  readonly failExecution: (error: HostedInferenceError) => void;
  readonly beginRecovery: () => boolean;
  readonly beginDiscard: () => boolean;
}>;

/** Creates the one-shot execute/recover/discard transitions of a prepared text authority. */
export const makePreparedLifecycleTransitions = (): PreparedLifecycleTransitions => {
  let lifecycle: PreparedLifecycle = "ready";
  return {
    current: () => lifecycle,
    beginExecution: () => {
      if (lifecycle !== "ready") return false;
      lifecycle = "executing";
      return true;
    },
    completeExecution: () => {
      lifecycle = "consumed";
    },
    failExecution: (error) => {
      lifecycle = failedLifecycle(error);
    },
    beginRecovery: () => {
      if (lifecycle !== "recoverable") return false;
      lifecycle = "consumed";
      return true;
    },
    beginDiscard: () => {
      if (lifecycle !== "ready" && lifecycle !== "recoverable") return false;
      lifecycle = "consumed";
      return true;
    },
  };
};

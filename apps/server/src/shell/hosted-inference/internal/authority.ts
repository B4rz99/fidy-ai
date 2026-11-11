import { Brand } from "effect";
import {
  type HostedTextContinuation,
  type HostedTextToolPolicy,
  HostedToolCallMaximum,
  type PreparedHostedStructured,
  type PreparedHostedText,
} from "~/shell/hosted-inference/contract";

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

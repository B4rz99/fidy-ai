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
      value: Object.getOwnPropertyDescriptor(authority, key)?.value,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  Object.setPrototypeOf(authority, null);

  return Object.freeze(authority);
};

export const authorizePreparedText = <Requirements>(
  behavior: Brand.Brand.Unbranded<PreparedHostedText<Requirements>>
): PreparedHostedText<Requirements> =>
  Brand.nominal<PreparedHostedText<Requirements>>()(opaque(behavior));

export const authorizeContinuation = <Requirements>(
  behavior: Brand.Brand.Unbranded<HostedTextContinuation<Requirements>>
): HostedTextContinuation<Requirements> =>
  Brand.nominal<HostedTextContinuation<Requirements>>()(opaque(behavior));

export const authorizePreparedStructured = <Output, Requirements>(
  behavior: Brand.Brand.Unbranded<PreparedHostedStructured<Output, Requirements>>
): PreparedHostedStructured<Output, Requirements> =>
  Brand.nominal<PreparedHostedStructured<Output, Requirements>>()(opaque(behavior));

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

export type OneShotPreparation = Readonly<{
  readonly begin: () => boolean;
  readonly restore: () => void;
  readonly consume: () => void;
}>;

export const oneShotPreparation = (): OneShotPreparation => {
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

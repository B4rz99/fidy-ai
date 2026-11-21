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

const textAuthority = Brand.nominal<PreparedHostedText>();

const continuationAuthority = Brand.nominal<HostedTextContinuation>();

export const authorizePreparedText = (
  behavior: Brand.Brand.Unbranded<PreparedHostedText>
): PreparedHostedText => textAuthority(opaque(behavior));

export const authorizeContinuation = (
  behavior: Brand.Brand.Unbranded<HostedTextContinuation>
): HostedTextContinuation => continuationAuthority(opaque(behavior));

export const authorizePreparedStructured = <Output>(
  behavior: Brand.Brand.Unbranded<PreparedHostedStructured<Output>>
): PreparedHostedStructured<Output> =>
  Brand.nominal<PreparedHostedStructured<Output>>()(opaque(behavior));

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

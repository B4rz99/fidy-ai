import { Predicate } from "effect";
import type { RecoveryLifecycleEnvironment } from "../contract";
import { native } from "./context";

const objectMethods = new Set<PropertyKey>(["get", "head", "put", "delete", "list"]);

export const bucket = <Bucket extends object>({
  binding,
  environment,
}: Readonly<{
  binding: Bucket;
  environment: RecoveryLifecycleEnvironment;
}>): Bucket => {
  if (
    environment.RECOVERY_ADMISSION === undefined &&
    environment.RECOVERY_SOURCE_EPOCH === undefined
  ) {
    return binding;
  }
  return new Proxy(binding, {
    get: (target, property, receiver): unknown => {
      const value: unknown = Reflect.get(target, property, receiver);
      if (!objectMethods.has(property) || !Predicate.isFunction(value)) return value;
      return (...args: Array<unknown>): Promise<unknown> =>
        native({
          environment,
          work: () => Promise.resolve(Reflect.apply(value, target, args)),
        });
    },
  });
};

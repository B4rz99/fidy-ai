import type {
  AuthoritativeStoreEnvironment,
  SqliteStoreBinding,
} from "../../sqlite-store/contract";
import { withAuthoritativeStore } from "../../sqlite-store/operations";
import type { RecoveryLifecycleEnvironment } from "../contract";
import { native } from "./context";
import { environment as nativeEnvironment, objects } from "./environment";

/** Track the actual RPC transport before the selected facade decodes a known owner refusal. */
const store = ({
  binding,
  environment,
}: Readonly<{
  binding: SqliteStoreBinding;
  environment: RecoveryLifecycleEnvironment;
}>): SqliteStoreBinding => ({
  query: (input) => native({ environment, work: () => binding.query(input) }),
});

/** Native selection still belongs exclusively to the authoritative Store resolver. */
export const select = <
  Environment extends AuthoritativeStoreEnvironment & RecoveryLifecycleEnvironment,
>(
  environment: Environment
): Omit<Environment, keyof AuthoritativeStoreEnvironment> & Readonly<{ DB: D1Database }> => {
  const namespace = environment.SQLITE_STORE;
  if (namespace === undefined) return nativeEnvironment(withAuthoritativeStore(environment));
  const selected = withAuthoritativeStore({
    ...environment,
    SQLITE_STORE: {
      getByName: (name: string): SqliteStoreBinding =>
        store({ binding: namespace.getByName(name), environment }),
    },
  });
  // Remote SQL has already been tracked at its actual RPC Promise, not the rejecting decoder.
  return objects(selected);
};

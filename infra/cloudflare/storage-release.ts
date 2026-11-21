import type { WorkerBindings } from "./rollback-compatibility";
import { Effect, Schema } from "effect";
import { directoryHistory } from "../../apps/server/cloudflare/directory/schema/operations";
import { erasureStoreHistory } from "../../apps/server/cloudflare/erasure-store/operations";
import { maintenanceStoreHistory } from "../../apps/server/cloudflare/maintenance/operations";
import type { StoreHistory } from "../../apps/server/cloudflare/runtime/sqlite/contract";
import { pricingHistory } from "../../apps/server/cloudflare/subscription/pricing/operations";
import { userStoreHistory } from "../../apps/server/cloudflare/user-store/operations";

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const steps = Schema.NonEmptyArray(digest);

const StorageRelease = Schema.Struct({
  histories: Schema.Struct({
    user: steps,
    directory: steps,
    pricing: steps,
    maintenance: steps,
    erasure: steps,
  }),
  protocol: Schema.Struct({
    write: Schema.NonEmptyString,
    readers: Schema.NonEmptyArray(Schema.NonEmptyString),
  }),
});

export const storageReleaseBinding = "SQLITE_STORAGE_RELEASE";

export const storageReleaseCodec = Schema.fromJsonString(StorageRelease);

export const storageOwners = ["user", "directory", "pricing", "maintenance", "erasure"] as const;

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const canonical = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const migrationHistory = (history: StoreHistory): ReadonlyArray<string> =>
  history.steps.map((step) =>
    sha256(canonical([history.owner, step.version, step.id, step.statements]))
  );

export const buildStorageRelease = Effect.fn(function* () {
  const contracts = [
    "directory",
    "subscription",
    "transactions",
    "maintenance",
    "erasure",
    "erasure-store",
    "runtime/sqlite",
  ];

  const files = yield* Effect.forEach(contracts, (owner) =>
    Effect.tryPromise(() =>
      Bun.file(new URL(`../../apps/server/cloudflare/${owner}/contract.ts`, import.meta.url)).text()
    ).pipe(Effect.map((source) => [owner, source]))
  );

  const write = sha256(canonical(files));

  return yield* Schema.decodeUnknownEffect(StorageRelease)({
    histories: {
      user: migrationHistory(userStoreHistory),
      directory: migrationHistory(directoryHistory),
      pricing: migrationHistory(pricingHistory),
      maintenance: migrationHistory(maintenanceStoreHistory),
      erasure: migrationHistory(erasureStoreHistory),
    },
    protocol: { write, readers: [write] },
  });
});

type Description = Readonly<{
  histories: Readonly<Record<StoreHistory["owner"], ReadonlyArray<string>>>;
  protocol: Readonly<{ write: string; readers: ReadonlyArray<string> }>;
}>;

type Overlap = Readonly<{ forward: boolean; rollback: boolean }>;

const protocolIdentity = (digest: string): string =>
  digest === "176dcf18c895cce04e5abe6dde4cc541c46bdd189b4ecfc85fec8621c672b3e3"
    ? "87d29c622bb96d493a602d18741fa4b8532871914bc956c0560d909e4377c4f5"
    : digest;

const readsProtocol = (reader: Description["protocol"], writer: Description["protocol"]): boolean =>
  reader.readers.some((digest) => protocolIdentity(digest) === protocolIdentity(writer.write));

export const storageOverlap = ({
  stable,
  candidate,
}: {
  stable: Description;
  candidate: Description;
}): Overlap => {
  const forward =
    readsProtocol(stable.protocol, candidate.protocol) &&
    readsProtocol(candidate.protocol, stable.protocol) &&
    storageOwners.every((owner) =>
      stable.histories[owner].every((step, index) => candidate.histories[owner][index] === step)
    );

  return {
    forward,
    rollback:
      forward &&
      storageOwners.every(
        (owner) => stable.histories[owner].length === candidate.histories[owner].length
      ),
  };
};

export const namespaceClasses = {
  USER_STORE: "UserStore",
  DIRECTORY: "Directory",
  PRICING: "Pricing",
  MAINTENANCE: "Maintenance",
  ERASURE: "Erasure",
} as const;

const published = Schema.Struct({ type: Schema.Literal("plain_text"), text: storageReleaseCodec });

const nativeNamespace = Schema.Struct({
  type: Schema.Literal("durable_object_namespace"),
  class_name: Schema.NonEmptyString,
  namespace_id: Schema.NonEmptyString,
});

type Bindings = WorkerBindings;

type VerifiedStorage = {
  description: typeof StorageRelease.Type;
  namespaces: ReadonlyArray<string>;
};

export const verifiedStoragePair = (input: {
  ingress: Bindings;
  core: Bindings;
}): VerifiedStorage => {
  const d1 = Schema.is(Schema.Struct({ type: Schema.Literal("d1") }));

  if ([...Object.values(input.ingress), ...Object.values(input.core)].some(d1)) {
    throw Error("D1 is incompatible with fresh SQLite storage");
  }

  const ingress = Schema.decodeUnknownSync(published)(input.ingress[storageReleaseBinding]).text;
  const core = Schema.decodeUnknownSync(published)(input.core[storageReleaseBinding]).text;

  if (canonical(ingress) !== canonical(core)) {
    throw Error("Ingress and Core storage releases differ");
  }

  const namespaces = Object.entries(namespaceClasses).map(([name, expected]) => {
    const binding = Schema.decodeUnknownSync(nativeNamespace)(input.core[name]);

    if (binding.class_name !== expected || input.ingress[name] !== undefined) {
      throw Error("Unexpected store class, binding or exposure");
    }

    return binding.namespace_id;
  });

  if (new Set(namespaces).size !== namespaces.length) {
    throw Error("Store namespaces must be independent");
  }

  return { description: core, namespaces };
};

export const compatibleStoragePairs = ({
  serving,
  candidate,
}: {
  serving: ReturnType<typeof verifiedStoragePair>;
  candidate: ReturnType<typeof verifiedStoragePair>;
}): Overlap => {
  if (serving.namespaces.some((id, index) => candidate.namespaces[index] !== id)) {
    return { forward: false, rollback: false };
  }

  return storageOverlap({ stable: serving.description, candidate: candidate.description });
};

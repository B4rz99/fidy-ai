import { Schema } from "effect";
import { smokePath } from "../runtime/contract";

export const compatibilityQuery = "?storage=compatibility";

export const isStorageCompatibility = (request: Request): boolean => {
  const url = new URL(request.url);

  return (
    request.method === "GET" && url.pathname === smokePath && url.search === compatibilityQuery
  );
};

export const bootstrapQuery = "?storage=initialize";

export const isStorageBootstrap = (request: Request): boolean => {
  const url = new URL(request.url);

  return request.method === "POST" && url.pathname === smokePath && url.search === bootstrapQuery;
};

const observation = Schema.Struct({
  workerVersionId: Schema.String.check(Schema.isUUID()),
  history: Schema.NonEmptyArray(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});

export const SharedStoreMarkers = Schema.Struct({
  user: observation,
  directory: observation,
  pricing: observation,
  maintenance: observation,
  erasure: observation,
});

export type SharedBindings = Partial<
  Readonly<
    Record<
      "USER_STORE" | "DIRECTORY" | "PRICING" | "MAINTENANCE" | "ERASURE",
      {
        getByName(name: string): Pick<Fetcher, "fetch">;
      }
    >
  >
>;

export const isStorageProbe = (request: Request): boolean =>
  isStorageBootstrap(request) || isStorageCompatibility(request);

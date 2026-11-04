import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { type SqliteStoreReply, SqliteStoreRequest } from "./contract";
import { executeStoreQuery } from "./internal/query";

const Seal = Schema.Struct({ manifest: Schema.String, status: Schema.Literal("verified") });
type StoreEnvironment = Partial<Readonly<{ SQLITE_STORE_MANIFEST: string }>>;

/** Private binding only. Serving code has no import, restore, activation or SQL fetch endpoint. */
export class AuthoritativeSqliteStore extends DurableObject<StoreEnvironment> {
  query(candidate: unknown): SqliteStoreReply {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownOption(SqliteStoreRequest)(candidate);
      if (request._tag === "None") return { kind: "refused", reason: "invalid" };
      const seal = Schema.decodeUnknownOption(Seal)(this.ctx.storage.kv.get("store-seal"));
      if (
        seal._tag === "None" ||
        seal.value.manifest !== this.env.SQLITE_STORE_MANIFEST ||
        request.value.manifest !== this.env.SQLITE_STORE_MANIFEST
      ) {
        return { kind: "refused", reason: "inactive" };
      }
      return executeStoreQuery({ storage: this.ctx.storage, candidate: request.value.query });
    });
  }
}

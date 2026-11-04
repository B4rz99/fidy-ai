import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";
import {
  SqliteStoreControlQuery,
  type SqliteStoreControlReply,
  SqliteStoreControlRequest,
  type SqliteStoreEnvironment,
  type SqliteStoreReply,
  SqliteStoreRequest,
} from "./contract";
import { storeObservation } from "./internal/gate";
import { executeStoreQuery } from "./internal/query";

/** Private binding only. Serving code has no import, restore, activation or SQL fetch endpoint. */
export class AuthoritativeSqliteStore extends DurableObject<SqliteStoreEnvironment> {
  inspect(): SqliteStoreControlReply {
    return this.ctx.storage.transactionSync(() =>
      Option.getOrElse(
        storeObservation({
          storage: this.ctx.storage,
          environment: this.env,
          objectId: this.ctx.id.toString(),
        }),
        () => ({ kind: "refused", reason: "inactive" }) as const
      )
    );
  }
  close(candidate: unknown): SqliteStoreControlReply {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownOption(SqliteStoreControlRequest)(candidate);
      const observation = this.inspect();
      if ("kind" in observation) return observation;
      if (Option.isNone(request)) return { kind: "refused", reason: "invalid" };
      if (
        request.value.epoch !== observation.target.epoch ||
        (observation.admission === "Closed" &&
          observation.activationId !== request.value.activationId)
      ) {
        return { kind: "refused", reason: "inactive" };
      }
      this.ctx.storage.kv.put("store-admission", { phase: "Closed", ...request.value });
      return this.inspect();
    });
  }
  controlQuery(candidate: unknown): SqliteStoreReply {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownOption(SqliteStoreControlQuery)(candidate);
      if (Option.isNone(request)) return { kind: "refused", reason: "invalid" };
      const observation = this.inspect();
      if (
        "kind" in observation ||
        observation.admission !== "Closed" ||
        observation.activationId !== request.value.activationId ||
        observation.target.epoch !== request.value.epoch
      ) {
        return { kind: "refused", reason: "inactive" };
      }
      return executeStoreQuery({ storage: this.ctx.storage, candidate: request.value.query });
    });
  }
  query(candidate: unknown): SqliteStoreReply {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownOption(SqliteStoreRequest)(candidate);
      if (Option.isNone(request)) return { kind: "refused", reason: "invalid" };
      const observation = this.inspect();
      if (
        "kind" in observation ||
        request.value.manifest !== observation.target.manifest ||
        request.value.epoch !== observation.target.epoch
      ) {
        return { kind: "refused", reason: "inactive" };
      }
      if (observation.admission === "Closed") {
        return { kind: "refused", reason: "closed" };
      }
      return executeStoreQuery({ storage: this.ctx.storage, candidate: request.value.query });
    });
  }
}

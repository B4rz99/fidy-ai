import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";
import { type RecoveryAdmissionState, RecoveryClose, RecoveryLease } from "./contract";

const State = Schema.Struct({
  epoch: Schema.String,
  activationId: Schema.String,
  closed: Schema.Boolean,
});
type GateEnvironment = Readonly<{ RECOVERY_SOURCE_EPOCH: string }>;

/** Independent of every recoverable database. Unknown crashed leases never expire into permission. */
export class RecoveryAdmissionGate extends DurableObject<GateEnvironment> {
  #state(): typeof State.Type {
    const stored = Schema.decodeUnknownOption(State)(this.ctx.storage.kv.get("admission"));
    if (Option.isSome(stored)) return stored.value;
    const initial = { epoch: this.env.RECOVERY_SOURCE_EPOCH, activationId: "", closed: false };
    this.ctx.storage.kv.put("admission", initial);
    return initial;
  }

  inspect(): RecoveryAdmissionState {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS recovery_leases(id TEXT PRIMARY KEY,epoch TEXT NOT NULL) STRICT"
      );
      return {
        ...this.#state(),
        leases: this.ctx.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM recovery_leases")
          .one().count,
      };
    });
  }

  enter(candidate: unknown): boolean {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownOption(RecoveryLease, { onExcessProperty: "error" })(
        candidate
      );
      const state = this.inspect();
      if (
        Option.isNone(request) ||
        state.closed ||
        request.value.epoch !== state.epoch ||
        state.epoch !== this.env.RECOVERY_SOURCE_EPOCH
      ) {
        return false;
      }
      const inserted = this.ctx.storage.sql
        .exec(
          "INSERT INTO recovery_leases VALUES(?,?) ON CONFLICT DO NOTHING RETURNING id",
          request.value.leaseId,
          request.value.epoch
        )
        .toArray();
      return inserted.length === 1;
    });
  }

  complete(candidate: unknown): boolean {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownOption(RecoveryLease, { onExcessProperty: "error" })(
        candidate
      );
      const state = this.inspect();
      if (Option.isNone(request) || request.value.epoch !== state.epoch) return false;
      const deleted = this.ctx.storage.sql
        .exec(
          "DELETE FROM recovery_leases WHERE id=? AND epoch=? RETURNING id",
          request.value.leaseId,
          request.value.epoch
        )
        .toArray();
      return deleted.length === 1 && !state.closed;
    });
  }

  close(candidate: unknown): RecoveryAdmissionState {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownSync(RecoveryClose, { onExcessProperty: "error" })(
        candidate
      );
      const state = this.inspect();
      if (
        request.epoch !== state.epoch ||
        (state.closed && request.activationId !== state.activationId)
      ) {
        throw new Error("Recovery admission refused");
      }
      this.ctx.storage.kv.put("admission", {
        epoch: state.epoch,
        activationId: request.activationId,
        closed: true,
      });
      return this.inspect();
    });
  }
}

import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";
import { type RecoveryAdmissionState, RecoveryClose, RecoveryLease } from "./contract";

const State = Schema.Struct({
  epoch: Schema.String,
  activationId: Schema.String,
  closed: Schema.Boolean,
  paused: Schema.Boolean,
});
type GateEnvironment = Readonly<{ RECOVERY_SOURCE_EPOCH: string }>;

/** Independent of every recoverable database. Unknown crashed leases never expire into permission. */
export class RecoveryAdmissionGate extends DurableObject<GateEnvironment> {
  #state(): typeof State.Type {
    const stored = this.ctx.storage.kv.get("admission");
    if (stored !== undefined) {
      return Schema.decodeUnknownSync(State, { onExcessProperty: "error" })(stored);
    }
    const initial = Schema.decodeSync(State)({
      epoch: this.env.RECOVERY_SOURCE_EPOCH,
      activationId: "",
      closed: false,
      paused: false,
    });
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
    return this.#enter(candidate, false);
  }

  /** Native Queue, Workflow and private coordinator entries still require their owning job authority; this only admits their captured epoch while publishers are paused. */
  enterContinuation(candidate: unknown): boolean {
    return this.#enter(candidate, true);
  }

  #enter(candidate: unknown, continuation: boolean): boolean {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownOption(RecoveryLease, { onExcessProperty: "error" })(
        candidate
      );
      const state = this.inspect();
      if (
        Option.isNone(request) ||
        state.closed ||
        (!continuation && state.paused) ||
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

  pause(candidate: unknown): RecoveryAdmissionState {
    return this.#transition(candidate, false);
  }

  close(candidate: unknown): RecoveryAdmissionState {
    return this.#transition(candidate, true);
  }

  #transition(candidate: unknown, close: boolean): RecoveryAdmissionState {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownSync(RecoveryClose, { onExcessProperty: "error" })(
        candidate
      );
      const state = this.inspect();
      if (
        request.epoch !== state.epoch ||
        (state.activationId !== "" && request.activationId !== state.activationId)
      ) {
        throw new Error("Recovery admission refused");
      }
      this.ctx.storage.kv.put("admission", {
        epoch: state.epoch,
        activationId: request.activationId,
        paused: true,
        closed: state.closed || close,
      });
      return this.inspect();
    });
  }
}

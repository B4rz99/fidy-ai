import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";
import {
  type RecoveryAdmissionState,
  RecoveryClose,
  RecoveryControllerClaim,
  RecoveryLease,
} from "./contract";

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
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS recovery_controllers(id TEXT PRIMARY KEY,epoch TEXT NOT NULL,activation_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('Held','Unknown','Released'))) STRICT"
      );
      this.ctx.storage.sql.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS recovery_controller_exclusive ON recovery_controllers((1)) WHERE status<>'Released'"
      );
      return {
        ...this.#state(),
        controllerBusy:
          this.ctx.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM recovery_controllers WHERE status<>'Released'"
            )
            .one().count !== 0,
        objectId: this.ctx.id.toString(),
        leases: this.ctx.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM recovery_leases")
          .one().count,
      };
    });
  }

  /** Exact opaque replay can recover a lost acquire reply; a released identity is never reused. */
  acquireController(candidate: unknown): boolean {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownSync(RecoveryControllerClaim, {
        onExcessProperty: "error",
      })(candidate);
      const state = this.inspect();
      if (
        request.epoch !== state.epoch ||
        state.epoch !== this.env.RECOVERY_SOURCE_EPOCH ||
        (state.activationId !== "" && request.activationId !== state.activationId)
      ) {
        return false;
      }
      const existing = this.ctx.storage.sql
        .exec<{ epoch: string; activation_id: string; status: string }>(
          "SELECT epoch,activation_id,status FROM recovery_controllers WHERE id=?",
          request.claimId
        )
        .toArray()[0];
      if (existing !== undefined) {
        return this.#matchesController(existing, request);
      }
      if (state.controllerBusy) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO recovery_controllers VALUES(?,?,?,'Held')",
        request.claimId,
        request.epoch,
        request.activationId
      );
      return true;
    });
  }

  #matchesController(
    existing: Readonly<{ epoch: string; activation_id: string; status: string }>,
    request: RecoveryControllerClaim
  ): boolean {
    return (
      existing.epoch === request.epoch &&
      existing.activation_id === request.activationId &&
      existing.status === "Held"
    );
  }

  /** The exact released tombstone acknowledges a lost reply without touching a later owner. */
  releaseController(candidate: unknown): boolean {
    return this.#controller(candidate, false);
  }

  /** Unknown native work cannot become permission through a retry or elapsed time. */
  retainController(candidate: unknown): boolean {
    return this.#controller(candidate, true);
  }

  #controller(candidate: unknown, unknown: boolean): boolean {
    return this.ctx.storage.transactionSync(() => {
      const request = Schema.decodeUnknownSync(RecoveryControllerClaim, {
        onExcessProperty: "error",
      })(candidate);
      this.inspect();
      const existing = this.ctx.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM recovery_controllers WHERE id=? AND epoch=? AND activation_id=?",
          request.claimId,
          request.epoch,
          request.activationId
        )
        .toArray()[0];
      if (
        existing === undefined ||
        (!unknown && existing.status === "Unknown") ||
        (unknown && existing.status === "Released")
      ) {
        return false;
      }
      this.ctx.storage.sql.exec(
        "UPDATE recovery_controllers SET status=? WHERE id=?",
        unknown ? "Unknown" : "Released",
        request.claimId
      );
      return true;
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

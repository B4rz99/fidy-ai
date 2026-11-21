import type { StoreReleaseEnvironment } from "../runtime/sqlite/contract";
import { Pricing } from "./runtime";

const restrictAt = 0.8;

const unavailable = 503;

const unexpected = 500;

export class PricingFixture extends Pricing {
  private readonly storage: DurableObjectStorage;
  private readonly ceilingBytes: number;
  constructor(state: DurableObjectState, env: StoreReleaseEnvironment) {
    super(state, env);
    this.storage = state.storage;
    this.ceilingBytes = Number(env.SQLITE_STORE_CAPACITY_BYTES);
  }
  private inspectRecovery(): Promise<Response> {
    const rows = this.storage.sql
      .exec(
        "SELECT request,price_id,outcome,next_check_ms FROM price_registrations ORDER BY operation_id"
      )
      .toArray();

    return this.storage.getAlarm().then((alarm) => Response.json({ alarm, rows }));
  }
  private recoveryFixture(request: Request): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/fixture/forget-registration-wake":
        this.storage.sql.exec("UPDATE price_registrations SET next_check_ms=NULL");

        return this.storage.deleteAlarm().then(() => new Response(null, { status: 204 }));
      case "/fixture/drop-alarm":
        return this.storage.deleteAlarm().then(() => new Response(null, { status: 204 }));
      case "/fixture/inspect-recovery":
        return this.inspectRecovery();
      case "/billing/registration-outcome":
        return request
          .text()
          .then((body) =>
            this.storage
              .put("last-probe", body)
              .then(() => new Response(null, { status: unavailable }))
          );
      case "/fixture/last-probe":
        return this.storage.get<string>("last-probe").then((body) => new Response(body ?? "null"));

      default:
        return super.fetch(request);
    }
  }
  override fetch(request: Request): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/fixture/restrict-growth": {
        return request.arrayBuffer().then(() => {
          const sql = this.storage.sql;
          const healthyBytes = sql.databaseSize;
          let index = 0;

          while (sql.databaseSize < this.ceilingBytes * restrictAt) {
            const id =
              "98000000-0000-4000-8000-" + String(++index).padStart("000000000000".length, "0");

            sql.exec(
              "INSERT INTO prices(id,terms) SELECT ?,json_set(terms,'$.id',?) FROM prices WHERE id='22700000-0000-4000-8000-000000000001'",
              id,
              id
            );
          }

          return Response.json({
            healthyBytes,
            pressureBytes: sql.databaseSize,
            ceilingBytes: this.ceilingBytes,
          });
        });
      }

      case "/fixture/fail-before-receipt":
        this.storage.sql.exec(
          "CREATE TRIGGER fixture_abort BEFORE INSERT ON price_publications BEGIN SELECT RAISE(ABORT, 'fixture'); END"
        );

        return super.fetch(new Request("https://pricing.internal/publish", request)).finally(() => {
          this.storage.sql.exec("DROP TRIGGER fixture_abort");
        });
      case "/fixture/lose-response": {
        return super
          .fetch(new Request("https://pricing.internal/publish", request))
          .then(
            (response) => new Response(null, { status: response.ok ? unavailable : unexpected })
          );
      }

      default:
        return this.recoveryFixture(request);
    }
  }
}

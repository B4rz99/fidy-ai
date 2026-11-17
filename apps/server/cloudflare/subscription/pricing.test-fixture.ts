import type { StoreReleaseEnvironment } from "../runtime/sqlite/contract";
import { Pricing } from "./runtime";

const pricingTestCeiling = 131072;
const restrictAt = 0.8;
const unavailable = 503;
const unexpected = 500;

/** Interrupt the native transaction at its final statement, or discard its committed response. */
export class PricingFixture extends Pricing {
  private readonly storage: DurableObjectStorage;
  constructor(state: DurableObjectState, env: StoreReleaseEnvironment) {
    super(state, env);
    this.storage = state.storage;
  }
  override fetch(request: Request): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/fixture/restrict-growth": {
        return request.arrayBuffer().then(() => {
          const bytes = pricingTestCeiling;
          const sql = this.storage.sql;
          let index = 0;
          while (sql.databaseSize < bytes * restrictAt) {
            const id =
              "98000000-0000-4000-8000-" + String(++index).padStart("000000000000".length, "0");
            sql.exec(
              "INSERT INTO prices(id,terms) SELECT ?,json_set(terms,'$.id',?) FROM prices WHERE id='22700000-0000-4000-8000-000000000001'",
              id,
              id
            );
          }
          return Response.json({ usedBytes: sql.databaseSize, ceilingBytes: bytes });
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
        return super.fetch(request);
    }
  }
}

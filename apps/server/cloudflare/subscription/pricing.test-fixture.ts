import { Pricing } from "./runtime";

const unavailable = 503;
const unexpected = 500;

/** Interrupt the native transaction at its final statement, or discard its committed response. */
export class PricingFixture extends Pricing {
  private readonly storage: DurableObjectStorage;
  constructor(state: DurableObjectState) {
    super(state);
    this.storage = state.storage;
  }
  override async fetch(request: Request): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/fixture/fail-before-receipt":
        this.storage.sql.exec(
          "CREATE TRIGGER fixture_abort BEFORE INSERT ON price_publications BEGIN SELECT RAISE(ABORT, 'fixture'); END"
        );
        return new Response(null, { status: 204 });
      case "/fixture/lose-response": {
        this.storage.sql.exec("DROP TRIGGER fixture_abort");
        const response = await super.fetch(
          new Request("https://pricing.internal/publish", request)
        );
        return new Response(null, { status: response.ok ? unavailable : unexpected });
      }
      default:
        return super.fetch(request);
    }
  }
}

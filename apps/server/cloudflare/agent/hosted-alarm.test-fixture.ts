import { Option } from "effect";
import { UserStore as NativeUserStore } from "../core-worker";

const statusUnavailable = 503;

const statusNoContent = 204;

export { default } from "../core-worker";

export * from "../core-worker";

export class UserStore extends NativeUserStore {
  private holdChecks = false;
  private readonly checks = { admitted: 0, aborted: 0, active: 0 };
  private heldCheck(request: Request): Option.Option<Promise<Response>> {
    if (request.url === "https://fixture.invalid/hold-check") {
      this.holdChecks = true;

      return Option.some(Promise.resolve(new Response(null, { status: statusNoContent })));
    }

    if (request.url === "https://fixture.invalid/held-checks") {
      return Option.some(Promise.resolve(Response.json(this.checks)));
    }

    if (!this.holdChecks || request.url !== "https://owner.internal/work/check") {
      return Option.none();
    }

    const held = Promise.withResolvers<Response>();
    this.checks.admitted++;
    this.checks.active++;
    request.signal.addEventListener(
      "abort",
      () => {
        this.checks.aborted++;
        this.checks.active--;
        held.resolve(new Response(null, { status: statusUnavailable }));
      },
      { once: true }
    );

    return Option.some(held.promise);
  }
  private pausePath = "";
  private arrived = false;
  private disconnected = false;
  private readonly resume = Promise.withResolvers<void>();
  private pausedRequest(request: Request): Option.Option<Promise<Response>> {
    const path = new URL(request.url).pathname;

    if (
      request.url === "https://fixture.invalid/pause-admission" ||
      request.url === "https://fixture.invalid/pause-progress"
    ) {
      this.pausePath = path.endsWith("admission")
        ? "/web/hosted-turns"
        : "/web/hosted-turns/progress";

      return Option.some(Promise.resolve(new Response(null, { status: 204 })));
    }

    if (request.url === "https://fixture.invalid/entered") {
      return Option.some(
        Promise.resolve(Response.json({ arrived: this.arrived, aborted: this.disconnected }))
      );
    }

    if (request.url === "https://fixture.invalid/resume") {
      this.resume.resolve();

      return Option.some(Promise.resolve(new Response(null, { status: 204 })));
    }

    if (path === this.pausePath) {
      this.arrived = true;
      request.signal.addEventListener(
        "abort",
        () => {
          this.disconnected = true;
        },
        { once: true }
      );

      return Option.some(this.resume.promise.then(() => super.fetch(request)));
    }

    return Option.none();
  }
  private clocked<Value>(instant: number, run: () => Promise<Value>): Promise<Value> {
    const clock = Date.now;
    Date.now = (): number => instant;

    return run().finally(() => {
      Date.now = clock;
    });
  }
  private clockRequest(request: Request): Option.Option<Promise<Response>> {
    const url = new URL(request.url);

    if (url.origin === "https://fixture.invalid" && url.pathname === "/clocked-alarm") {
      const instant = Number(url.searchParams.get("now"));

      return Option.some(
        this.clocked(instant, () => super.alarm()).then(() => new Response(null, { status: 204 }))
      );
    }

    if (url.origin === "https://fixture.invalid" && url.pathname === "/set-opportunity-clock") {
      return Option.some(
        this.ctx.storage
          .put("fixture-opportunity-clock", Number(url.searchParams.get("now")))
          .then(() => new Response(null, { status: 204 }))
      );
    }

    return Option.none();
  }
  override fetch(request: Request): Promise<Response> {
    const held = this.heldCheck(request);

    if (Option.isSome(held)) return held.value;
    const clocked = this.clockRequest(request);

    if (Option.isSome(clocked)) return clocked.value;
    const paused = this.pausedRequest(request);

    if (Option.isSome(paused)) return paused.value;

    if (request.url === "https://fixture.invalid/hold-alarm") {
      return this.ctx.storage
        .put("fixture-hold-alarm", true)
        .then(() => new Response(null, { status: 204 }));
    }

    if (request.url === "https://fixture.invalid/missed-alarm") {
      return this.ctx.storage
        .get("fixture-missed-alarm")
        .then((value) => Response.json({ missed: value === true }));
    }

    if (request.url === "https://fixture.invalid/resume-alarm") {
      return this.ctx.storage
        .delete("fixture-hold-alarm")
        .then(() => new Response(null, { status: 204 }));
    }

    return this.ctx.storage
      .get<number>("fixture-opportunity-clock")
      .then((instant) =>
        instant === undefined
          ? super.fetch(request)
          : this.clocked(instant, () => super.fetch(request))
      );
  }
  override alarm(): Promise<void> {
    return this.ctx.storage
      .get("fixture-hold-alarm")
      .then((held) =>
        held === true ? this.ctx.storage.put("fixture-missed-alarm", true) : super.alarm()
      );
  }
}

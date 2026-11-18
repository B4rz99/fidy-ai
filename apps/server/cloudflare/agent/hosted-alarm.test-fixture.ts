import { Option } from "effect";
import { UserStore as NativeUserStore } from "../core-worker";

export { default } from "../core-worker";
export * from "../core-worker";

/** Simulate loss of a committed alarm delivery, then let the real watchdog and alarm recover it. */
export class UserStore extends NativeUserStore {
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
  override fetch(request: Request): Promise<Response> {
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
    return super.fetch(request);
  }
  override alarm(): Promise<void> {
    return this.ctx.storage
      .get("fixture-hold-alarm")
      .then((held) =>
        held === true ? this.ctx.storage.put("fixture-missed-alarm", true) : super.alarm()
      );
  }
}

import { UserStore as NativeUserStore } from "../core-worker";

export { default } from "../core-worker";
export * from "../core-worker";

/** Simulate loss of a committed alarm delivery, then let the real watchdog and alarm recover it. */
export class UserStore extends NativeUserStore {
  override fetch(request: Request): Promise<Response> {
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

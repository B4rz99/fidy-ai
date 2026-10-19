import { Schema } from "effect";

export { UserTransactionCoordinator } from "./transactions/runtime";

const maximumAdvanceMilliseconds = 60_000;
const ClockAdvance = Schema.Struct({
  milliseconds: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumAdvanceMilliseconds)
  ),
});
const nativeNow = Date.now.bind(Date);
let elapsedMilliseconds = 0;

export default {
  fetch: (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== "/__fixture/clock" || request.method !== "POST") {
      return Promise.resolve(new Response("not_found", { status: 404 }));
    }
    return request.json().then((body: unknown) => {
      const advance = Schema.decodeUnknownSync(ClockAdvance)(body);
      elapsedMilliseconds += advance.milliseconds;
      Date.now = (): number => nativeNow() + elapsedMilliseconds;
      return new Response(null, { status: 204 });
    });
  },
};

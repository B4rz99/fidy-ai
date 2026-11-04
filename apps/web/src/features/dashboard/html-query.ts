import type { FidyClient } from "@/transport/client";
import { Data, Effect, Option } from "effect";
import { type AsyncResult, Atom } from "effect/reactivity";

export type DashboardHtml =
  | Readonly<{ status: "ready"; html: string }>
  | Readonly<{ status: "uninitialized" }>;
const successfulStatus = 200;
const missingStatus = 404;
class DashboardHtmlEntryFailed extends Data.TaggedError("DashboardHtmlEntryFailed") {}
const readDashboardHtml = Effect.fn("dashboard.htmlRead")(function* (apiClient: FidyClient) {
  const initial = apiClient.dashboardHtml.takeInitial();
  if (Option.isSome(initial)) {
    if (initial.value.status === successfulStatus) {
      return { status: "ready", html: initial.value.html } as const;
    }
    if (initial.value.status === missingStatus) return { status: "uninitialized" } as const;
    return yield* new DashboardHtmlEntryFailed();
  }
  const client = yield* apiClient.dashboardHtml;
  return yield* client.dashboardHtml.view({ headers: { accept: "text/html" } }).pipe(
    Effect.map((html): DashboardHtml => ({ status: "ready", html })),
    Effect.catchTag("DashboardUninitialized", () =>
      Effect.succeed({ status: "uninitialized" } as const)
    )
  );
});

/** Each mounted visit owns a fresh transfer; unmount disposes all retained financial HTML. */
export const dashboardHtmlQuery: (
  apiClient: FidyClient
) => Atom.Atom<AsyncResult.AsyncResult<DashboardHtml, unknown>> = (apiClient: FidyClient) =>
  apiClient.dashboardHtml.runtime
    .atom(() => readDashboardHtml(apiClient))
    .pipe(
      Atom.setIdleTTL(0),
      apiClient.dashboardHtml.runtime.factory.withReactivity(["dashboard"]),
      Atom.setIdleTTL(0)
    );

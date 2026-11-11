// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { Clock, Deferred, Effect, Layer, Option, Schema } from "effect";
import { RegistryContext } from "@effect/atom-react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { RecurringPlanId, makeFidyClient } from "@/transport/client";
import { recurringWorkspaceQuery, useRecurringPlanning } from "./controller";

const planId = RecurringPlanId.make("23200000-0000-4000-8000-000000000001");
const document = {
  revision: 0,
  plans: [
    {
      id: planId,
      pauses: [],
      revisions: [
        {
          from: "2026-10-01",
          plan: {
            name: "Internet QA",
            kind: "expense",
            currency: "COP",
            amountMode: "unknown",
            frequency: "monthly",
            firstDate: "2026-10-01",
            timeZone: "America/Bogota",
          },
        },
      ],
    },
  ],
  exceptions: [],
  fulfillments: [],
  excludedTransactionIds: [],
  suggestions: [],
};
const workspace = {
  document,
  month: "2026-10",
  today: "2026-10-29",
  occurrences: [],
  previous: [],
  summary: [],
  linkedTransactions: [],
  invalidFulfillmentIds: [],
  matches: [],
  matchesComplete: true,
};
const PlanningProbe = ({
  client,
  onSaved,
  month,
  profileStale,
  duplicate,
}: Readonly<{
  client: ReturnType<typeof makeFidyClient>;
  onSaved: () => void;
  month: string;
  profileStale: boolean;
  duplicate: boolean;
}>): ReturnType<typeof createElement> => {
  const planning = useRecurringPlanning({
    apiClient: client,
    query: { month, view: "compact" },
    profileStale,
    profileWaiting: false,
    refreshProfile: () => undefined,
  });
  return createElement(
    "main",
    { ref: planning.mounted },
    createElement(
      "output",
      { ref: planning.admit },
      planning.saveState,
      Option.match(planning.confirmation, {
        onNone: () => "",
        onSome: (receipt) => `${receipt.name}:${receipt.action}`,
      })
    ),
    createElement(
      "button",
      {
        disabled: planning.disabled,
        onClick: () => {
          const edit = { kind: "lifecycle", planId, date: "2026-10-29", action: "pause" } as const;
          planning.save(edit, onSaved);
          if (duplicate) planning.save(edit, onSaved);
          Object.assign(edit, { action: "stop" });
        },
      },
      "Pause"
    ),
    createElement("button", { onClick: planning.retry }, "Refresh")
  );
};

type Outcome = "confirmed" | "rejected" | "uncertain";
const saveResponse = (outcome: Outcome): Response => {
  if (outcome === "confirmed") {
    return Response.json({ data: { ...document, revision: 1 }, next: [] });
  }
  if (outcome === "rejected") {
    return Response.json(
      {
        _tag: "ValidationFailed",
        error: { code: "validation_failed", message: "Rejected", fields: [] },
        next: [],
      },
      { status: 400 }
    );
  }
  return Response.json({});
};

it.each(["confirmed", "rejected", "uncertain"] as const)(
  "publishes lifecycle feedback only for a confirmed save: %s",
  (outcome) =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        const reply = Deferred.makeUnsafe<Response>();
        const reread = { current: Deferred.makeUnsafe<Response>() };
        const onSaved = vi.fn();
        const http = planningHttp(reply, reread);
        const client = makeFidyClient({
          apiOrigin: "https://api.test.fidyapp.com",
          httpClient: Layer.succeed(HttpClient.HttpClient, http),
        });
        const registry = AtomRegistry.make();
        const container = window.document.createElement("div");
        const root = createRoot(container);
        try {
          yield* Effect.tryPromise(() =>
            reactWork(() =>
              root.render(
                createElement(
                  RegistryContext.Provider,
                  { value: registry },
                  createElement(PlanningProbe, {
                    client,
                    onSaved,
                    month: "2026-10",
                    profileStale: false,
                    duplicate: false,
                  })
                )
              )
            )
          );
          const pause = container.querySelector("button");
          if (pause === null) throw new Error("Missing pause action");
          yield* Effect.tryPromise(() => reactAssertion(() => expect(pause.disabled).toBe(false)));
          yield* Effect.tryPromise(() => reactWork(() => pause.click()));
          expect(container.textContent).toContain("saving");
          expect(container.textContent).not.toContain("Internet QA:pause");
          yield* Effect.tryPromise(() => settleSave(reply, outcome));
          const expected = outcome === "confirmed" ? "idleInternet QA:pause" : outcome;
          yield* Effect.tryPromise(() =>
            reactAssertion(() => expect(container.textContent).toContain(expected))
          );
          expect(onSaved).not.toHaveBeenCalled();
          if (outcome === "confirmed") {
            yield* Effect.tryPromise(() => failReread(reread.current));
            yield* Effect.tryPromise(() => reactAssertion(() => expect(pause.disabled).toBe(true)));
            expect(onSaved).not.toHaveBeenCalled();
            reread.current = Deferred.makeUnsafe<Response>();
            yield* Effect.tryPromise(() =>
              reactWork(() => container.querySelectorAll("button")[1]?.click())
            );
            yield* Effect.tryPromise(() => settleReread(reread.current));
            yield* Effect.tryPromise(() =>
              reactAssertion(() => expect(onSaved).toHaveBeenCalledOnce())
            );
          }
          if (outcome !== "confirmed") {
            expect(container.textContent).not.toContain("Internet QA:pause");
          }
          if (outcome === "uncertain") expect(pause.disabled).toBe(true);
        } finally {
          yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
          registry.dispose();
          vi.unstubAllGlobals();
        }
      })
    )
);

const planningHttp = (
  reply: Deferred.Deferred<Response>,
  reread: { current: Deferred.Deferred<Response> }
): HttpClient.HttpClient => {
  let submitted = false;
  return HttpClient.make((request) => {
    if (request.method === "POST") submitted = true;
    const response = ((): Effect.Effect<Response> => {
      if (request.method === "POST") return Deferred.await(reply);
      if (request.url.endsWith("/categories")) {
        return Effect.succeed(Response.json({ data: [], next: [] }));
      }
      return submitted
        ? Deferred.await(reread.current)
        : Effect.succeed(Response.json({ data: workspace, next: [] }));
    })();
    return Effect.map(response, (value) => HttpClientResponse.fromWeb(request, value));
  });
};
const failReread = (reply: Deferred.Deferred<Response>): Promise<void> =>
  Promise.resolve(
    act(() => Effect.runPromise(Deferred.succeed(reply, Response.json({}))).then(() => undefined))
  );
const settleReread = (reply: Deferred.Deferred<Response>): Promise<void> =>
  Promise.resolve(
    act(() =>
      Effect.runPromise(
        Deferred.succeed(
          reply,
          Response.json({
            data: { ...workspace, document: { ...document, revision: 1 } },
            next: [],
          })
        )
      ).then(() => undefined)
    )
  );

const reactWork = (work: () => void): Promise<void> =>
  Promise.resolve(act(() => Promise.resolve(work())));
const reactAssertion = (assertion: () => void): Promise<void> =>
  Promise.resolve(act(() => vi.waitFor(assertion)));
const settleSave = (reply: Deferred.Deferred<Response>, outcome: Outcome): Promise<void> =>
  Promise.resolve(
    act(() =>
      Effect.runPromise(Deferred.succeed(reply, saveResponse(outcome))).then(() => undefined)
    )
  );

it("retains equivalent mounted Recurring queries through collection and rerender while separating months", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      const http = HttpClient.make((request) => {
        reads += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: {
                document: {
                  revision: 0,
                  plans: [],
                  exceptions: [],
                  fulfillments: [],
                  excludedTransactionIds: [],
                  suggestions: [],
                },
                month: "2026-10",
                today: "2026-10-29",
                occurrences: [],
                previous: [],
                summary: [],
                linkedTransactions: [],
                invalidFulfillmentIds: [],
                matches: [],
                matchesComplete: true,
              },
              next: [],
            })
          )
        );
      });
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, http),
      });
      const registry = AtomRegistry.make();
      const { source, view } = recurringWorkspaceQuery({
        apiClient: client,
        query: { month: "2026-10", view: "compact" },
      });
      const mounts = [registry.mount(view)];
      try {
        yield* AtomRegistry.getResult(registry, view);
        expect(reads).toBe(1);
        for (let turn = 0; turn < 5; turn += 1) {
          yield* Effect.sleep("20 millis");
          Bun.gc(true);
        }
        const now = yield* Clock.currentTimeMillis;
        vi.spyOn(Date, "now").mockReturnValue(now + 6000);
        const rerendered = recurringWorkspaceQuery({
          apiClient: client,
          query: { month: "2026-10", view: "compact" },
        });
        expect(rerendered.source).toBe(source);
        expect(rerendered.view).toBe(view);
        expect(
          recurringWorkspaceQuery({
            apiClient: client,
            query: { month: "2026-11", view: "compact" },
          }).view
        ).not.toBe(view);
        mounts.push(registry.mount(rerendered.view));
        yield* Effect.sleep("30 millis");
        expect(reads).toBe(1);
      } finally {
        vi.restoreAllMocks();
        for (const unmount of mounts) unmount();
        registry.dispose();
      }
    })
  ));

// The same rendered controller seam drives navigation, explicit recovery and saved feedback.
it("snapshots one exact edit before dispatch and contains a throwing visible callback", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const reply = Deferred.makeUnsafe<Response>();
      const reread = { current: Deferred.makeUnsafe<Response>() };
      const requests: string[] = [];
      const base = planningHttp(reply, reread);
      const http = HttpClient.make((request) => {
        if (request.method === "POST" && request.body._tag === "Uint8Array") {
          requests.push(new TextDecoder().decode(request.body.body));
        }
        return base.execute(request);
      });
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, http),
      });
      const registry = AtomRegistry.make();
      const container = window.document.createElement("div");
      const root = createRoot(container);
      const onSaved = vi.fn(() => {
        throw new Error("Broken presentation callback");
      });
      try {
        yield* Effect.tryPromise(() =>
          reactWork(() =>
            root.render(
              createElement(
                RegistryContext.Provider,
                { value: registry },
                createElement(PlanningProbe, {
                  client,
                  onSaved,
                  month: "2026-10",
                  profileStale: false,
                  duplicate: true,
                })
              )
            )
          )
        );
        const pause = container.querySelector("button");
        if (pause === null) throw new Error("Missing pause action");
        yield* Effect.tryPromise(() => reactAssertion(() => expect(pause.disabled).toBe(false)));
        yield* Effect.tryPromise(() => reactWork(() => pause.click()));
        yield* Effect.tryPromise(() => reactAssertion(() => expect(requests).toHaveLength(1)));
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(requests[0] ?? "")
        ).toMatchObject({
          expectedRevision: 0,
          edit: { action: "pause" },
        });
        yield* Effect.tryPromise(() => settleSave(reply, "confirmed"));
        yield* Effect.tryPromise(() => settleReread(reread.current));
        yield* Effect.tryPromise(() =>
          reactAssertion(() => expect(onSaved).toHaveBeenCalledOnce())
        );
        expect(container.textContent).toContain("idleInternet QA:pause");
      } finally {
        yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
        registry.dispose();
        vi.unstubAllGlobals();
      }
    })
  ));

it.each(["confirmed", "uncertain"] as const)(
  "keeps the originating receipt separate from navigation and explicit recovery: %s",
  (outcome) =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        const reply = Deferred.makeUnsafe<Response>();
        const origin = { current: Deferred.makeUnsafe<Response>() };
        let submitted = false;
        let writes = 0;
        let categoryFailure = false;
        const http = HttpClient.make((request) => {
          if (request.method === "POST") {
            submitted = true;
            writes += 1;
          }
          const response = ((): Effect.Effect<Response> => {
            if (request.method === "POST") return Deferred.await(reply);
            if (request.url.endsWith("/categories")) {
              return Effect.succeed(Response.json(categoryFailure ? {} : { data: [], next: [] }));
            }
            if (submitted && new Map(request.urlParams).get("month") === "2026-10") {
              return Deferred.await(origin.current);
            }
            return Effect.succeed(
              Response.json({
                data: {
                  ...workspace,
                  document: { ...document, revision: submitted && outcome === "confirmed" ? 9 : 0 },
                },
                next: [],
              })
            );
          })();
          return Effect.map(response, (value) => HttpClientResponse.fromWeb(request, value));
        });
        const client = makeFidyClient({
          apiOrigin: "https://api.test.fidyapp.com",
          httpClient: Layer.succeed(HttpClient.HttpClient, http),
        });
        const registry = AtomRegistry.make();
        const container = window.document.createElement("div");
        const root = createRoot(container);
        const onSaved = vi.fn();
        const render = (month: string, profileStale = false): Promise<void> =>
          reactWork(() =>
            root.render(
              createElement(
                RegistryContext.Provider,
                { value: registry },
                createElement(PlanningProbe, {
                  client,
                  onSaved,
                  month,
                  profileStale,
                  duplicate: false,
                })
              )
            )
          );
        const pause = (): HTMLButtonElement => {
          const button = container.querySelector("button");
          if (button === null) throw new Error("Missing pause action");
          return button;
        };
        try {
          yield* Effect.tryPromise(() => render("2026-10"));
          yield* Effect.tryPromise(() =>
            reactAssertion(() => expect(pause().disabled).toBe(false))
          );
          yield* Effect.tryPromise(() => reactWork(() => pause().click()));
          yield* Effect.tryPromise(() => render("2026-11"));
          yield* Effect.tryPromise(() => settleSave(reply, outcome));
          yield* Effect.tryPromise(() =>
            reactAssertion(() =>
              expect(container.textContent).toContain(
                outcome === "confirmed" ? "Internet QA:pause" : "uncertain"
              )
            )
          );
          expect(onSaved).not.toHaveBeenCalled();
          expect(writes).toBe(1);
          if (outcome === "confirmed") {
            // A successful replacement-month read at revision nine cannot complete October's receipt.
            yield* Effect.tryPromise(() =>
              reactWork(() => container.querySelectorAll("button")[1]?.click())
            );
            yield* Effect.tryPromise(() =>
              reactAssertion(() => expect(pause().disabled).toBe(false))
            );
            expect(onSaved).not.toHaveBeenCalled();
            yield* Effect.tryPromise(() => settleReread(origin.current));
            yield* Effect.tryPromise(() =>
              reactAssertion(() => expect(onSaved).toHaveBeenCalledOnce())
            );
          } else {
            expect(pause().disabled).toBe(true);
            categoryFailure = true;
            yield* Effect.tryPromise(() =>
              reactWork(() => container.querySelectorAll("button")[1]?.click())
            );
            yield* Effect.tryPromise(() =>
              reactAssertion(() => expect(container.textContent).toContain("uncertain"))
            );
            expect(pause().disabled).toBe(true);
            categoryFailure = false;
            yield* Effect.tryPromise(() => render("2026-11", true));
            yield* Effect.tryPromise(() =>
              reactWork(() => container.querySelectorAll("button")[1]?.click())
            );
            yield* Effect.tryPromise(() =>
              reactAssertion(() => expect(container.textContent).toContain("idle"))
            );
            expect(pause().disabled).toBe(true);
            expect(container.textContent).not.toContain("Internet QA:pause");
            yield* Effect.tryPromise(() => render("2026-11"));
            yield* Effect.tryPromise(() =>
              reactAssertion(() => expect(pause().disabled).toBe(false))
            );
          }
          expect(writes).toBe(1);
        } finally {
          yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
          registry.dispose();
          vi.unstubAllGlobals();
        }
      })
    )
);

const ActionsProbe = ({
  client,
  month,
  stale,
  retain,
}: Readonly<{
  client: ReturnType<typeof makeFidyClient>;
  month: string;
  stale: boolean;
  retain: (planning: ReturnType<typeof useRecurringPlanning>) => void;
}>): ReturnType<typeof createElement> => {
  const planning = useRecurringPlanning({
    apiClient: client,
    query: { month, view: "compact" },
    profileStale: stale,
    profileWaiting: false,
    refreshProfile: () => undefined,
  });
  return createElement(
    "div",
    { ref: planning.mounted },
    createElement("output", { ref: planning.admit }, planning.saveState),
    createElement("span", {
      ref: () => {
        retain(planning);
      },
    })
  );
};
it("rejects obsolete save actions and fences acknowledged completion after disposal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const reply = Deferred.makeUnsafe<Response>();
      const reread = { current: Deferred.makeUnsafe<Response>() };
      let writes = 0;
      const base = planningHttp(reply, reread);
      const http = HttpClient.make((request) => {
        if (request.method === "POST") writes += 1;
        return base.execute(request);
      });
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, http),
      });
      const registry = AtomRegistry.make();
      const root = createRoot(window.document.createElement("div"));
      let planning: Option.Option<ReturnType<typeof useRecurringPlanning>> = Option.none();
      const retain = (current: ReturnType<typeof useRecurringPlanning>): void => {
        planning = Option.some(current);
      };
      const render = (month: string, stale: boolean): Promise<void> =>
        reactWork(() =>
          root.render(
            createElement(
              RegistryContext.Provider,
              { value: registry },
              createElement(ActionsProbe, { client, month, stale, retain })
            )
          )
        );
      const current = (): ReturnType<typeof useRecurringPlanning> => Option.getOrThrow(planning);
      const edit = { kind: "lifecycle", planId, date: "2026-10-29", action: "pause" } as const;
      const onSaved = vi.fn();
      try {
        yield* Effect.tryPromise(() => render("2026-10", false));
        yield* Effect.tryPromise(() =>
          reactAssertion(() => expect(current().disabled).toBe(false))
        );
        const obsolete = current().save;
        yield* Effect.tryPromise(() => render("2026-11", false));
        yield* Effect.tryPromise(() =>
          reactAssertion(() => expect(current().disabled).toBe(false))
        );
        yield* Effect.tryPromise(() => reactWork(() => obsolete(edit, onSaved)));
        expect(writes).toBe(0);
        const formerlyFresh = current().save;
        yield* Effect.tryPromise(() => render("2026-11", true));
        yield* Effect.tryPromise(() => reactWork(() => formerlyFresh(edit, onSaved)));
        expect(writes).toBe(0);
        yield* Effect.tryPromise(() => render("2026-11", false));
        yield* Effect.tryPromise(() =>
          reactWork(() => {
            current().save(edit, onSaved);
            current().save(edit, onSaved);
          })
        );
        yield* Effect.tryPromise(() => reactAssertion(() => expect(writes).toBe(1)));
        yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
        yield* Effect.tryPromise(() => settleSave(reply, "confirmed"));
        yield* Effect.tryPromise(() => settleReread(reread.current));
        expect(onSaved).not.toHaveBeenCalled();
        yield* Effect.tryPromise(() => reactWork(() => current().save(edit, onSaved)));
        expect(writes).toBe(1);
      } finally {
        yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
        registry.dispose();
        vi.unstubAllGlobals();
      }
    })
  ));

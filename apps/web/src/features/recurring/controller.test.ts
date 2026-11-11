// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { Clock, DateTime, Deferred, Effect, Layer, Option, Schema } from "effect";
import { RegistryContext } from "@effect/atom-react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { RecurringPlanId, RecurringPlanInput, makeFidyClient } from "@/transport/client";
import { type Plan, currentPlan, planStatus, planToday } from "./model";
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
}: Readonly<{ client: ReturnType<typeof makeFidyClient>; onSaved: () => void }>): ReturnType<
  typeof createElement
> => {
  const planning = useRecurringPlanning({
    apiClient: client,
    query: { month: "2026-10", view: "compact" },
    profileStale: false,
    profileWaiting: false,
    refreshProfile: () => undefined,
  });
  return createElement(
    "main",
    null,
    createElement(
      "output",
      null,
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
        onClick: () =>
          planning.save(
            { kind: "lifecycle", planId, date: "2026-10-29", action: "pause" },
            onSaved
          ),
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
                  createElement(PlanningProbe, { client, onSaved })
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

it("keeps future lifecycle boundaries and revisions out of today's plan standing in the effective zone", () => {
  vi.useFakeTimers();
  vi.setSystemTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-30T02:00:00Z")));
  try {
    const settings = Schema.decodeUnknownSync(RecurringPlanInput)(
      document.plans[0]?.revisions[0]?.plan
    );
    const plan: Plan = {
      id: planId,
      revisions: [
        {
          from: "2026-10-01",
          plan: {
            ...settings,
            kind: "expense",
            currency: "COP",
            amountMode: "unknown",
            frequency: "monthly",
            timeZone: settings.timeZone,
          },
        },
        {
          from: "2026-11-01",
          plan: {
            ...settings,
            name: "Future settings",
            kind: "expense",
            currency: "COP",
            amountMode: "unknown",
            frequency: "monthly",
            timeZone: Schema.decodeSync(RecurringPlanInput.fields.timeZone)("Asia/Tokyo"),
          },
        },
      ],
      pauses: [{ from: "2026-10-30" }],
      stoppedOn: "2026-11-02",
    };
    expect(planToday(plan)).toBe("2026-10-29");
    expect(planStatus(plan)).toBe("active");
    expect(currentPlan(plan).name).toBe("Internet QA");
    vi.setSystemTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-30T12:00:00Z")));
    expect(planStatus(plan)).toBe("paused");
    vi.setSystemTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-02T12:00:00Z")));
    expect(planStatus(plan)).toBe("stopped");
    expect(currentPlan(plan).name).toBe("Future settings");
    expect(
      planStatus({
        ...plan,
        stoppedOn: undefined,
        pauses: [{ from: "2026-10-30", through: "2026-10-30" }],
      })
    ).toBe("active");
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  {
    now: "2026-11-01T01:00:00Z",
    currentFrom: "2026-10-01",
    futureFrom: "2026-11-01",
    expectedDate: "2026-11-01",
  },
  {
    now: "2026-11-01T16:00:00Z",
    currentFrom: "2026-11-01",
    futureFrom: "2026-11-02",
    expectedDate: "2026-11-02",
  },
])(
  "keeps settings and standing on the same revision across zone boundaries at $now",
  ({ now, currentFrom, futureFrom, expectedDate }) => {
    vi.useFakeTimers();
    vi.setSystemTime(DateTime.toEpochMillis(DateTime.makeUnsafe(now)));
    try {
      const settings = Schema.decodeUnknownSync(RecurringPlanInput)(
        document.plans[0]?.revisions[0]?.plan
      );
      const plan: Plan = {
        id: planId,
        pauses: [],
        revisions: [
          {
            from: currentFrom,
            plan: {
              ...settings,
              name: "Current Tokyo",
              firstDate: currentFrom,
              timeZone: Schema.decodeSync(RecurringPlanInput.fields.timeZone)("Asia/Tokyo"),
            },
          },
          { from: futureFrom, plan: { ...settings, name: "Future Bogota", firstDate: futureFrom } },
        ],
      };
      expect(planToday(plan)).toBe(expectedDate);
      expect(currentPlan(plan).name).toBe("Current Tokyo");
      expect(planStatus(plan)).toBe("active");
    } finally {
      vi.useRealTimers();
    }
  }
);

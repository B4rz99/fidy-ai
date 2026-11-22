import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { Budget } from "../../src/core/budgets/contract";
import { HostedTurnProcessing, HostedTurnProposal } from "../../src/shell/agent/contract";
import { native, nativeConnectionProfile, nativeHostedPlatform } from "../user-store.test-fixture";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import {
  alice,
  bob,
  category,
  history,
  nativeBrowserWrite,
  nativeTransactionJourney,
  seed,
} from "../financial-user-store.test-fixture";

const checkBatchEffects = Effect.fnUntraced(function* (
  mode: string,
  owner: Effect.Success<ReturnType<typeof seed>>,
  turnId: string
) {
  yield* Effect.gen(function* () {
    expect(
      yield* owner.exec(
        "SELECT count(*) AS n FROM hosted_batch_child_audit WHERE turn_id=? AND outcome='success'",
        turnId
      )
    ).toEqual([{ n: 0 }]);
    expect(
      yield* owner.exec("SELECT count(*) AS n FROM user_documents WHERE kind='dashboard'")
    ).toEqual([{ n: 0 }]);
  }).pipe(
    Effect.when(
      Effect.succeed(mode === "batch-stale" || mode === "batch-absent" || mode === "batch-capacity")
    )
  );

  yield* Effect.gen(function* () {
    expect(
      yield* owner.exec(
        "SELECT count(*) AS n FROM hosted_batch_child_audit WHERE turn_id=? AND outcome<>'success'",
        turnId
      )
    ).toEqual([{ n: 1 }]);
  }).pipe(Effect.when(Effect.succeed(mode === "batch-absent" || mode === "batch-capacity")));

  yield* Effect.gen(function* () {
    expect(
      yield* owner.exec("SELECT count(*) AS n FROM user_documents WHERE kind='dashboard'")
    ).toEqual([{ n: 1 }]);
    expect(
      yield* owner.exec(
        "SELECT operation,outcome FROM hosted_batch_child_audit WHERE turn_id=? ORDER BY position",
        turnId
      )
    ).toEqual([
      { operation: "memory.forget", outcome: "success" },
      { operation: "dashboard.initializeDashboard", outcome: "success" },
      { operation: "ingestion.enableEmailForwarding", outcome: "success" },
    ]);
  }).pipe(Effect.when(Effect.succeed(mode === "batch")));
});

const financialQueries = [
  ["budgets__listBudgets", {}],
  ["budgets__getBudget", { params: { id: alice.user } }],
  ["budgets__getBudgetStatus", { query: { timeZone: "America/Bogota" } }],
  ["dashboard__listDashboardCatalog", {}],
  ["dashboard__getDashboard", {}],
  ["dashboard__getDashboardView", {}],
  ["recurring__listRecurringSeries", { query: {} }],
  ["recurringPlans__getRecurringWorkspace", { query: { month: "2026-10", view: "compact" } }],
] as const;

const accountQueries = [
  ["subscription__getSubscriptionStatus", {}],
  ["subscription__getUpgradeUrl", {}],
  ["subscription__listSubscriptionOffers", {}],
  ["ingestion__getEmailForwarding", {}],
  ["ingestion__getReviewWorkspace", { query: {} }],
  ["ingestion__getReviewItem", { params: { id: alice.user } }],
  ["insights__getRecurringDigestReport", { params: { id: alice.user } }],
  ["pats__listPATs", {}],
  ["pats__getPATActivity", { params: { shortId: "abcdefgh" } }],
] as const;

const queryCases = (mode: string): typeof financialQueries | typeof accountQueries =>
  mode === "planning" ? financialQueries : accountQueries;

type HostedRuntime = Parameters<typeof seed>[0];

type HostedProvider = ReturnType<
  Awaited<ReturnType<HostedRuntime["getDurableObjectNamespace"]>>["getByName"]
>;

const prepareQueries = Effect.fnUntraced(function* (
  mode: string,
  {
    runtime,
    owner,
    provider,
  }: {
    runtime: HostedRuntime;
    owner: Effect.Success<ReturnType<typeof seed>>;
    provider: HostedProvider;
  }
) {
  if (!["planning", "account"].includes(mode)) return;

  if (mode === "planning") yield* preparePublishedSeries(owner);

  const initialized = yield* native(() =>
    runtime.dispatchFetch("https://api.fidyapp.com/dashboard/initialize", {
      method: "POST",
      headers: {
        origin: "https://app.fidyapp.com",
        cookie: "__Host-fidy_session=" + alice.bearer,
        "Fidy-Session-Binding": alice.session,
      },
    })
  );

  expect(initialized.status).toBe(200);
  yield* native(() => initialized.arrayBuffer());
  yield* native(() =>
    provider.fetch("https://fixture.invalid/tools", {
      method: "POST",
      body: JSON.stringify(
        queryCases(mode).map(([name, args]) => ({ name, arguments: JSON.stringify(args) }))
      ),
    })
  );
});

const preparePublishedSeries = Effect.fnUntraced(function* (
  owner: Effect.Success<ReturnType<typeof seed>>
) {
  const stamp = "2025-01-15T12:00:00.000Z";

  const series = {
    counterparty: "Recorded",
    money: { amount: "10", currency: "COP" },
    cadence: { kind: "monthly" },
    firstOccurredAt: stamp,
    lastOccurredAt: stamp,
    confirmedAt: stamp,
    announcement: { kind: "suppressed", reason: "backfill" },
  };

  yield* owner.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<33), rows AS(SELECT printf('40000000-0000-4000-8000-%012d',i) AS id,printf('Merchant %03d',i) AS label FROM n) INSERT INTO recurring_series(user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid) SELECT ?,id,'COP',label,json_set(?,'$.id',id,'$.counterparty',label),'{}','{}',1 FROM rows`,
    alice.user,
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(series)
  );
  yield* owner.exec(
    "INSERT OR REPLACE INTO transaction_projection_state(user_id,version,readiness,fact_revision,first_captured_at_ms,time_zone) VALUES(?,1,'ready',33,0,'America/Bogota')",
    alice.user
  );
  yield* owner.exec(
    "INSERT INTO recurring_evaluation_records(user_id,kind,id,group_key,revision,phase,cursor_id,evaluated_at_ms,evaluated_revision,first_captured_at_ms,time_zone) VALUES(?,'progress','progress','',33,'complete','',0,33,0,'America/Bogota')",
    alice.user
  );
});

const comparePublishedSeries = Effect.fnUntraced(function* (
  owner: Effect.Success<ReturnType<typeof seed>>,
  runtime: HostedRuntime
) {
  const page = yield* native(() =>
    runtime.dispatchFetch("https://api.fidyapp.com/recurring-series", {
      headers: {
        origin: "https://app.fidyapp.com",
        cookie: "__Host-fidy_session=" + alice.bearer,
        "Fidy-Session-Binding": alice.session,
      },
    })
  );

  expect(page.status).toBe(200);

  const publicData = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      data: Schema.Struct({
        series: Schema.Array(Schema.Unknown),
        evaluation: Schema.Unknown,
        cursor: Schema.String,
      }),
    })
  )(yield* native(() => page.json()));

  expect(publicData.data.series).toHaveLength(32);

  const [record] = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ page: Schema.fromJsonString(Schema.Unknown) }))
  )(
    yield* owner.exec(
      "SELECT json_extract(entry_json,'$.outcome.output.data') AS page FROM hosted_transcript WHERE json_extract(entry_json,'$.operation')='recurring.listRecurringSeries' AND json_extract(entry_json,'$._tag')='CanonicalToolResultEntry'"
    )
  );

  expect(record?.page).toEqual(publicData.data);
});

const verifyQueryTools = Effect.fnUntraced(function* (
  mode: string,
  proposal: typeof HostedTurnProposal.Type,
  {
    owner,
    provider,
    runtime,
  }: {
    owner: Effect.Success<ReturnType<typeof seed>>;
    provider: HostedProvider;
    runtime: HostedRuntime;
  }
) {
  yield* Effect.gen(function* () {
    if (mode === "planning") yield* comparePublishedSeries(owner, runtime);
    const listing = yield* native(() => provider.fetch("https://fixture.invalid/tools"));
    expect(yield* native(() => listing.json())).toEqual(
      expect.arrayContaining(queryCases(mode).map(([name]) => name))
    );

    const results = yield* owner.exec(
      "SELECT operation,outcome FROM hosted_tool_calls ORDER BY operation"
    );

    expect(results).toEqual(
      queryCases(mode)
        .map(([name]) => ({
          operation: name.replace("__", "."),
          outcome: [
            "budgets__getBudget",
            "ingestion__getReviewItem",
            "insights__getRecurringDigestReport",
            "pats__getPATActivity",
          ].includes(name)
            ? "CanonicalOperationFailed"
            : "Succeeded",
        }))
        .sort((left, right) => left.operation.localeCompare(right.operation, "en-US"))
    );

    yield* Effect.gen(function* () {
      expect(
        yield* owner.exec(
          "SELECT json_extract(entry_json,'$.outcome.output.data.url') AS url FROM hosted_transcript WHERE json_extract(entry_json,'$.operation')='subscription.getUpgradeUrl' AND json_extract(entry_json,'$._tag')='CanonicalToolResultEntry'"
        )
      ).toEqual([{ url: "https://app.fidyapp.com/upgrade" }]);
      expect(
        yield* owner.exec(
          "SELECT operation,outcome FROM audit_entries WHERE hosted_turn_id IS NOT NULL AND user_id=? ORDER BY operation",
          alice.user
        )
      ).toEqual([
        { operation: "pats.getPATActivity", outcome: "rejected" },
        { operation: "pats.listPATs", outcome: "accepted" },
      ]);
    }).pipe(Effect.when(Effect.succeed(mode === "account")));
  }).pipe(Effect.when(Effect.succeed(["planning", "account"].includes(mode))));

  if (["planning", "account"].includes(mode)) return true;

  yield* Effect.gen(function* () {
    expect(proposal.text).toMatch(/https:\/\/app\.fidyapp\.com\/connections\/continue\?attempt=/u);
    expect(yield* owner.exec("SELECT public_reference FROM connection_attempts")).toEqual([
      { public_reference: proposal.text.split("attempt=")[1] },
    ]);
    expect(
      yield* owner.exec(
        "SELECT json_extract(entry_json,'$.outcome.output.data[0].availability') AS availability FROM hosted_transcript WHERE json_extract(entry_json,'$.operation')='connections.listInstitutions' AND json_extract(entry_json,'$._tag')='CanonicalToolResultEntry'"
      )
    ).toEqual([{ availability: "available" }]);
    const state = yield* native(() => provider.fetch("https://fixture.invalid/waiting"));
    expect(yield* native(() => state.json())).toMatchObject({ rounds: 1 });
  }).pipe(Effect.when(Effect.succeed(mode === "connection")));

  if (mode === "connection") return true;

  return false;
});

const hostedSetup = Effect.fnUntraced(function* () {
  const create = yield* nativeHostedPlatform;

  const runtime = yield* create(undefined, [], {
    BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: yield* nativeConnectionProfile,
  });

  const owner = yield* seed(runtime, alice);
  yield* owner.exec(
    "UPDATE users SET trial_started_at_ms=created_at_ms,trial_ends_at_ms=created_at_ms+604800000 WHERE id=?",
    alice.user
  );
  yield* seed(runtime, bob);

  const disclosure = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
    currentDisclosureFor()
  );

  yield* owner.exec(
    "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
    bob.user,
    alice.user,
    owner.now,
    disclosure
  );

  const send = (subject: typeof alice, path: string, body: unknown): Effect.Effect<Response> =>
    Effect.gen(function* () {
      const reply = yield* native(() =>
        runtime.dispatchFetch("https://api.fidyapp.com" + path, {
          method: "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: "__Host-fidy_session=" + subject.bearer,
            "Fidy-Session-Binding": subject.session,
            "content-type": "application/json",
          },
          body: body === undefined ? null : JSON.stringify(body),
        })
      );

      return new Response(yield* native(() => reply.text()), { status: reply.status });
    });

  const post = (subject: typeof alice, path: string, body: unknown): Effect.Effect<Response> =>
    send(subject, "/web/hosted-turns" + path, body);

  const controls = yield* native(() =>
    runtime.getDurableObjectNamespace("CONTROL", "hosted-provider")
  );

  const provider = controls.getByName("provider");

  return { owner, post, provider, runtime, send };
});

const nativeTurnJourney = Effect.fnUntraced(function* (
  mode:
    | "account"
    | "planning"
    | "ordinary"
    | "confirm"
    | "stale"
    | "withdraw"
    | "connection"
    | "batch"
    | "batch-stale"
    | "batch-absent"
    | "batch-capacity"
) {
  const { runtime, owner, provider, post } = yield* hostedSetup();

  const providerPath = {
    account: "waiting",
    planning: "waiting",
    connection: "connect",
    batch: "batch",
    "batch-stale": "batch",
    "batch-absent": "batch",
    "batch-capacity": "batch-capacity",
    confirm: "forget",
    stale: "forget",
    withdraw: "waiting",
    ordinary: "waiting",
  }[mode];

  yield* native(() => provider.fetch("https://fixture.invalid/" + providerPath));
  yield* prepareQueries(mode, { runtime, owner, provider });
  const id = "22460000-0000-4000-8000-000000000020";

  if (mode === "batch-capacity") {
    yield* Effect.forEach(
      Array.from({ length: 7 }, (_, index) => index),
      (index) =>
        owner.exec(
          "INSERT INTO memories VALUES(?,?,?,?,?)",
          `84000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          alice.user,
          "x".repeat(2_000),
          owner.now,
          owner.now
        ),
      { discard: true }
    );
    yield* owner.exec(
      "INSERT INTO memories VALUES(?,?,'short',?,?)",
      id,
      alice.user,
      owner.now,
      owner.now
    );
  } else if (["confirm", "stale", "batch", "batch-stale", "batch-absent"].includes(mode)) {
    yield* owner.exec(
      "INSERT INTO memories VALUES(?,?,'Preparo almuerzos',?,?)",
      id,
      alice.user,
      owner.now,
      owner.now
    );
  }

  if (mode === "ordinary") {
    yield* owner.exec("ALTER TABLE reminder_schedules RENAME TO unavailable_reminder_schedules");
  }

  const admitted = yield* post(alice, "", { text: "¿Qué recuerdas?" });
  expect(admitted.status).toBe(202);

  const identity = yield* Schema.decodeUnknownEffect(HostedTurnProcessing)(
    yield* native(() => admitted.json())
  );

  yield* Effect.retry(
    Effect.gen(function* () {
      const state = yield* native(() => provider.fetch("https://fixture.invalid/waiting"));

      const value = yield* Schema.decodeUnknownEffect(Schema.Struct({ waiting: Schema.Boolean }))(
        yield* native(() => state.json())
      );

      if (!value.waiting) return yield* Effect.fail("provider_not_waiting");
    }),
    { times: 40, schedule: Schedule.spaced("50 millis") }
  );
  expect((yield* history(runtime, alice)).status).toBe(200);
  expect((yield* post(alice, "", { text: "Otra consulta" })).status).toBe(409);
  expect((yield* post(bob, "/progress", { turnId: identity.turnId })).status).toBe(401);

  if (mode === "withdraw") {
    yield* owner.exec(
      "INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms) VALUES(?,?,'processing_withdrawal',?,?,?)",
      id,
      alice.user,
      bob.user,
      alice.session,
      owner.now
    );
  }

  yield* native(() => provider.fetch("https://fixture.invalid/release"));

  const proposal = yield* Effect.retry(
    Effect.gen(function* () {
      const reply = yield* post(alice, "/progress", { turnId: identity.turnId });

      return yield* Schema.decodeUnknownEffect(HostedTurnProposal)(
        yield* native(() => reply.json())
      );
    }),
    { times: 50, schedule: Schedule.spaced("50 millis") }
  );

  yield* Effect.sync(() => expect(proposal.text).toBe("Listo.")).pipe(
    Effect.when(Effect.succeed(["ordinary", "withdraw"].includes(mode)))
  );
  const redelivery = yield* post(alice, "/progress", { turnId: identity.turnId });
  expect(yield* native(() => redelivery.json())).toMatchObject({
    receipt: proposal.receipt,
    text: proposal.text,
  });

  const delivered = yield* post(alice, "/delivery", {
    turnId: identity.turnId,
    receipt: proposal.receipt,
  });

  expect(delivered.status).toBe(200);

  if (yield* verifyQueryTools(mode, proposal, { owner, provider, runtime })) return;

  yield* Effect.gen(function* () {
    expect(yield* owner.exec("SELECT outcome FROM hosted_tool_calls")).toEqual([
      { outcome: "CanonicalOperationFailed" },
    ]);
    expect((yield* post(alice, "", { text: "Otro turno" })).status).toBe(403);
  }).pipe(Effect.when(Effect.succeed(mode === "withdraw")));

  if (mode === "withdraw") return;

  const assertReviewed = Effect.fnUntraced(function* () {
    yield* Effect.sync(() => expect(proposal.text).toContain("Preparo almuerzos")).pipe(
      Effect.when(Effect.succeed(mode !== "batch-capacity"))
    );

    expect(proposal.confirmation?.command).toMatch(/^CONFIRMAR [a-f0-9]{64}$/u);
    expect(yield* owner.exec("SELECT count(*) AS n FROM memories")).toEqual([
      { n: mode === "batch-capacity" ? 8 : 1 },
    ]);

    if (["stale", "batch-stale"].includes(mode)) {
      yield* owner.exec("UPDATE memories SET text='Estado nuevo' WHERE id=?", id);
    }

    yield* Effect.gen(function* () {
      expect(proposal.text).toContain("Activar tu dirección de correo");
      expect(
        yield* owner.exec("SELECT count(*) AS n FROM user_documents WHERE kind='dashboard'")
      ).toEqual([{ n: 0 }]);
    }).pipe(Effect.when(Effect.succeed(mode.startsWith("batch") && mode !== "batch-capacity")));

    yield* owner
      .exec("DELETE FROM memories WHERE id=?", id)
      .pipe(Effect.when(Effect.succeed(mode === "batch-absent")));

    const confirmed = yield* post(alice, "", { text: proposal.confirmation?.command });

    const accepted = yield* Schema.decodeUnknownEffect(HostedTurnProcessing)(
      yield* native(() => confirmed.json())
    );

    yield* Effect.retry(
      Effect.gen(function* () {
        const res = yield* post(alice, "/progress", { turnId: accepted.turnId });

        return yield* Schema.decodeUnknownEffect(HostedTurnProposal)(
          yield* native(() => res.json())
        );
      }),
      { times: 50, schedule: Schedule.spaced("50 millis") }
    );

    const expectedMemories =
      new Map([
        ["batch-capacity", 8],
        ["stale", 1],
        ["batch-stale", 1],
      ]).get(mode) ?? 0;

    expect(yield* owner.exec("SELECT count(*) AS n FROM memories")).toEqual([
      { n: expectedMemories },
    ]);
    yield* checkBatchEffects(mode, owner, accepted.turnId);
    expect(
      yield* owner.exec("SELECT outcome FROM hosted_tool_calls WHERE turn_id=?", accepted.turnId)
    ).toEqual([
      {
        outcome: ["stale", "batch-stale", "batch-absent", "batch-capacity"].includes(mode)
          ? "CanonicalOperationFailed"
          : "Succeeded",
      },
    ]);
  });

  if (
    ["confirm", "stale", "batch", "batch-stale", "batch-absent", "batch-capacity"].includes(mode)
  ) {
    return yield* assertReviewed();
  }

  yield* owner.exec("ALTER TABLE unavailable_reminder_schedules RENAME TO reminder_schedules");
  expect(
    yield* owner.exec(
      "SELECT json_extract(entry_json,'$._tag') AS entry FROM hosted_transcript ORDER BY sequence"
    )
  ).toEqual([
    { entry: "UserTranscriptEntry" },
    { entry: "CanonicalToolCallEntry" },
    { entry: "CanonicalToolResultEntry" },
    { entry: "AssistantTranscriptEntry" },
  ]);
  yield* owner.exec(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<80) INSERT INTO hosted_transcript(session_id,turn_id,entry_json) SELECT t.session_id,t.id,json_object('_tag','UserTranscriptEntry','id',printf('90000000-0000-4000-8000-%012d',i),'turnId',t.id,'occurredAt','2026-09-01T10:00:00.000Z','text','Registro') FROM n JOIN hosted_turns t ON t.id=?",
    identity.turnId
  );
  yield* owner.exec(
    "UPDATE hosted_agent_sessions SET basis_json=json_set(basis_json,'$.policyRevision','earlier-policy')"
  );
  const again = yield* post(alice, "", { text: "Continuar" });

  const later = yield* Schema.decodeUnknownEffect(HostedTurnProcessing)(
    yield* native(() => again.json())
  );

  yield* Effect.retry(
    Effect.gen(function* () {
      const reply = yield* post(alice, "/progress", { turnId: later.turnId });

      return yield* Schema.decodeUnknownEffect(HostedTurnProposal)(
        yield* native(() => reply.json())
      );
    }),
    { times: 50, schedule: Schedule.spaced("50 millis") }
  );
  expect(yield* owner.exec("SELECT compacted_text FROM hosted_agent_sessions")).toEqual([
    { compacted_text: "Resumen anterior." },
  ]);
  expect(
    yield* owner.exec(
      "SELECT count(*) AS original FROM hosted_transcript WHERE turn_id=?",
      identity.turnId
    )
  ).toEqual([{ original: 0 }]);
});

const turnCycle = Effect.fnUntraced(function* ({
  post,
  provider,
  text,
  tools,
}: Readonly<{
  post: (subject: typeof alice, path: string, body: unknown) => Effect.Effect<Response>;
  provider: HostedProvider;
  text: string;
  tools: ReadonlyArray<Readonly<{ name: string; arguments: unknown }>>;
}>) {
  yield* native(() =>
    provider.fetch("https://fixture.invalid/tools", {
      method: "POST",
      body: JSON.stringify(
        tools.map((tool) => ({ name: tool.name, arguments: JSON.stringify(tool.arguments) }))
      ),
    })
  );

  const admitted = yield* post(alice, "", { text });
  expect(admitted.status).toBe(202);

  const identity = yield* Schema.decodeUnknownEffect(HostedTurnProcessing)(
    yield* native(() => admitted.json())
  );

  const proposal = yield* Effect.retry(
    Effect.gen(function* () {
      const reply = yield* post(alice, "/progress", { turnId: identity.turnId });

      return yield* Schema.decodeUnknownEffect(HostedTurnProposal)(
        yield* native(() => reply.json())
      );
    }),
    { times: 50, schedule: Schedule.spaced("50 millis") }
  );

  const delivered = yield* post(alice, "/delivery", {
    turnId: identity.turnId,
    receipt: proposal.receipt,
  });

  expect(delivered.status).toBe(200);

  return proposal;
});

const confirmCycle = Effect.fnUntraced(function* (
  post: (subject: typeof alice, path: string, body: unknown) => Effect.Effect<Response>,
  proposal: typeof HostedTurnProposal.Type
) {
  expect(proposal.confirmation?.command).toMatch(/^CONFIRMAR [a-f0-9]{64}$/u);

  const confirmed = yield* post(alice, "", { text: proposal.confirmation?.command });

  const accepted = yield* Schema.decodeUnknownEffect(HostedTurnProcessing)(
    yield* native(() => confirmed.json())
  );

  const settled = yield* Effect.retry(
    Effect.gen(function* () {
      const reply = yield* post(alice, "/progress", { turnId: accepted.turnId });

      return yield* Schema.decodeUnknownEffect(HostedTurnProposal)(
        yield* native(() => reply.json())
      );
    }),
    { times: 50, schedule: Schedule.spaced("50 millis") }
  );

  const delivered = yield* post(alice, "/delivery", {
    turnId: accepted.turnId,
    receipt: settled.receipt,
  });

  expect(delivered.status).toBe(200);

  return settled;
});

const budgetConfirmationJourney = Effect.fnUntraced(function* () {
  const { owner, post, provider, send } = yield* hostedSetup();

  const created = yield* send(alice, "/budgets", {
    categoryId: category,
    cap: { amount: "2000000", currency: "COP" },
  });

  expect(created.status).toBe(201);

  const { data } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.toCodecJson(Budget) })
  )(yield* native(() => created.json()));

  yield* native(() => provider.fetch("https://fixture.invalid/release"));

  const vivienda = "10000000-0000-4000-8000-000000000005";

  const proposal = yield* turnCycle({
    post,
    provider,
    text: "Cambia el presupuesto",
    tools: [
      {
        name: "budgets__updateBudget",
        arguments: {
          params: { id: data.id },
          payload: {
            categoryId: vivienda,
            cap: { amount: "9999999", currency: "COP" },
            month: "2026-12",
          },
        },
      },
    ],
  });

  expect(proposal.text).toContain(
    `Cambiar el presupuesto ${data.id}, categoría Otros, límite actual 2.000.000 pesos.`
  );
  expect(proposal.text).toContain(
    "Nuevo presupuesto: Vivienda, de 9.999.999 pesos para diciembre de 2026"
  );

  yield* confirmCycle(post, proposal);

  expect(yield* owner.exec("SELECT category_id,cap FROM budgets WHERE id=?", data.id)).toEqual([
    { category_id: vivienda, cap: "2000000" },
  ]);
  expect(
    yield* owner.exec(
      "SELECT month,cap FROM budget_month_plan_records WHERE kind='cap' AND budget_id=?",
      data.id
    )
  ).toEqual([{ month: "2026-12", cap: "9999999" }]);
});

const recurringConfirmationJourney = Effect.fnUntraced(function* () {
  const { owner, post, provider } = yield* hostedSetup();
  yield* preparePublishedSeries(owner);

  yield* native(() => provider.fetch("https://fixture.invalid/release"));

  const plan = {
    name: "Arriendo",
    kind: "expense",
    currency: "COP",
    amountMode: "fixed",
    money: { amount: "1500000", currency: "COP" },
    frequency: "monthly",
    firstDate: "2026-12-01",
    timeZone: "America/Bogota",
    counterparty: "Inversiones Metrópolis",
  };

  const planId = "22460000-0000-4000-8000-000000000030";

  const created = yield* turnCycle({
    post,
    provider,
    text: "Sigue el arriendo",
    tools: [
      {
        name: "recurringPlans__applyRecurringEdit",
        arguments: {
          payload: { edit: { kind: "create", id: planId, plan }, expectedRevision: 0 },
        },
      },
    ],
  });

  expect(created.text).toContain("Crear el compromiso recurrente «Arriendo»");
  expect(created.text).toContain("gasto, 1.500.000 pesos, cada mes, hora de Bogota");
  expect(created.text).toContain("desde el 1 de diciembre de 2026, con «Inversiones Metrópolis»");
  expect(created.text).toContain("No hará pagos por ti.");

  yield* confirmCycle(post, created);

  expect(
    yield* owner.exec("SELECT revision FROM user_documents WHERE kind='recurring-plan'")
  ).toEqual([{ revision: 1 }]);

  const edited = yield* turnCycle({
    post,
    provider,
    text: "Cambia el valor del arriendo",
    tools: [
      {
        name: "recurringPlans__applyRecurringEdit",
        arguments: {
          payload: {
            edit: {
              kind: "edit",
              planId,
              date: "2027-01-01",
              scope: "forward",
              plan: { ...plan, money: { amount: "2000000", currency: "COP" } },
            },
            expectedRevision: 1,
          },
        },
      },
    ],
  });

  expect(edited.text).toContain("Cambiar «Arriendo» a partir de el 1 de enero de 2027");
  expect(edited.text).toContain("Nuevos datos: «Arriendo»: gasto, 2.000.000 pesos, cada mes");

  yield* confirmCycle(post, edited);

  expect(
    yield* owner.exec(
      "SELECT from_date,json_extract(plan_json,'$.money.amount') AS amount FROM recurring_plan_revisions WHERE plan_id=? ORDER BY position",
      planId
    )
  ).toEqual([
    { from_date: "2026-12-01", amount: "1500000" },
    { from_date: "2027-01-01", amount: "2000000" },
  ]);

  const dismissed = yield* turnCycle({
    post,
    provider,
    text: "Oculta esa sugerencia",
    tools: [
      {
        name: "recurringPlans__applyRecurringEdit",
        arguments: {
          payload: {
            edit: {
              kind: "suggestion",
              seriesId: "40000000-0000-4000-8000-000000000001",
              action: "dismiss",
            },
            expectedRevision: 2,
          },
        },
      },
    ],
  });

  expect(dismissed.text).toContain("Ocultar la sugerencia de «Merchant 001», por 10 pesos al mes");
  expect(dismissed.text).toContain("No cancela servicios ni hace pagos.");

  yield* confirmCycle(post, dismissed);

  expect(
    yield* owner.exec(
      "SELECT json_extract(document_json,'$.suggestions[0].disposition') AS disposition FROM user_documents WHERE kind='recurring-plan'"
    )
  ).toEqual([{ disposition: "dismissed" }]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "reads statement, digest and credential metadata under the admitted hosted Turn",
    () => nativeTurnJourney("account")
  );
  test.effect(
    "serves financial queries from a hosted Turn through the caller's native owners",
    () => nativeTurnJourney("planning")
  );
  test.effect(
    "uses the same User-gated Connection owners for institution discovery and the browser handoff in a hosted Turn",
    () => nativeTurnJourney("connection")
  );
  test.effect("consumes a host-issued destructive Memory review only after its delivery", () =>
    nativeTurnJourney("confirm")
  );
  test.effect(
    "confirms a native hosted atomic batch and attributes both children in its Turn",
    () => nativeTurnJourney("batch")
  );
  test.effect("refuses the complete hosted batch when a reviewed child changed", () =>
    nativeTurnJourney("batch-stale")
  );
  test.effect("audits a hosted batch child rejection without committing sibling writes", () =>
    nativeTurnJourney("batch-absent")
  );
  test.effect("audits a commit-time hosted batch child rejection", () =>
    nativeTurnJourney("batch-capacity")
  );
  test.effect("refuses confirmation after the reviewed Memory changes", () =>
    nativeTurnJourney("stale")
  );
  test.effect("rechecks live Consent before a tool returned by a paused provider", () =>
    nativeTurnJourney("withdraw")
  );
  test.effect(
    "rolls back preflight without charging a Turn when the provider configuration is unavailable",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;
        yield* native(() =>
          db.exec(
            "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
            bob.user,
            alice.user,
            0,
            Schema.encodeSync(Schema.fromJsonString(DisclosureSnapshot))(currentDisclosureFor())
          )
        );
        expect(
          (yield* nativeBrowserWrite(db)(alice, {
            path: "/web/hosted-turns",
            method: "POST",
            body: { text: "¿Qué recuerdas?" },
          })).status
        ).toBe(503);
        expect(yield* native(() => db.exec("SELECT count(*) AS n FROM hosted_turns"))).toEqual([
          { n: 0 },
        ]);
        expect(yield* native(() => db.exec("SELECT count(*) AS n FROM hosted_transcript"))).toEqual(
          [{ n: 0 }]
        );
      })
  );
  test.effect("requires an admitted processing Consent basis before opening a hosted Turn", () =>
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* nativeBrowserWrite(db)(alice, {
        method: "POST",
        path: "/web/hosted-turns",
        body: { text: "Mi presupuesto" },
      });

      expect(response.status).toBe(403);
    })
  );

  test.effect(
    "continues hosted work through a failed Reminder recovery, permits unrelated work during inference, and preserves ordered Transcript and Compaction",
    () => nativeTurnJourney("ordinary")
  );

  test.effect(
    "discloses the committed Budget category, cap and month in the hosted confirmation and commits them after redemption",
    () => budgetConfirmationJourney()
  );

  test.effect(
    "discloses the committed recurring plan, amount, cadence, counterparty and edit kind in the hosted confirmation and applies them after redemption",
    () => recurringConfirmationJourney()
  );
});

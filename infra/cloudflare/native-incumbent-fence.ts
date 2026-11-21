import { Effect, Schema } from "effect";
import { type ProviderRead, readProviderList as pages } from "./native-provider-list";

const name = Schema.NonEmptyString;

const success = Schema.Literal(true);

const incumbent = (id: string): boolean => id.startsWith("fidycloudflare-") || id === "fidy-web";

const activeWorkflowStatuses = [
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "rollingBack",
] as const;

const empty = Schema.Struct({ success, result: Schema.Tuple([]) });

const worker = Schema.Struct({ id: name });

const queue = Schema.Struct({
  queue_id: name,
  queue_name: name,
  settings: Schema.optional(Schema.Struct({ delivery_paused: Schema.optional(Schema.Boolean) })),
});

const workflow = Schema.Struct({ name, script_name: name });

const assertNoWriter = Effect.fn(function* (read: ProviderRead, id: string) {
  const path = "workers/scripts/" + id;
  yield* Schema.decodeUnknownEffect(
    Schema.Struct({ success, result: Schema.Struct({ schedules: Schema.Tuple([]) }) })
  )(yield* read(path + "/schedules"));
  yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      success,
      result: Schema.Struct({
        enabled: Schema.Literal(false),
        previews_enabled: Schema.Literal(false),
      }),
    })
  )(yield* read(path + "/subdomain"));
});

export const verifyIncumbentFence = Effect.fn(function* (
  read: ProviderRead,
  phase: "staging" | "retirement" = "staging"
) {
  const scripts = (yield* pages(read, "workers/scripts", worker)).filter((item) =>
    incumbent(item.id)
  );

  if (phase === "staging" && !scripts.some((item) => item.id.startsWith("fidycloudflare-core-"))) {
    return yield* Effect.fail(Error("Incumbent Core inventory is missing"));
  }

  yield* Effect.forEach(scripts, (item) => assertNoWriter(read, item.id), {
    concurrency: 3,
    discard: true,
  });
  const queues = (yield* pages(read, "queues", queue)).filter((item) => incumbent(item.queue_name));

  if (
    (phase === "staging" &&
      !queues.some((item) => item.queue_name.startsWith("fidycloudflare-asyncdeadletters-"))) ||
    queues.some((item) => item.settings?.delivery_paused !== true)
  ) {
    return yield* Effect.fail(Error("Incumbent queues and dead letters must have paused delivery"));
  }

  const workflows = (yield* pages(read, "workflows", workflow)).filter((item) =>
    incumbent(item.script_name)
  );

  yield* Effect.forEach(
    workflows,
    (item) =>
      Effect.forEach(
        activeWorkflowStatuses,
        (status) =>
          read(
            "workflows/" +
              encodeURIComponent(item.name) +
              "/instances?status=" +
              status +
              "&per_page=1"
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(empty))),
        { concurrency: 2, discard: true }
      ),
    { concurrency: 2, discard: true }
  );

  return {
    scripts: scripts.map((item) => item.id),
    pausedQueues: queues.map((item) => ({ name: item.queue_name, id: item.queue_id })),
    quiescentWorkflows: workflows.map((item) => item.name),
  };
});

const emailRule = Schema.Struct({
  enabled: Schema.Boolean,
  actions: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(["drop", "forward", "worker"]),
      value: Schema.optional(Schema.Array(name)),
    })
  ),
});

const deliversToIncumbent = (rule: typeof emailRule.Type, nativeClosed: boolean): boolean =>
  rule.enabled &&
  rule.actions.some(
    (action) =>
      action.type === "worker" &&
      (action.value === undefined ||
        action.value.some((id) => incumbent(id) || (nativeClosed && id === "fidy-native-email")))
  );

export const verifyIncumbentMail = Effect.fn(function* (
  account: ProviderRead,
  zone: ProviderRead,
  phase: "staging" | "retirement" = "staging"
) {
  const path = "email/routing/rules";

  const catchAll = yield* Schema.decodeUnknownEffect(Schema.Struct({ success, result: emailRule }))(
    yield* zone(path + "/catch_all")
  );

  const rules = [
    ...(yield* pages(account, path, emailRule)),
    ...(yield* pages(zone, path, emailRule)),
    catchAll.result,
  ];

  if (rules.some((rule) => deliversToIncumbent(rule, phase === "staging"))) {
    return yield* Effect.fail(Error("Email delivery to the fenced application is enabled"));
  }
});

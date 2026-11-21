import { ownerCheckUrl } from "../maintenance/contract";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Array as Arr, Clock, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { EmailVerificationCode } from "../../src/core/email-authentication/contract";

const setup = Effect.fn(function* (next: string) {
  const logs: string[] = [];
  const runtime = yield* (yield* nativeBrowserPlatform)("1000000000", logs);
  const owner = yield* seed(runtime, alice, false);
  const other = yield* seed(runtime, bob, false);
  const prior = "old@example.test";
  const now = yield* Clock.currentTimeMillis;

  yield* Effect.forEach(
    [
      [owner, alice, prior],
      [other, bob, "other@example.test"],
    ] as const,
    Effect.fnUntraced(function* ([store, subject, address]) {
      yield* store.exec(
        "INSERT INTO verified_email_credentials(user_id,normalized_address,revision,verified_at_ms) VALUES(?,?,1,?)",
        subject.user,
        address,
        now
      );
      yield* native(() =>
        owner.directory.exec(
          "INSERT INTO verified_email_routes VALUES(?,?,?,1)",
          address,
          subject.user,
          subject.session
        )
      );
    }),
    { discard: true }
  );

  const request = (
    subject: typeof alice,
    path: string,
    body: Schema.Json
  ): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
    native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com" + path, {
        method: "POST",
        headers: {
          origin: "https://app.fidyapp.com",
          cookie: "__Host-fidy_session=" + subject.bearer,
          "Fidy-Session-Binding": subject.session,
          connection: "close",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    );

  const start = (): ReturnType<typeof request> =>
    request(alice, "/email/replacement", { candidateEmail: " " + next.toUpperCase() + " " });

  const { FIXTURE_PROVIDER: transport } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );

  const inbox = (): Effect.Effect<ReadonlyArray<string>, Schema.SchemaError> =>
    native(() =>
      transport
        .fetch("https://mailbox.fixture.invalid/?to=" + encodeURIComponent(next))
        .then((response) => response.json())
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.String))));

  const delivered = inbox().pipe(
    Effect.repeat({
      until: (messages) => messages.length > 0,
      times: 40,
      schedule: Schedule.spaced("100 millis"),
    })
  );

  const proof = delivered.pipe(
    Effect.flatMap((messages) =>
      Schema.decodeUnknownEffect(EmailVerificationCode)(messages[0]?.split("\n\n")[1])
    )
  );

  const verify = (
    subject: typeof alice,
    address: string,
    code: EmailVerificationCode
  ): ReturnType<typeof request> =>
    request(subject, "/web/email/replacement/verify", {
      candidateEmail: address,
      combinedCode: code,
    });

  return {
    runtime,
    owner,
    other,
    request,
    verify,
    start,
    inbox,
    delivered,
    proof,
    logs,
    prior,
    next,
    now,
  };
});

const scenario = Effect.gen(function* () {
  const { owner, verify, start, proof, next, prior, inbox } = yield* setup("new+only@example.test");
  expect((yield* start()).status).toBe(200);
  expect((yield* start()).status).toBe(200);
  const code = yield* proof;
  expect(yield* inbox()).toHaveLength(1);
  expect((yield* verify(bob, next, code)).status).toBe(400);
  expect((yield* verify(alice, prior, code)).status).toBe(400);
  const confirmed = yield* verify(alice, next, code);
  expect(confirmed.status).toBe(200);
  expect(yield* native(() => confirmed.json())).toEqual({
    data: { status: "replaced" },
    next: [],
  });
  expect((yield* verify(alice, next, code)).status).toBe(400);
  expect(
    yield* native(() =>
      owner.directory.exec(
        "SELECT normalized_address,revision FROM verified_email_routes WHERE user_id=?",
        alice.user
      )
    )
  ).toEqual([{ normalized_address: next, revision: 2 }]);
  expect(
    yield* owner.exec("SELECT normalized_address,revision FROM verified_email_credentials")
  ).toEqual([{ normalized_address: next, revision: 2 }]);
});

const completionFailures = [
  "revision",
  "commit-revocation",
  "commit-expiry",
  "commit-erasure",
  "commit-freshness",
  "expiry",
  "foreign-owner",
  "revoked",
  "stale-session",
  "evidence",
  "lost-cleanup",
] as const;

type Failure = (typeof completionFailures)[number];

type Owner = Effect.Success<ReturnType<typeof setup>>["owner"];

const changeAfterProof = Effect.fn(function* (failure: Failure, owner: Owner) {
  if (failure === "commit-freshness") {
    yield* owner.exec(
      "CREATE TRIGGER expire_freshness AFTER UPDATE OF state ON email_replacements WHEN NEW.state='proven' BEGIN UPDATE web_sessions SET created_at_ms=created_at_ms-610000,fresh_until_ms=fresh_until_ms-610000,hard_expires_at_ms=hard_expires_at_ms-610000; END"
    );
  }

  if (failure === "commit-erasure") {
    yield* owner.exec(
      "CREATE TRIGGER erase_after_proof AFTER UPDATE OF state ON email_replacements WHEN NEW.state='proven' BEGIN INSERT INTO erasure_requests(id,user_id,state) VALUES('erase',NEW.user_id,'pending'); END"
    );
  }

  if (failure === "commit-revocation") {
    yield* owner.exec(
      "CREATE TRIGGER revoke_after_proof AFTER UPDATE OF state ON email_replacements WHEN NEW.state='proven' BEGIN UPDATE web_sessions SET revoked_at_ms=1; END"
    );
  }

  if (failure === "commit-expiry") {
    yield* owner.exec(
      "CREATE TRIGGER expire_after_proof AFTER UPDATE OF state ON email_replacements WHEN NEW.state='proven' BEGIN UPDATE email_replacements SET expires_at_ms=0 WHERE work_id=NEW.work_id; END"
    );
  }
});

const changeSessionOrWork = Effect.fn(function* (failure: Failure, owner: Owner, now: number) {
  if (failure === "revision") {
    yield* owner.exec("UPDATE verified_email_credentials SET revision=revision+1");
  }

  if (failure === "expiry") {
    yield* owner.exec("UPDATE email_replacements SET expires_at_ms=?", now - 1);
  }

  if (failure === "revoked") yield* owner.exec("UPDATE web_sessions SET revoked_at_ms=?", now);

  if (failure === "stale-session") {
    yield* owner.exec(
      "UPDATE web_sessions SET created_at_ms=created_at_ms-610000,fresh_until_ms=fresh_until_ms-610000,hard_expires_at_ms=hard_expires_at_ms-610000"
    );
  }
});

const changeReservationOrAudit = Effect.fn(function* (
  failure: Failure,
  owner: Owner,
  next: string
) {
  if (failure === "foreign-owner") {
    yield* native(() =>
      owner.directory.exec(
        "INSERT INTO verified_email_routes VALUES(?,?,?,1)",
        next,
        bob.user,
        bob.session
      )
    );
  }

  if (failure === "evidence") {
    yield* owner.exec(
      "CREATE TRIGGER deny_evidence BEFORE INSERT ON audit_entries WHEN NEW.outcome='replaced' BEGIN SELECT RAISE(IGNORE); END"
    );
  }

  if (failure === "lost-cleanup") {
    yield* native(() =>
      owner.directory.exec(
        "CREATE TRIGGER lose_retirement BEFORE DELETE ON verified_email_routes BEGIN SELECT RAISE(ABORT,'lost cleanup'); END"
      )
    );
  }
});

const failedCompletion = Effect.fn(function* (failure: (typeof completionFailures)[number]) {
  const { owner, start, proof, verify, prior, next, now } = yield* setup("candidate@example.test");
  expect((yield* start()).status).toBe(200);
  const code = yield* proof;
  yield* changeAfterProof(failure, owner);
  yield* changeSessionOrWork(failure, owner, now);
  yield* changeReservationOrAudit(failure, owner, next);
  const response = yield* verify(alice, next, code);
  const credential = yield* owner.exec("SELECT normalized_address FROM verified_email_credentials");
  expect(credential).toEqual([{ normalized_address: failure === "lost-cleanup" ? next : prior }]);

  const statuses = {
    revision: 400,
    "commit-revocation": 401,
    "commit-expiry": 400,
    "commit-erasure": 401,
    "commit-freshness": 401,
    expiry: 400,
    "foreign-owner": 400,
    revoked: 401,
    "stale-session": 401,
    evidence: 503,
    "lost-cleanup": 503,
  };

  expect(response.status).toBe(statuses[failure]);

  yield* Effect.gen(function* () {
    expect(yield* owner.exec("SELECT wrong_attempts FROM email_replacements")).toEqual([
      { wrong_attempts: 0 },
    ]);
  }).pipe(Effect.when(Effect.succeed(failure === "revision")));

  yield* Effect.gen(function* () {
    yield* owner.exec("DROP TRIGGER deny_evidence");
    expect((yield* verify(alice, next, code)).status).toBe(200);
  }).pipe(Effect.when(Effect.succeed(failure === "evidence")));

  yield* Effect.gen(function* () {
    expect((yield* verify(alice, next, code)).status).toBe(400);
  }).pipe(Effect.when(Effect.succeed(failure === "lost-cleanup")));
});

const sendOutcomes = ["accepted", "lost", "limited", "unsettled"] as const;

const interruptedDelivery = Effect.fn(function* (outcome: (typeof sendOutcomes)[number]) {
  const { owner, start, proof, verify, inbox, next, logs, runtime } = yield* setup(
    outcome + "@example.test"
  );

  if (outcome === "unsettled") {
    yield* owner.exec(
      "CREATE TRIGGER lose_settlement BEFORE UPDATE OF state ON email_replacements WHEN NEW.state='awaiting_proof' BEGIN SELECT RAISE(ABORT,'lost settlement'); END"
    );
  }

  expect((yield* start()).status).toBe(200);
  const code = yield* proof;
  const ns = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

  const inspected = yield* native(() =>
    ns.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" })
  );

  expect(inspected.ok).toBe(true);
  expect((yield* verify(alice, next, code)).status).toBe(outcome === "accepted" ? 200 : 400);
  expect(yield* inbox()).toHaveLength(1);
  expect(logs.join("\n")).not.toContain(code);
  expect(logs.join("\n")).not.toContain(next);
});

const refusedDelivery = Effect.fn(function* (failure: "expiry" | "revocation") {
  const { owner, start, next, inbox, runtime } = yield* setup("expired@example.test");

  if (failure === "revocation") {
    yield* owner.exec(
      "CREATE TRIGGER revoke_on_admission AFTER INSERT ON email_replacements BEGIN UPDATE web_sessions SET revoked_at_ms=1 WHERE id=NEW.session_id; END"
    );
  } else {
    yield* owner.exec(
      "CREATE TRIGGER expire_on_admission AFTER INSERT ON email_replacements BEGIN UPDATE email_replacements SET expires_at_ms=0 WHERE work_id=NEW.work_id; END"
    );
  }

  expect((yield* start()).status).toBe(200);
  const directory = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
  expect(
    (yield* native(() => directory.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" })))
      .ok
  ).toBe(true);
  yield* Effect.sleep("100 millis");
  expect(yield* inbox()).toEqual([]);
  expect(
    yield* owner.exec("SELECT normalized_address FROM verified_email_credentials")
  ).not.toEqual([{ normalized_address: next }]);
});

const rediscover = Effect.gen(function* () {
  const { runtime, owner, now, next, prior, proof, verify, inbox } = yield* setup(
    "rediscovered@example.test"
  );

  yield* owner.exec(
    "INSERT INTO email_replacements(user_id,work_id,session_id,prior_key,revision,candidate,created_at_ms,expires_at_ms,state) VALUES(?,?,?,?,1,?,?,?,'awaiting_delivery')",
    alice.user,
    alice.user,
    alice.session,
    prior,
    next,
    now,
    now + 600000
  );
  const ns = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
  expect(
    (yield* native(() => ns.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" }))).ok
  ).toBe(true);
  const code = yield* proof;
  expect((yield* verify(alice, next, code)).status).toBe(200);
  expect(yield* inbox()).toHaveLength(1);
});

const attempts = Effect.gen(function* () {
  const { owner, start, verify, next, inbox } = yield* setup("bounded@example.test");

  yield* Effect.forEach(
    Arr.range(0, 4),
    Effect.fnUntraced(function* (index) {
      expect((yield* start()).status).toBe(200);

      const messages = yield* inbox().pipe(
        Effect.repeat({
          until: (values) => values.length > index,
          times: 40,
          schedule: Schedule.spaced("50 millis"),
        })
      );

      const code = yield* Schema.decodeUnknownEffect(EmailVerificationCode)(
        messages[index]?.split("\n\n")[1]
      );

      yield* Effect.gen(function* () {
        const previous = yield* Schema.decodeUnknownEffect(EmailVerificationCode)(
          messages[index - 1]?.split("\n\n")[1]
        );

        expect((yield* verify(alice, next, previous)).status).toBe(400);
        expect(yield* owner.exec("SELECT wrong_attempts FROM email_replacements")).toEqual([
          { wrong_attempts: 0 },
        ]);
      }).pipe(Effect.when(Effect.succeed(index > 0)));

      const failed = yield* Schema.decodeEffect(EmailVerificationCode)(
        code.slice(0, -1) + (code.endsWith("A") ? "B" : "A")
      );

      expect(
        yield* Effect.forEach(Arr.range(0, 4), () =>
          verify(alice, next, failed).pipe(Effect.map(({ status }) => status))
        )
      ).toEqual([400, 400, 400, 400, 400]);

      expect((yield* verify(alice, next, code)).status).toBe(400);
    }),
    { discard: true }
  );

  expect((yield* start()).status).toBe(200);
  yield* Effect.sleep("100 millis");
  expect(yield* inbox()).toHaveLength(5);
  expect(yield* owner.exec("SELECT revision FROM verified_email_credentials")).toEqual([
    { revision: 1 },
  ]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "rediscovers an admitted replacement after its scheduling hint was lost",
    () => rediscover
  );
  test.effect("expires admitted work before the provider claim", () => refusedDelivery("expiry"));
  test.effect("refuses delivery after revocation of the initiating session", () =>
    refusedDelivery("revocation")
  );
  test.effect(
    "bounds wrong proof attempts and replacement deliveries in the original User window",
    () => attempts
  );

  for (const failure of completionFailures) {
    test.effect("retains exact mailbox authority after " + failure, () =>
      failedCompletion(failure)
    );
  }

  for (const outcome of sendOutcomes) {
    test.effect("does not redispatch the mailbox proof after " + outcome, () =>
      interruptedDelivery(outcome)
    );
  }

  test.effect(
    "replaces only an established mailbox under the initiating fresh session and exact candidate proof",
    () => scenario
  );
});

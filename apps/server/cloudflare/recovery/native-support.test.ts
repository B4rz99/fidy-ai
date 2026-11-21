import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import { browser } from "../browser-bootstrap.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";
import { BackupRecoveryCode } from "../../src/core/recovery/contract";
import { directoryName, supportAdmissionUrl } from "../directory/contract";
import { ProviderBrowserProof } from "../../src/shell/provider-authentication/contract";

const scenario = Effect.gen(function* () {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const { verified, post, api } = browser(runtime);
  const signup = yield* verified("native-support-owner");
  const created = yield* post("/web/providers/google/complete", signup.proof);

  const { backupRecoveryCode } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ backupRecoveryCode: BackupRecoveryCode })
  )(yield* native(() => created.json()));

  const login = yield* post("/web/pairings/redeem", signup.proof);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const bindingResponse = yield* native(() =>
    runtime.dispatchFetch(api + "/web/session/binding", {
      headers: { origin: "https://app.fidyapp.com", cookie, connection: "close" },
    })
  );

  const { binding } = yield* Schema.decodeUnknownEffect(Schema.Struct({ binding: Schema.String }))(
    yield* native(() => bindingResponse.json())
  );

  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  const [subject] = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ user_id: Schema.String }))
  )(yield* native(() => directory.exec("SELECT user_id FROM recovery_routes")));

  if (subject === undefined) return yield* Effect.die("Expected established User");

  const owner = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: subject.user_id })
  );

  const now = yield* Clock.currentTimeMillis;
  yield* native(() =>
    owner.exec(
      "UPDATE users SET trial_started_at_ms=?,trial_ends_at_ms=?",
      now - 604800001,
      now - 1
    )
  );
  yield* native(() =>
    owner.exec(
      "INSERT INTO consent_history(id,user_id,grant_record_id,session_id,record_type,occurred_at_ms) SELECT '90000000-0000-4000-8000-000000000010',user_id,id,?,'processing_withdrawal',? FROM consent_history WHERE record_type='processing_grant'",
      binding,
      now
    )
  );

  const headers = {
    "content-type": "application/json",
    "Fidy-Session-Binding": binding,
    cookie,
    origin: "https://app.fidyapp.com",
    connection: "close",
  };

  const denied = yield* native(() => runtime.dispatchFetch(api + "/user", { headers }));
  expect(denied.status).toBe(401);

  const rotated = yield* native(() =>
    runtime.dispatchFetch(api + "/recovery/backup-code/rotate", {
      headers,
      method: "POST",
      body: "{}",
    })
  );

  const { data } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.Struct({ backupRecoveryCode: BackupRecoveryCode }) })
  )(yield* native(() => rotated.json()));

  const pairing = yield* post("/web/pairings", {});

  const recovery = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ ...ProviderBrowserProof.fields, publicCode: Schema.String })
  )(yield* native(() => pairing.json()));

  const { FIXTURE_PROVIDER: signer } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );

  const jwt = yield* native(() =>
    signer.fetch("https://fixture.invalid/support-assertion").then((res) => res.text())
  );

  const approve = (
    assertion: string,
    code: BackupRecoveryCode = data.backupRecoveryCode
  ): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
    native(() =>
      runtime.dispatchFetch(api + "/internal/support-recovery", {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": assertion,
          connection: "close",
          "content-type": "application/json",
        },
        body: JSON.stringify({ pairingCode: recovery.publicCode, backupRecoveryCode: code }),
      })
    );

  expect((yield* approve("invalid")).status).toBe(401);
  expect((yield* approve(jwt, backupRecoveryCode)).status).toBe(400);
  expect(
    yield* native(() =>
      directory.exec("SELECT user_id FROM browser_pairings WHERE id=?", recovery.pairingId)
    )
  ).toEqual([{ user_id: null }]);
  yield* native(() =>
    owner.exec(
      "CREATE TRIGGER fail_case BEFORE INSERT ON support_recovery_cases BEGIN SELECT RAISE(IGNORE); END"
    )
  );
  expect((yield* approve(jwt)).status).toBe(503);
  expect(
    yield* native(() => owner.exec("SELECT consumed_at_ms FROM backup_recovery_credentials"))
  ).toEqual([{ consumed_at_ms: null }]);
  yield* native(() => owner.exec("DROP TRIGGER fail_case"));
  const approved = yield* approve(jwt);
  expect(approved.status).toBe(200);
  expect(yield* native(() => approved.json())).toEqual({ status: "approved" });
  expect((yield* approve(jwt)).status).toBe(400);
  expect(
    (yield* post("/web/pairings/redeem", {
      pairingId: recovery.pairingId,
      privateVerifier: signup.proof.privateVerifier,
    })).headers.get("set-cookie")
  ).toBeNull();

  const session = yield* post("/web/pairings/redeem", {
    pairingId: recovery.pairingId,
    privateVerifier: recovery.privateVerifier,
  });

  expect(session.status).toBe(200);
  expect(session.headers.get("set-cookie")).toContain("__Host-fidy_session=");
});

const supportWindows = Effect.gen(function* () {
  const runtime = yield* (yield* nativeBrowserPlatform)();

  const directory = (yield* native(() =>
    runtime.getDurableObjectNamespace("DIRECTORY", "core")
  )).getByName(directoryName);

  const storage = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: directoryName })
  );

  const now = yield* Clock.currentTimeMillis,
    minute = 60_000,
    hour = 60 * minute;

  const admit = (subject: string): Effect.Effect<number> =>
    native(() =>
      directory.fetch(supportAdmissionUrl, {
        method: "POST",
        body: JSON.stringify({
          subject,
          issuer: "https://support.example",
          issuedAtMs: now - minute,
          expiresAtMs: now + hour,
        }),
      })
    ).pipe(Effect.map((reply) => reply.status));

  const admitted = (subject: string): Effect.Effect<ReadonlyArray<number>> =>
    Effect.forEach(
      Array.from({ length: 5 }, () => subject),
      admit
    );

  const admitBurst = Effect.fnUntraced(function* (subject: string) {
    expect(yield* admitted(subject)).toEqual(Array.from({ length: 5 }, () => 204));
    expect(yield* admit(subject)).toBe(429);
  });

  const age = (interval: number): Effect.Effect<unknown> =>
    native(() =>
      storage.exec(
        "UPDATE support_recovery_admissions SET admitted_at_ms=admitted_at_ms-?",
        interval
      )
    );

  yield* Effect.forEach(
    Array.from({ length: 4 }, (_, window) => window),
    () =>
      Effect.gen(function* () {
        yield* Effect.forEach(["one", "two", "three", "four"], admitBurst, { discard: true });

        expect(yield* admit("extra")).toBe(429);
        yield* age(minute + 1);
      }),
    { discard: true }
  );

  expect(yield* admit("one")).toBe(429);

  yield* Effect.forEach(
    ["five", "six", "seven", "eight"],
    (operator) =>
      admitted(operator).pipe(
        Effect.map((statuses) => expect(statuses).toEqual(Array.from({ length: 5 }, () => 204)))
      ),
    { discard: true }
  );

  yield* age(minute + 1);
  expect(yield* admit("extra")).toBe(429);
  expect(
    yield* native(() =>
      storage.exec("SELECT count(*) AS admitted FROM support_recovery_admissions")
    )
  ).toEqual([{ admitted: 100 }]);
  yield* age(hour);
  expect(yield* admit("one")).toBe(204);
  expect(
    yield* native(() =>
      storage.exec("SELECT count(*) AS admitted FROM support_recovery_admissions")
    )
  ).toEqual([{ admitted: 1 }]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "enforces operator and global minute and hour windows at the Directory before reserving support work",
    () => supportWindows
  );
  test.effect(
    "redeems one operator-approved recovery case only through its original browser verifier",
    () => scenario
  );
});

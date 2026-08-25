import { expect, layer } from "@effect/vitest";
import { Crypto, DateTime, Effect, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { SqlSchema } from "effect/unstable/sql";
import { ConsentRecord, ConsentRecordId } from "~/core/consent/model";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { WebSessionId } from "~/core/web-session/reference";
import { calculateWebSessionDeadlines } from "~/core/web-session/rules";
import { MigrationSqlClient } from "~/shell/db/client";
import { appendConsentRecord, observeConsentRecords } from "~/shell/consent/repo";
import { manualPATIssuanceLimit } from "./errors";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000248");
const seedBearer = TokenBearer.make("fin_patseed1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const webSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-000000000249");
const webSessionBearer = "p".repeat(43);
const secondWebSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-000000000250");
const secondWebSessionBearer = "q".repeat(43);
const sessionCookieName = "__Host-fidy_session";

let requestSequence = 0;
const nextRequestId = (): string => {
  requestSequence += 1;
  return `f1d1a000-0000-4000-8000-${requestSequence.toString().padStart(12, "0")}`;
};

const manualPATPayload = (
  recipientLabel: string,
  scopes: ReadonlyArray<string>,
  requestId = nextRequestId()
): Readonly<Record<string, unknown>> => ({
  requestId,
  grant: { recipientLabel, scopes },
});

const seedWebSession = Effect.fn("seedWebSession")(function* (pairedAt: DateTime.Utc) {
  yield* seedConsentedPatIdentity({ userId, bearer: seedBearer });
  const crypto = yield* Crypto.Crypto;
  const sql = yield* MigrationSqlClient;
  const bearerDigest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(webSessionBearer))
    .pipe(Effect.orDie);
  const deadlines = calculateWebSessionDeadlines(pairedAt);
  yield* sql`DELETE FROM consent_records
    WHERE subject_user_id = ${userId} AND grant_type = 'pat'`;
  yield* sql`DELETE FROM web_sessions WHERE user_id = ${userId}`;
  yield* sql`DELETE FROM tokens
    WHERE user_id = ${userId} AND recipient_label <> 'Development PAT'`;
  yield* sql`
    INSERT INTO web_sessions (
      id, user_id, bearer_digest, paired_at, fresh_until, idle_expires_at, hard_expires_at
    ) VALUES (
      ${webSessionId}, ${userId}, ${bearerDigest}, ${pairedAt}, ${deadlines.freshUntil},
      ${deadlines.idleExpiresAt}, ${deadlines.hardExpiresAt}
    )
  `;
});

const seedFreshWebSession = DateTime.now.pipe(Effect.flatMap(seedWebSession));

const CountRow = Schema.Struct({ count: Schema.Finite });

const persistedManualGrant = Schema.Struct({
  userId: UserId,
  recipientLabel: Schema.String,
  shortId: Schema.String,
  tokenHash: Schema.String,
  scopes: Schema.Array(Schema.String),
  idleHours: Schema.Finite,
  decisionOrigin: Schema.String,
  consentWebSessionId: WebSessionId,
  disclosureText: Schema.String,
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "manual PAT issuance",
  (it) => {
    it.effect("issues once to a fresh paired browser and persists only the matching digest", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const response = yield* HttpClient.post("/pats", {
          headers: {
            cookie: `${sessionCookieName}=${webSessionBearer}`,
            "content-type": "application/json",
          },
          body: HttpBody.jsonUnsafe(
            manualPATPayload("  Automatización casa  ", ["read", "dashboard"])
          ),
        });
        const body = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({
              pat: Schema.Struct({
                recipientLabel: Schema.String,
                scopes: Schema.Array(Schema.String),
                shortId: Schema.String,
              }),
              bearer: TokenBearer,
            }),
            next: Schema.Array(Schema.Unknown),
          })
        )(yield* response.json);
        const sql = yield* MigrationSqlClient;
        const [stored] = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: persistedManualGrant,
          execute: () => sql`
            SELECT token.user_id AS "userId", token.recipient_label AS "recipientLabel",
              token.short_id AS "shortId", token.token_hash AS "tokenHash", token.scopes,
              (EXTRACT(EPOCH FROM (token.idle_expires_at - token.created_at)) / 3600)
                ::double precision AS "idleHours",
              consent.decision_origin AS "decisionOrigin",
              consent.web_session_id AS "consentWebSessionId",
              consent.disclosure_text AS "disclosureText"
            FROM tokens AS token
            JOIN consent_records AS consent ON consent.pat_id = token.id
            WHERE token.user_id = ${userId}
              AND token.recipient_label = 'Automatización casa'
          `,
        })(undefined);
        const digest = yield* (yield* Crypto.Crypto)
          .digest("SHA-256", new TextEncoder().encode(body.data.bearer))
          .pipe(Effect.orDie);
        const digestHex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(body.next).toEqual([]);
        expect(body.data.pat.recipientLabel).toBe("Automatización casa");
        expect(body.data.pat.scopes).toEqual(["read", "dashboard"]);
        expect(body.data.bearer).toMatch(/^fin_[a-z0-9]{8}_[A-Za-z0-9_-]{32,}$/u);
        expect(stored).toMatchObject({
          userId,
          recipientLabel: "Automatización casa",
          shortId: body.data.pat.shortId,
          tokenHash: digestHex,
          scopes: ["read", "dashboard"],
          idleHours: 2160,
          decisionOrigin: "authenticated-web",
          consentWebSessionId: webSessionId,
        });
        expect(stored?.disclosureText).toContain("Automatización casa");
        expect(stored?.disclosureText).toContain("90 días");
        expect(stored?.tokenHash).not.toBe(body.data.bearer);
        expect(stored?.disclosureText).not.toContain(body.data.bearer);
      })
    );

    it.effect("consumes one issuance request identity without duplicate grants", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const payload = manualPATPayload("Retry-safe PAT", ["read"]);
        const request = Effect.fn("retryPATRequest")(function* () {
          return yield* HttpClient.post("/pats", {
            headers: {
              cookie: `${sessionCookieName}=${webSessionBearer}`,
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe(payload),
          });
        });
        const first = yield* request();
        const retry = yield* request();
        const sql = yield* MigrationSqlClient;
        const tokenRows = yield* sql`
          SELECT count(*)::int AS count FROM tokens
          WHERE user_id = ${userId} AND recipient_label = 'Retry-safe PAT'
        `;
        const consentRows = yield* sql`
          SELECT count(*)::int AS count
          FROM consent_records AS consent
          JOIN tokens AS token ON token.id = consent.pat_id
          WHERE consent.subject_user_id = ${userId}
            AND token.recipient_label = 'Retry-safe PAT'
        `;
        const [tokenCount] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(tokenRows);
        const [consentCount] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(
          consentRows
        );

        expect([first.status, retry.status]).toEqual([200, 409]);
        expect(tokenCount?.count).toBe(1);
        expect(consentCount?.count).toBe(1);
      })
    );

    it.effect("refuses absent, stale, and PAT callers before creating a grant", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* seedWebSession(DateTime.subtractDuration(now, "11 minutes"));
        const body = HttpBody.jsonUnsafe(manualPATPayload("Denied PAT", ["read"]));
        const absent = yield* HttpClient.post("/pats", {
          headers: { "content-type": "application/json" },
          body,
        });
        const stale = yield* HttpClient.post("/pats", {
          headers: {
            cookie: `${sessionCookieName}=${webSessionBearer}`,
            "content-type": "application/json",
          },
          body,
        });
        const pat = yield* HttpClient.post("/pats", {
          headers: {
            authorization: `Bearer ${seedBearer}`,
            "content-type": "application/json",
          },
          body,
        });
        const sql = yield* MigrationSqlClient;
        const countRows = yield* sql`
          SELECT count(*)::int AS count FROM tokens
          WHERE user_id = ${userId} AND recipient_label = 'Denied PAT'
        `;
        const [count] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(countRows);

        expect([absent.status, stale.status, pat.status]).toEqual([401, 401, 403]);
        expect(count?.count).toBe(0);
      })
    );

    it.effect("refuses a fresh browser after onboarding Consent is revoked", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const [grant] = yield* observeConsentRecords(userId);
        if (grant?.evidence._tag !== "ProviderQualifiedMessages") {
          return yield* Effect.die("missing provider-qualified onboarding grant");
        }
        yield* appendConsentRecord(
          ConsentRecord.make({
            ...grant,
            id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000251"),
            event: { _tag: "Revoked", grantId: grant.id },
            occurredAt: yield* DateTime.now,
            evidence: {
              _tag: "ProviderQualifiedMessages",
              disclosureMessage: grant.evidence.disclosureMessage,
              decisionMessage: {
                channel: "whatsapp",
                provider: "kapso",
                providerMessageId: "wamid.manual-pat-revocation",
              },
            },
          })
        );

        const response = yield* HttpClient.post("/pats", {
          headers: {
            cookie: `${sessionCookieName}=${webSessionBearer}`,
            "content-type": "application/json",
          },
          body: HttpBody.jsonUnsafe(manualPATPayload("Revoked Consent PAT", ["read"])),
        });
        const sql = yield* MigrationSqlClient;
        const tokenRows = yield* sql`
          SELECT count(*)::int AS count FROM tokens
          WHERE user_id = ${userId} AND recipient_label = 'Revoked Consent PAT'
        `;
        const consentRows = yield* sql`
          SELECT count(*)::int AS count FROM consent_records
          WHERE subject_user_id = ${userId} AND decision_origin = 'authenticated-web'
        `;
        const [tokenCount] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(tokenRows);
        const [consentCount] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(
          consentRows
        );

        expect(response.status).toBe(403);
        expect(tokenCount?.count).toBe(0);
        expect(consentCount?.count).toBe(0);
      })
    );

    it.effect("rejects malformed grants without persisting authorization state", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const response = yield* HttpClient.post("/pats", {
          headers: {
            cookie: `${sessionCookieName}=${webSessionBearer}`,
            "content-type": "application/json",
          },
          body: HttpBody.jsonUnsafe(manualPATPayload("Malformed PAT", ["read", "read"])),
        });
        const sql = yield* MigrationSqlClient;
        const tokenRows = yield* sql`
          SELECT count(*)::int AS count FROM tokens
          WHERE user_id = ${userId} AND recipient_label = 'Malformed PAT'
        `;
        const consentRows = yield* sql`
          SELECT count(*)::int AS count FROM consent_records
          WHERE subject_user_id = ${userId} AND decision_origin = 'authenticated-web'
        `;
        const [tokenCount] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(tokenRows);
        const [consentCount] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(
          consentRows
        );

        expect(response.status).toBe(400);
        expect(tokenCount?.count).toBe(0);
        expect(consentCount?.count).toBe(0);
      })
    );

    it.effect("limits issuance across fresh sessions without partial persistence", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const requestPAT = Effect.fn("requestPAT")(function* (
          bearer: string,
          recipientLabel: string
        ) {
          return yield* HttpClient.post("/pats", {
            headers: {
              cookie: `${sessionCookieName}=${bearer}`,
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe(manualPATPayload(recipientLabel, ["read"])),
          });
        });
        const admitted = yield* Effect.forEach(
          Array.from({ length: manualPATIssuanceLimit }, (_, index) => index),
          (index) => requestPAT(webSessionBearer, `Bounded PAT ${index}`),
          { concurrency: "unbounded" }
        );

        const now = yield* DateTime.now;
        const crypto = yield* Crypto.Crypto;
        const sql = yield* MigrationSqlClient;
        const secondDigest = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(secondWebSessionBearer))
          .pipe(Effect.orDie);
        const deadlines = calculateWebSessionDeadlines(now);
        yield* sql`
          INSERT INTO web_sessions (
            id, user_id, bearer_digest, paired_at, fresh_until, idle_expires_at, hard_expires_at
          ) VALUES (
            ${secondWebSessionId}, ${userId}, ${secondDigest}, ${now}, ${deadlines.freshUntil},
            ${deadlines.idleExpiresAt}, ${deadlines.hardExpiresAt}
          )
        `;
        const rejected = yield* requestPAT(secondWebSessionBearer, "Rejected bounded PAT");
        const tokenRows = yield* sql`
          SELECT count(*)::int AS count FROM tokens
          WHERE user_id = ${userId} AND recipient_label LIKE 'Bounded PAT %'
        `;
        const consentRows = yield* sql`
          SELECT count(*)::int AS count FROM consent_records
          WHERE subject_user_id = ${userId}
            AND decision_origin = 'authenticated-web'
        `;
        const [tokenCount] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(tokenRows);
        const [consentCount] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(
          consentRows
        );

        expect(admitted.map(({ status }) => status)).toEqual(
          Array.from({ length: manualPATIssuanceLimit }, () => 200)
        );
        expect(rejected.status).toBe(429);
        expect(rejected.headers["retry-after"]).toBeDefined();
        expect(tokenCount?.count).toBe(manualPATIssuanceLimit);
        expect(consentCount?.count).toBe(manualPATIssuanceLimit);
      })
    );

    it.effect("rolls the PAT back when matching Consent evidence cannot commit", () =>
      Effect.gen(function* () {
        yield* seedFreshWebSession;
        const sql = yield* MigrationSqlClient;
        yield* sql`DROP TRIGGER IF EXISTS reject_manual_pat_consent ON consent_records`;
        yield* sql`
          CREATE OR REPLACE FUNCTION reject_manual_pat_consent_for_test()
          RETURNS trigger LANGUAGE plpgsql AS $function$
          BEGIN
            IF NEW.grant_type = 'pat' THEN
              RAISE EXCEPTION 'forced PAT Consent failure';
            END IF;
            RETURN NEW;
          END
          $function$
        `;
        yield* sql`
          CREATE TRIGGER reject_manual_pat_consent BEFORE INSERT ON consent_records
          FOR EACH ROW EXECUTE FUNCTION reject_manual_pat_consent_for_test()
        `;

        const response = yield* HttpClient.post("/pats", {
          headers: {
            cookie: `${sessionCookieName}=${webSessionBearer}`,
            "content-type": "application/json",
          },
          body: HttpBody.jsonUnsafe(manualPATPayload("Rollback PAT", ["write"])),
        }).pipe(
          Effect.ensuring(
            sql`DROP TRIGGER IF EXISTS reject_manual_pat_consent ON consent_records`.pipe(
              Effect.andThen(sql`DROP FUNCTION IF EXISTS reject_manual_pat_consent_for_test()`),
              Effect.orDie
            )
          )
        );
        const tokenCountRows = yield* sql`
          SELECT count(*)::int AS count FROM tokens
          WHERE user_id = ${userId} AND recipient_label = 'Rollback PAT'
        `;
        const consentCountRows = yield* sql`
          SELECT count(*)::int AS count FROM consent_records
          WHERE subject_user_id = ${userId} AND grant_type = 'pat'
        `;
        const [tokenCount] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(
          tokenCountRows
        );
        const [consentCount] = yield* Schema.decodeUnknownEffect(Schema.Array(CountRow))(
          consentCountRows
        );

        expect(response.status).toBe(500);
        expect(tokenCount?.count).toBe(0);
        expect(consentCount?.count).toBe(0);
      })
    );
  }
);

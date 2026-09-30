import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { type Cause, Effect, Option } from "effect";
import { findUserContext, findWhatsAppUser, prepareVerifiedUser } from "./operations";
import {
  establishedWhatsAppAuthority,
  whatsAppCredentialAuthority,
} from "../../src/shell/identity/operations";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";

const instances: Array<Miniflare> = [];
afterEach(() =>
  Promise.all(instances.splice(0).map((instance) => instance.dispose())).then(() => undefined)
);

const database = Effect.fn(function* (name: string) {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          name,
          type: "worker",
          env: { DB: { id: name, type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch() {return new Response('ok')}}",
                type: "esm",
              },
            },
          },
        },
      },
    ],
  });
  instances.push(instance);
  yield* Effect.tryPromise(() => instance.ready);
  return yield* Effect.tryPromise(() => instance.getD1Database("DB"));
});
const firstUser = "10000000-0000-4000-8000-000000000001";
const secondUser = "10000000-0000-4000-8000-000000000002";

it("resolves only a Portfolio-scoped BSUID and refuses cross-User association substitution", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database("identity-association");
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE whatsapp_identities (user_id TEXT, portfolio_id TEXT, bsuid TEXT)"
          ),
          db
            .prepare("INSERT INTO whatsapp_identities VALUES (?, 'portfolio', 'CO.Person1')")
            .bind(firstUser),
          db
            .prepare("INSERT INTO whatsapp_identities VALUES (?, 'other-portfolio', 'CO.Person1')")
            .bind(secondUser),
        ])
      );
      const portfolioId = WhatsAppBusinessPortfolioId.make("portfolio");
      const bsuid = WhatsAppBusinessScopedUserId.make("CO.Person1");
      expect(yield* findWhatsAppUser({ db, portfolioId, bsuid })).toEqual(Option.some(firstUser));
      expect(
        yield* findWhatsAppUser({
          db,
          portfolioId: WhatsAppBusinessPortfolioId.make("unknown"),
          bsuid,
        })
      ).toEqual(Option.none());
      const authority = (userId: string): ReturnType<typeof whatsAppCredentialAuthority> =>
        whatsAppCredentialAuthority({
          userId: UserId.make(userId),
          portfolioId,
          bsuid,
        });
      const check = (userId: string): Effect.Effect<unknown, Cause.UnknownError> => {
        const gate = authority(userId);
        return Effect.tryPromise(() =>
          db
            .prepare(`SELECT user_id FROM ${gate.table} WHERE ${gate.predicate}`)
            .bind(...gate.bindings)
            .first()
        );
      };
      expect(yield* check(firstUser)).toEqual({ user_id: firstUser });
      expect(yield* check(secondUser)).toBeNull();
    })
  ));

it("keeps established WhatsApp browser approval available after revocation and rechecks its exact User basis at commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database("identity-established-approval");
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE whatsapp_identities (user_id TEXT, portfolio_id TEXT, bsuid TEXT)"
          ),
          db.prepare("CREATE TABLE onboarding_consent_records (user_id TEXT)"),
          db.prepare("CREATE TABLE consent_user_revocations (user_id TEXT)"),
          db.prepare("CREATE TABLE approval_evidence (user_id TEXT)"),
          db
            .prepare("INSERT INTO whatsapp_identities VALUES (?, 'portfolio', 'CO.Person1')")
            .bind(firstUser),
          db
            .prepare("INSERT INTO whatsapp_identities VALUES (?, 'portfolio', 'CO.Person2')")
            .bind(secondUser),
          db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(firstUser),
          db.prepare("INSERT INTO consent_user_revocations VALUES (?)").bind(firstUser),
        ])
      );
      const approval = (userId: string, bsuid: string): D1PreparedStatement => {
        const gate = establishedWhatsAppAuthority({
          userId: UserId.make(userId),
          portfolioId: WhatsAppBusinessPortfolioId.make("portfolio"),
          bsuid: WhatsAppBusinessScopedUserId.make(bsuid),
        });
        return db
          .prepare(`INSERT INTO approval_evidence (user_id)
          SELECT user_id FROM ${gate.table} WHERE ${gate.predicate}`)
          .bind(...gate.bindings);
      };
      const pending = approval(firstUser, "CO.Person1");
      yield* Effect.tryPromise(() =>
        db.batch([
          approval(firstUser, "CO.Person1"),
          approval(secondUser, "CO.Person1"),
          approval(secondUser, "CO.Person2"),
        ])
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("DELETE FROM onboarding_consent_records WHERE user_id = ?").bind(firstUser),
          pending,
        ])
      );
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT user_id FROM approval_evidence").all()))
          .results
      ).toEqual([{ user_id: firstUser }]);
    })
  ));

it("reads independent context for the explicit User, never a provider or contact value", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database("identity-context");
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE users (id TEXT PRIMARY KEY, service_market TEXT, locale TEXT, time_zone TEXT)"
          ),
          db
            .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota')")
            .bind(firstUser),
          db
            .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/New_York')")
            .bind(secondUser),
        ])
      );
      const read = (userId: string): ReturnType<typeof findUserContext> =>
        findUserContext({ db, userId });
      expect(yield* read(firstUser)).toEqual(
        Option.some({
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
        })
      );
      expect(yield* read(secondUser)).toEqual(
        Option.some({
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/New_York",
        })
      );
      expect(yield* read("CO.Person1")).toEqual(Option.none());
      expect(yield* read("+573001234567")).toEqual(Option.none());
    })
  ));

it("creates identity and its association only inside the caller's successful atomic unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database("identity-creation");
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE users (id TEXT PRIMARY KEY, service_market TEXT, locale TEXT, time_zone TEXT, created_at_ms INTEGER)"
          ),
          db.prepare(
            "CREATE TABLE whatsapp_identities (user_id TEXT, portfolio_id TEXT, bsuid TEXT, verified_at_ms INTEGER)"
          ),
          db.prepare(
            "CREATE TABLE pending_consent_exchanges (id TEXT, portfolio_id TEXT, bsuid TEXT, state TEXT)"
          ),
          db.prepare(
            "INSERT INTO pending_consent_exchanges VALUES ('exchange', 'portfolio', 'CO.Person1', 'accepted')"
          ),
        ])
      );
      const now = Date.parse("2026-07-28T00:00:00Z");
      const unit = (): Array<D1PreparedStatement> => {
        const prepared = prepareVerifiedUser({
          db,
          userId: firstUser,
          exchangeId: "exchange",
          now,
        });
        return [prepared.user, prepared.association];
      };
      const committed = yield* Effect.tryPromise(() =>
        db.batch([...unit(), db.prepare("INSERT INTO users (id) VALUES (?)").bind(firstUser)])
      ).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
      expect(committed).toBe(false);
      expect(yield* findUserContext({ db, userId: firstUser })).toEqual(Option.none());
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM whatsapp_identities").first()
        )
      ).toEqual({ count: 0 });
      yield* Effect.tryPromise(() => db.batch(unit()));
      expect(yield* findUserContext({ db, userId: firstUser })).toEqual(
        Option.some({
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
        })
      );
    })
  ));

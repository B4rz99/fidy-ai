import { operationCatalog } from "../../src/shell/api";
import {
  discoveryCases,
  excludedAccountSecurityDiscovery,
  readDiscovery,
  sensitiveDiscovery,
} from "./discovery.test-fixture";
import { PATScopes } from "../../src/core/tokens/contract";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  ListedTools,
  TokenFixture,
  approveAgain,
  approvedFixture,
  exchangeFixture,
  mcpFixture,
  revokeFixtureConsent,
  sessionFor,
  sessionForUser,
  wait,
} from "./oauth-ingress.test-fixture";

afterEach(() => vi.restoreAllMocks());

// These declarations deliberately have no native query owner yet; this is not an installed-query inventory.
const uninstalledQueries = new Set([
  "identity.getCurrentUser",
  "transactions.listSourceAttestations",
]);

const queryTools = operationCatalog.operations.filter(
  ({ id, policy }) =>
    policy.kind === "query" &&
    policy.access._tag === "UserOwnedAgentScoped" &&
    !uninstalledQueries.has(id)
);

it("refuses deliberately missing canonical query adapters without inventing a binding or accounting work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      for (const name of uninstalledQueries) {
        const response = yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name,
            args: {},
          })
        );
        expect(yield* wait(response.json()), name).toHaveProperty("error");
      }
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) AS total FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("total")
        )
      ).toBe(0);
    })
  ));

const Listed2025Tools = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        inputSchema: Schema.Json,
        outputSchema: Schema.optionalKey(Schema.Json),
        annotations: Schema.Struct({
          readOnlyHint: Schema.Boolean,
          destructiveHint: Schema.Boolean,
        }),
      })
    ),
  }),
});

it("retains a 2025 session across separate initialized and discovery requests through published ingress", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const headers = {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const initialized = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: "initialize-resident",
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "resident-protocol-fixture", version: "1" },
            },
          }),
        })
      );
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get("mcp-session-id");
      expect(sessionId).not.toBeNull();
      yield* wait(initialized.text());
      const sessionHeaders = {
        ...headers,
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId ?? "",
      };
      const notified = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: sessionHeaders,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
        })
      );
      expect(notified.status).toBe(202);
      yield* wait(notified.text());
      const discovery = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: sessionHeaders,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: "discover-resident",
            method: "tools/list",
            params: {},
          }),
        })
      );
      expect(discovery.status).toBe(200);
      const listed = yield* Schema.decodeUnknownEffect(Listed2025Tools)(
        yield* wait(discovery.json())
      );
      expect(listed.result.tools.map(({ name }) => name)).toEqual(
        [...readDiscovery, "operations.executeAtomicBatch"].sort()
      );
      for (const tool of listed.result.tools) {
        if (tool.name === "operations.executeAtomicBatch") {
          expect(tool.annotations.readOnlyHint).toBe(false);
        } else {
          expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
        }
      }
    })
  ));

it("derives exact private canonical discovery for every non-empty capability combination without leaking nested unauthorized identities", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const { scopes, tools, additionalDeclarations } of discoveryCases) {
        const capabilities = yield* Schema.decodeUnknownEffect(PATScopes)(scopes);
        const fixture = yield* approvedFixture({
          scopes: capabilities,
          lifetimeDays: 7,
          auditMigration: true,
        });
        const token = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String })
        )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
        const listed = yield* Schema.decodeUnknownEffect(ListedTools)(
          yield* wait(
            (yield* wait(
              mcpFixture({ send: fixture.send, bearer: token.access_token, method: "tools/list" })
            )).json()
          )
        );
        const expected = [...tools].sort();
        const names = listed.result.tools.map(({ name }) => name);
        expect(names, scopes.join(" ")).toEqual(expected);
        for (const excluded of excludedAccountSecurityDiscovery) {
          expect(names).not.toContain(excluded);
        }
        for (const tool of listed.result.tools) {
          expect(tool.annotations).toEqual({
            readOnlyHint: readDiscovery.includes(tool.name),
            destructiveHint: sensitiveDiscovery.has(tool.name),
          });
        }
        const schemas = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
          listed.result.tools.map(({ inputSchema, outputSchema }) => ({
            inputSchema,
            outputSchema,
          }))
        );
        const allowedDeclarations = new Set([...tools, ...additionalDeclarations]);
        for (const operation of operationCatalog.operations.filter(
          ({ id }) => !allowedDeclarations.has(id)
        )) {
          expect(schemas).not.toContain(`"${operation.id}"`);
        }
      }
    })
  ));

const expectedQueryFailure = (id: string, peer: boolean): boolean =>
  id === "ingestion.getStatementSubmission" ||
  (peer &&
    [
      "dashboard.getDashboard",
      "dashboard.getDashboardView",
      "budgets.getBudget",
      "transactions.getTransaction",
    ].includes(id));

it("executes every installed declaration-derived query through Core for two Users with private exact structured and text outcomes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write", "dashboard"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const cookie = yield* sessionForUser({ db: fixture.db, index: 2, userIndex: 2 });
      const time = DateTime.formatIso(yield* DateTime.now);
      const resourceId = "30000000-0000-4000-8000-000000000001";
      const privateMarker = "primary-user-private";
      yield* wait(
        fixture.db.batch([
          fixture.db
            .prepare(
              "INSERT INTO onboarding_consent_records VALUES ('grant-peer', ?, '{}', 'disclosure', 'decision', 1, 1)"
            )
            .bind("20000000-0000-4000-8000-000000000001"),
          fixture.db
            .prepare("INSERT INTO trial_periods VALUES (?,0,604800000)")
            .bind("10000000-0000-4000-8000-000000000001"),
          fixture.db
            .prepare("INSERT INTO trial_periods VALUES (?,0,604800000)")
            .bind("20000000-0000-4000-8000-000000000001"),
          fixture.db
            .prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?)")
            .bind(resourceId, "10000000-0000-4000-8000-000000000001", privateMarker, time, time),
          fixture.db
            .prepare("INSERT INTO keyword_rules VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(
              resourceId,
              "10000000-0000-4000-8000-000000000001",
              privateMarker,
              privateMarker,
              "10000000-0000-4000-8000-000000000001",
              time,
              time
            ),
          fixture.db
            .prepare(
              "INSERT INTO transactions (id,user_id,amount,currency,direction,counterparty,category_id,notes,occurred_at,created_at) VALUES (?,?,'9007199254740993','COP','outflow','Mercado',?,?,?,?)"
            )
            .bind(
              resourceId,
              "10000000-0000-4000-8000-000000000001",
              "10000000-0000-4000-8000-000000000001",
              privateMarker,
              time,
              time
            ),
          fixture.db
            .prepare("INSERT INTO budgets VALUES (?, ?, ?, 'COP', '9007199254740994', ?, ?)")
            .bind(
              resourceId,
              "10000000-0000-4000-8000-000000000001",
              "10000000-0000-4000-8000-000000000001",
              time,
              time
            ),
        ])
      );
      expect(
        (yield* wait(
          fixture.send("/dashboard/initialize", {
            method: "POST",
            headers: fixture.headers,
            body: "{}",
          })
        )).status
      ).toBe(200);
      const peer = yield* approveAgain({ ...fixture, headers: { ...fixture.headers, cookie } });
      const examples: ReadonlyArray<Schema.Json> = [
        {},
        { query: {} },
        { query: { timeZone: "America/Bogota" } },
        { query: { q: "mercado" } },
        { params: { id: resourceId } },
      ];
      for (const current of [fixture, peer]) {
        const token = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String })
        )(
          yield* wait(
            (yield* wait(exchangeFixture({ send: fixture.send, body: current.body }))).json()
          )
        );
        for (const operation of queryTools) {
          // Catalog cases exercise owner behavior, not burst admission.
          vi.spyOn(Date, "now").mockReturnValue((yield* Clock.currentTimeMillis) + 1000);
          const args = examples.find((example) =>
            Option.isSome(
              Schema.decodeOption(operation.input, { onExcessProperty: "error" })(example)
            )
          );
          expect(args, operation.id).toBeDefined();
          const response = yield* wait(
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: operation.id,
              args: args ?? {},
            })
          );
          const raw = yield* wait(response.json());
          expect(raw, operation.id).toHaveProperty("result.structuredContent");
          const value = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              result: Schema.Struct({
                isError: Schema.Boolean,
                structuredContent: Schema.Json,
                content: Schema.Tuple([
                  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
                ]),
              }),
            })
          )(raw);
          const result = value.result;
          expect(
            Option.isSome(
              Schema.decodeOption(result.isError ? operation.failure : operation.success)(
                result.structuredContent
              )
            ),
            operation.id
          ).toBe(true);
          expect(
            yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(result.content[0].text)
          ).toEqual(result.structuredContent);
          expect(result.content[0].text, operation.id).not.toContain("unauthenticated");
          expect(result.content[0].text, operation.id).not.toContain("validation_failed");
          expect(result.content[0].text, operation.id).not.toContain('"code":"unavailable"');
          const intentionallyAbsent = expectedQueryFailure(
            operation.id,
            current.connectionId === peer.connectionId
          );
          expect(result.isError, operation.id).toBe(intentionallyAbsent);
          if (current.connectionId === peer.connectionId) {
            expect(result.content[0].text, operation.id).not.toContain(privateMarker);
            expect(result.content[0].text, operation.id).not.toContain("9007199254740993");
          } else if (operation.id === "transactions.listTransactions") {
            expect(result.content[0].text).toContain("9007199254740993");
            expect(result.content[0].text).toContain(privateMarker);
          }
          const audit = yield* wait(
            fixture.db
              .prepare(
                "SELECT oauth_connection_id,oauth_credential_id,pat_id,operation,outcome FROM pat_audit WHERE operation = ? AND oauth_connection_id = ?"
              )
              .bind(operation.id, current.connectionId)
              .all()
          );
          expect(audit.results, operation.id).toHaveLength(1);
          expect(audit.results[0], operation.id).toMatchObject({
            oauth_connection_id: current.connectionId,
            pat_id: null,
            operation: operation.id,
          });
        }
      }
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) AS total FROM dashboard_documents")
            .first<number>("total")
        )
      ).toBe(1);
    })
  ));

it("validates malformed structured inputs for every eligible query without echoing arguments or duplicating accounting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write", "dashboard"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      for (const operation of queryTools) {
        vi.spyOn(Date, "now").mockReturnValue((yield* Clock.currentTimeMillis) + 1000);
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            result: Schema.Struct({
              isError: Schema.Literal(true),
              structuredContent: Schema.Json,
              content: Schema.Array(Schema.Struct({ text: Schema.String })),
            }),
          })
        )(
          yield* wait(
            (yield* wait(
              mcpFixture({
                send: fixture.send,
                bearer: token.access_token,
                method: "tools/call",
                name: operation.id,
                args: { unexpected: "private-input-must-not-escape" },
              })
            )).json()
          )
        );
        expect(result.result.structuredContent, operation.id).toMatchObject({
          error: { code: "validation_failed" },
          next: [],
        });
        expect(
          Option.isSome(Schema.decodeOption(operation.failure)(result.result.structuredContent)),
          operation.id
        ).toBe(true);
        expect(result.result.content[0]?.text, operation.id).not.toContain(
          "private-input-must-not-escape"
        );
        const audit = yield* wait(
          fixture.db
            .prepare(
              "SELECT outcome FROM pat_audit WHERE operation = ? AND oauth_connection_id = ?"
            )
            .bind(operation.id, fixture.connectionId)
            .all()
        );
        expect(audit.results, operation.id).toEqual([{ outcome: "rejected" }]);
      }
    })
  ));

it("retains complete query data while removing scope-inaccessible continuations before MCP serialization", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      fixture.interceptQueryResponse(({ response }) =>
        response.json().then((body: unknown) => {
          const raw = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Json }))(body);
          return Response.json({
            data: raw.data,
            next: [
              {
                tool: "memory.remember",
                hint: "Private denied hint.",
                args: { payload: { text: "private-denied-input" } },
              },
            ],
          });
        })
      );
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            isError: Schema.Literal(false),
            structuredContent: Schema.Struct({
              data: Schema.Array(Schema.Json),
              next: Schema.Array(Schema.Json),
            }),
            content: Schema.Array(Schema.Struct({ text: Schema.String })),
          }),
        })
      )(
        yield* wait(
          (yield* wait(
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "categories.listCategories",
              args: {},
            })
          )).json()
        )
      );
      expect(result.result.structuredContent.data).toHaveLength(16);
      expect(result.result.structuredContent.next).toEqual([]);
      expect(result.result.content[0]?.text).not.toContain("private-denied");
      expect(result.result.content[0]?.text).not.toContain("Private denied hint.");
    })
  ));

it.each([
  "malformed-json",
  "malformed-output",
  "oversized-output",
  "rejected-response",
  "deadline",
  "retry-info",
])(
  "returns a bounded schema-valid structured failure for $0 without diagnostic or accounting duplication",
  (fault) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const token = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String })
        )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
        let cleanedUp = false;
        fixture.interceptQueryResponse(({ request, response }) => {
          if (fault === "retry-info") {
            return Promise.resolve(
              Response.json(
                {
                  error: {
                    code: "rate_limited",
                    message: "Retry after the admission window.",
                    retryAfterSeconds: 7,
                  },
                  next: [],
                },
                { status: 429, headers: { "retry-after": "7" } }
              )
            );
          }
          if (fault === "rejected-response") {
            return Promise.reject(new Error("private-diagnostic-must-not-escape"));
          }
          if (fault === "malformed-json") {
            return Promise.resolve(new Response("private-diagnostic-must-not-escape"));
          }
          if (fault === "malformed-output") {
            return Promise.resolve(
              Response.json({ data: "private-diagnostic-must-not-escape", next: [] })
            );
          }
          if (fault === "oversized-output") {
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start: (controller): void => {
                    controller.enqueue(new Uint8Array(1_048_577));
                  },
                  cancel: (): void => {
                    cleanedUp = true;
                  },
                })
              )
            );
          }
          const pending = Promise.withResolvers<Response>();
          const onAbort = (): void => {
            cleanedUp = true;
            pending.resolve(response);
          };
          if (request.signal.aborted) onAbort();
          else request.signal.addEventListener("abort", onAbort, { once: true });
          return pending.promise;
        });
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            result: Schema.Struct({
              isError: Schema.Literal(true),
              structuredContent: Schema.Json,
              content: Schema.Tuple([
                Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
              ]),
            }),
          })
        )(
          yield* wait(
            (yield* wait(
              mcpFixture({
                send: fixture.send,
                bearer: token.access_token,
                method: "tools/call",
                name: "categories.listCategories",
                args: {},
              })
            )).json()
          )
        );
        const operation = operationCatalog.byId.get("categories.listCategories");
        expect(operation).toBeDefined();
        if (operation === undefined) return;
        expect(
          Option.isSome(Schema.decodeOption(operation.failure)(result.result.structuredContent))
        ).toBe(true);
        expect(result.result.structuredContent).toMatchObject(
          fault === "retry-info"
            ? { error: { code: "rate_limited", retryAfterSeconds: 7 }, next: [] }
            : { error: { code: "unavailable" }, next: [] }
        );
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
            result.result.content[0].text
          )
        ).toEqual(result.result.structuredContent);
        expect(result.result.content[0].text).not.toContain("private-diagnostic-must-not-escape");
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) AS total FROM pat_audit WHERE oauth_connection_id = ?")
              .bind(fixture.connectionId)
              .first<number>("total")
          )
        ).toBe(1);
        if (fault === "oversized-output" || fault === "deadline") expect(cleanedUp).toBe(true);
      })
    )
);

it("returns a schema-valid unavailable failure from a genuinely unavailable native Memory storage adapter", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      yield* wait(fixture.db.prepare("DROP TABLE memories").run());
      const raw = yield* wait(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "memory.recall",
            args: {},
          })
        )).json()
      );
      expect(raw).toMatchObject({
        result: { isError: true, structuredContent: { error: { code: "unavailable" }, next: [] } },
      });
      const parsed = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Json }) })
      )(raw);
      const operation = operationCatalog.byId.get("memory.recall");
      if (operation === undefined) throw new Error("Missing Memory declaration");
      expect(
        Option.isSome(Schema.decodeOption(operation.failure)(parsed.result.structuredContent))
      ).toBe(true);
    })
  ));

it("returns the canonical uninitialized Dashboard outcome without creating domain state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      const response = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "dashboard.getDashboard",
          args: {},
        })
      );
      expect(yield* wait(response.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "dashboard_uninitialized" }, next: [] },
        },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM dashboard_documents").first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("keeps read and account-security tools uncallable by a write-only connection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const exchanged = yield* wait(exchangeFixture(fixture));
      expect(exchanged.status).toBe(200);
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait(exchanged.json()));
      const listed = yield* wait(
        mcpFixture({ send: fixture.send, bearer: token.access_token, method: "tools/list" })
      );
      const tools = yield* Schema.decodeUnknownEffect(ListedTools)(yield* wait(listed.json()));
      expect(tools.result.tools.map(({ name }) => name)).toContain("operations.executeAtomicBatch");
      for (const name of [
        "categories.listCategories",
        "pats.createPAT",
        "browserLogin.approvePairing",
      ]) {
        const refused = yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name,
            args: {},
          })
        );
        expect(yield* wait(refused.text())).toContain('"error"');
      }
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("blocks wrong-purpose credentials and live explicit Consent revocation after discovery without query evidence or data effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      const request = (): Promise<Response> =>
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        });
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: token.access_token, method: "tools/list" })
        )).status
      ).toBe(200);
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: token.refresh_token, method: "tools/list" })
        )).status
      ).toBe(401);
      yield* revokeFixtureConsent(fixture.db);
      expect((yield* wait(request())).status).toBe(401);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("rejects cross-User and client coordinator substitutions and returns validated structured failures for malformed canonical inputs", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      yield* sessionFor({ db: fixture.db, index: 2 });
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      const digest = Array.from(
        new Uint8Array(
          yield* wait(
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(`oauth-access:${token.access_token}`)
            )
          )
        )
      );
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, user_id: Schema.String })
      )(
        yield* wait(
          fixture.db
            .prepare("SELECT id,user_id FROM oauth_access_credentials WHERE connection_id = ?")
            .bind(fixture.connectionId)
            .first()
        )
      );
      const admission = {
        userId: row.user_id,
        connectionId: fixture.connectionId,
        credentialId: row.id,
        clientId: fixture.body.get("client_id") ?? "",
        resource: "https://api.fidyapp.com/mcp",
        digest,
        deadlineMilliseconds: (yield* Clock.currentTimeMillis) + 5000,
        operation: "categories.listCategories",
        input: {},
      };
      expect(
        (yield* wait(fixture.coordinate("20000000-0000-4000-8000-000000000001", admission))).status
      ).toBe(503);
      expect(
        (yield* wait(
          fixture.coordinate(row.user_id, {
            ...admission,
            clientId: "20000000-0000-4000-8000-000000000001",
          })
        )).status
      ).toBe(401);
      expect(
        (yield* wait(
          fixture.coordinate(row.user_id, {
            ...admission,
            userId: "20000000-0000-4000-8000-000000000001",
          })
        )).status
      ).toBe(503);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(0);
      const invalid = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: { payload: { unexpected: true } },
        })
      );
      expect(invalid.status).toBe(200);
      const value = yield* wait(invalid.json());
      expect(value).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "validation_failed" }, next: [] },
        },
      });
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ? AND outcome = 'rejected'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

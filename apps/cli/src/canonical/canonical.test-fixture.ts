import { type PATScope, TokenBearer } from "@fidy/server/client";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SavedGrant, apiOrigin } from "../credential/contract";
import type { CanonicalClientFactory, CanonicalDependencies } from "./contract";

const secretCharacters = 43;
export const bearer = `fin_abcd1234_${"s".repeat(secretCharacters)}`;
type QueryFixture = Readonly<{
  dependencies: CanonicalDependencies;
  stdout: Array<string>;
  stderr: Array<string>;
  requests: Array<string>;
}>;
type FixtureFactory = (
  response?: Readonly<{ body: string; status: number }>,
  scopes?: ReadonlyArray<PATScope>
) => QueryFixture;
export const makeCanonicalFixture =
  (clientFactory: CanonicalClientFactory): FixtureFactory =>
  (
    { body, status } = { body: '{"data":[],"next":[]}', status: 200 },
    scopes = ["read"]
  ): QueryFixture => {
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const requests: Array<string> = [];
    const grant = Schema.decodeSync(Schema.toCodecJson(SavedGrant))({
      origin: apiOrigin,
      pat: {
        _tag: "PAT",
        id: "01900000-0000-4000-8000-000000000001",
        shortId: "abcd1234",
        recipientLabel: "Mi agente",
        scopes,
        lifetimeDays: 7,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: "2099-01-01T00:00:00.000Z",
        expiresAt: "2099-01-08T00:00:00.000Z",
      },
    });
    const dependencies: CanonicalDependencies = {
      clientFactory,
      store: {
        load: Effect.succeedSome({ grant, bearer: Redacted.make(TokenBearer.make(bearer)) }),
        save: () => Effect.void,
        clear: Effect.void,
      },
      httpClient: HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              status,
              headers: { "content-type": "application/json", "retry-after": "12" },
            })
          );
        })
      ),
      readInput: () => Effect.succeed('{"query":{}}'),
      stdout: (text) =>
        Effect.sync(() => {
          stdout.push(text);
        }),
      stderr: (text) =>
        Effect.sync(() => {
          stderr.push(text);
        }),
      json: true,
    };
    return { dependencies, stdout, stderr, requests };
  };

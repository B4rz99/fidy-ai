import { Effect, Option, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import type {
  SentryAccountObservation,
  SentryProjectObservation,
  SentryStorageRegion,
} from "./account-policy";

const maximumProviderStringLength = 200;
const maximumProviderItemsPerPage = 100;
const providerString = Schema.String.check(Schema.isMaxLength(maximumProviderStringLength));
const maximumProviderItems = Schema.isMaxLength(maximumProviderItemsPerPage);
const OrganizationResponse = Schema.Struct({
  dataRegion: Schema.OptionFromOptionalKey(Schema.Struct({ name: providerString })),
});
const ProjectsResponse = Schema.Array(Schema.Struct({ slug: providerString })).check(
  maximumProviderItems
);
const ClientKeysResponse = Schema.Array(
  Schema.Struct({
    isActive: Schema.Boolean,
    rateLimit: Schema.OptionFromNullOr(
      Schema.Struct({
        window: Schema.Int,
        count: Schema.Int,
      })
    ),
  })
).check(maximumProviderItems);
const EnvironmentsResponse = Schema.Array(Schema.Struct({ name: providerString })).check(
  maximumProviderItems
);

/** A bounded management-API failure that cannot retain authenticated response data or locators. */
export class SentryAccountReadError extends Schema.TaggedErrorClass<SentryAccountReadError>()(
  "SentryAccountReadError",
  {
    reason: Schema.Literals([
      "unauthorized",
      "forbidden",
      "rate-limited",
      "unavailable",
      "unexpected-response",
    ]),
  }
) {}

/** Secret inputs used only while performing authenticated, read-only account inspection. */
export type SentryAccountReaderConfig = Readonly<{
  authToken: Redacted.Redacted;
  organizationSlug: Redacted.Redacted;
  productionProjectSlug: Redacted.Redacted;
  nonProductionProjectSlug: Redacted.Redacted;
}>;

const unauthorizedStatus = 401;
const forbiddenStatus = 403;
const rateLimitedStatus = 429;
const firstServerErrorStatus = 500;
const firstSuccessStatus = 200;
const firstRedirectionStatus = 300;
const maximumResponseBytes = 65_536;

type ResponseBody = Readonly<{
  chunks: ReadonlyArray<Uint8Array>;
  size: number;
}>;

const appendResponseChunk = (
  body: ResponseBody,
  chunk: Uint8Array
): Effect.Effect<ResponseBody, SentryAccountReadError> =>
  body.size + chunk.byteLength > maximumResponseBytes
    ? Effect.fail(SentryAccountReadError.make({ reason: "unexpected-response" }))
    : Effect.succeed({ chunks: [...body.chunks, chunk], size: body.size + chunk.byteLength });

const decodeResponseBody = (body: ResponseBody): string => {
  const bytes = new Uint8Array(body.size);
  let offset = 0;
  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const reasonForStatus = (status: number): SentryAccountReadError["reason"] => {
  switch (status) {
    case unauthorizedStatus:
      return "unauthorized";
    case forbiddenStatus:
      return "forbidden";
    case rateLimitedStatus:
      return "rate-limited";
    default:
      return status >= firstServerErrorStatus ? "unavailable" : "unexpected-response";
  }
};

const successfulResponse = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<HttpClientResponse.HttpClientResponse, SentryAccountReadError> =>
  response.status >= firstSuccessStatus && response.status < firstRedirectionStatus
    ? Effect.succeed(response)
    : Effect.fail(SentryAccountReadError.make({ reason: reasonForStatus(response.status) }));

const readJson = <A>(input: {
  readonly url: string;
  readonly token: Redacted.Redacted;
  readonly schema: Schema.Codec<A, unknown>;
}): Effect.Effect<A, SentryAccountReadError, HttpClient.HttpClient> =>
  HttpClientRequest.get(input.url).pipe(
    HttpClientRequest.bearerToken(Redacted.value(input.token)),
    HttpClientRequest.acceptJson,
    HttpClient.execute,
    Effect.flatMap(successfulResponse),
    Effect.filterOrFail(
      (response) => (response.headers["link"] ?? "").trim().length === 0,
      () => SentryAccountReadError.make({ reason: "unexpected-response" })
    ),
    Effect.flatMap((response) =>
      Stream.runFoldEffect(response.stream, () => ({ chunks: [], size: 0 }), appendResponseChunk)
    ),
    Effect.map(decodeResponseBody),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(input.schema))),
    Effect.mapError((error) =>
      Schema.is(SentryAccountReadError)(error)
        ? error
        : SentryAccountReadError.make({ reason: "unexpected-response" })
    )
  );

const normalizedRegion = (name: Option.Option<string>): Option.Option<SentryStorageRegion> =>
  Option.flatMap(name, (value) => {
    switch (value) {
      case "us":
        return Option.some("us");
      case "de":
      case "eu":
        return Option.some("eu");
      default:
        return Option.none();
    }
  });

const inspectProject = (input: {
  readonly baseUrl: string;
  readonly organization: string;
  readonly project: string;
  readonly token: Redacted.Redacted;
  readonly exists: boolean;
}): Effect.Effect<
  Option.Option<SentryProjectObservation>,
  SentryAccountReadError,
  HttpClient.HttpClient
> =>
  input.exists
    ? Effect.gen(function* () {
        const projectPath = `${input.baseUrl}/projects/${encodeURIComponent(input.organization)}/${encodeURIComponent(input.project)}`;
        const keys = yield* readJson({
          url: `${projectPath}/keys/`,
          token: input.token,
          schema: ClientKeysResponse,
        });
        const environments = yield* readJson({
          url: `${projectPath}/environments/`,
          token: input.token,
          schema: EnvironmentsResponse,
        });
        const activeKeys = keys.filter((key) => key.isActive);
        return Option.some({
          activeClientKeyRateLimits: activeKeys.map((key) =>
            Option.map(key.rateLimit, (limit) => ({
              windowSeconds: limit.window,
              errorCount: limit.count,
            }))
          ),
          environments: environments.map((environment) => environment.name),
        });
      })
    : Effect.succeed(Option.none());

/** Sanitized observation used when the management API itself cannot be inspected. */
export const unavailableSentryAccountObservation: SentryAccountObservation = {
  _tag: "unavailable",
};

/** Reads Sentry organization/project state without mutating it and drops all account locators. */
export const inspectSentryAccount = (
  config: SentryAccountReaderConfig
): Effect.Effect<SentryAccountObservation, SentryAccountReadError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const baseUrl = "https://sentry.io/api/0";
    const organization = Redacted.value(config.organizationSlug);
    const production = Redacted.value(config.productionProjectSlug);
    const nonProduction = Redacted.value(config.nonProductionProjectSlug);
    const organizationPath = `${baseUrl}/organizations/${encodeURIComponent(organization)}`;
    const organizationResponse = yield* readJson({
      url: `${organizationPath}/`,
      token: config.authToken,
      schema: OrganizationResponse,
    });
    const projects = yield* readJson({
      url: `${organizationPath}/projects/`,
      token: config.authToken,
      schema: ProjectsResponse,
    });
    const projectSlugs = new Set(projects.map((project) => project.slug));
    const productionObservation = yield* inspectProject({
      baseUrl,
      organization,
      project: production,
      token: config.authToken,
      exists: projectSlugs.has(production),
    });
    const nonProductionObservation = yield* inspectProject({
      baseUrl,
      organization,
      project: nonProduction,
      token: config.authToken,
      exists: projectSlugs.has(nonProduction),
    });
    return {
      _tag: "available" as const,
      storageRegion: normalizedRegion(
        Option.map(organizationResponse.dataRegion, (region) => region.name)
      ),
      projectsAreDistinct: production !== nonProduction,
      production: productionObservation,
      nonProduction: nonProductionObservation,
    };
  });

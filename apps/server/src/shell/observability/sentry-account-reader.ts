import { TaggedSerializableError, jsonStringSchema } from "~/schema-compatibility";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  type BoundedExternalHttpClient,
  type BoundedExternalHttpResponse,
  makeBoundedExternalHttpClient,
} from "~/shell/_shared/bounded-external-http";
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
  dataRegion: Schema.OptionFromOptionalKey(Schema.NullOr(Schema.Struct({ name: providerString }))),
  links: Schema.OptionFromOptionalKey(
    Schema.Struct({
      regionUrl: Schema.String.check(Schema.isMaxLength(maximumProviderStringLength)),
    })
  ),
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
export class SentryAccountReadError extends TaggedSerializableError<SentryAccountReadError>()(
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

/** Redacted credentials consumed by the operator-only Sentry account verification command. */
export const sentryAccountConfig = Config.all({
  authToken: Config.redacted("SENTRY_AUTH_TOKEN"),
  organizationSlug: Config.redacted("SENTRY_ORGANIZATION_SLUG"),
  productionProjectSlug: Config.redacted("SENTRY_PRODUCTION_PROJECT_SLUG"),
  nonProductionProjectSlug: Config.redacted("SENTRY_NON_PRODUCTION_PROJECT_SLUG"),
});

const unauthorizedStatus = 401;
const forbiddenStatus = 403;
const rateLimitedStatus = 429;
const firstServerErrorStatus = 500;
const firstSuccessStatus = 200;
const firstRedirectionStatus = 300;
const maximumResponseBytes = 65_536;

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

const isSuccessfulStatus = (status: number): boolean =>
  status >= firstSuccessStatus && status < firstRedirectionStatus;

const hasUnboundedNextPage = (link: string): boolean =>
  link.split(",").some((entry) => {
    const hasNextRelation = entry.includes('rel="next"') || entry.includes("rel=next");
    const hasNoMoreResults = entry.includes('results="false"') || entry.includes("results=false");
    return hasNextRelation && !hasNoMoreResults;
  });

const successfulResponse = (
  response: BoundedExternalHttpResponse
): Effect.Effect<BoundedExternalHttpResponse, SentryAccountReadError> =>
  isSuccessfulStatus(response.status)
    ? Effect.succeed(response)
    : Effect.fail(SentryAccountReadError.make({ reason: reasonForStatus(response.status) }));

const readJson = function <A>(input: {
  readonly client: BoundedExternalHttpClient;
  readonly url: string;
  readonly token: Redacted.Redacted;
  readonly schema: Schema.Codec<A, unknown>;
}): Effect.Effect<A, SentryAccountReadError> {
  const request = HttpClientRequest.get(input.url).pipe(
    HttpClientRequest.bearerToken(Redacted.value(input.token)),
    HttpClientRequest.acceptJson
  );
  return input.client.execute(request, maximumResponseBytes).pipe(
    Effect.flatMap(successfulResponse),
    Effect.filterOrFail(
      (response) => !hasUnboundedNextPage(response.headers["link"] ?? ""),
      () => SentryAccountReadError.make({ reason: "unexpected-response" })
    ),
    Effect.map((response) => new TextDecoder().decode(response.body)),
    Effect.flatMap(Schema.decodeUnknownEffect(jsonStringSchema(input.schema))),
    Effect.mapError((error) =>
      Schema.is(SentryAccountReadError)(error)
        ? error
        : SentryAccountReadError.make({ reason: "unexpected-response" })
    )
  );
};

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

const regionNameFromUrl = (value: string): Option.Option<string> => {
  const url = Schema.decodeOption(Schema.URLFromString)(value);
  return Option.flatMap(url, (candidate) =>
    candidate.protocol === "https:"
      ? Option.fromUndefinedOr(candidate.hostname.split(".")[0])
      : Option.none()
  );
};

const inspectProject = (input: {
  readonly client: BoundedExternalHttpClient;
  readonly baseUrl: string;
  readonly organization: string;
  readonly project: string;
  readonly token: Redacted.Redacted;
  readonly exists: boolean;
}): Effect.Effect<Option.Option<SentryProjectObservation>, SentryAccountReadError> =>
  input.exists
    ? Effect.gen(function* () {
        const projectPath = `${input.baseUrl}/projects/${encodeURIComponent(input.organization)}/${encodeURIComponent(input.project)}`;
        const keys = yield* readJson({
          client: input.client,
          url: `${projectPath}/keys/`,
          token: input.token,
          schema: ClientKeysResponse,
        });
        const environments = yield* readJson({
          client: input.client,
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

const inspectProtectedSentryAccount = (
  config: SentryAccountReaderConfig,
  client: BoundedExternalHttpClient
): Effect.Effect<SentryAccountObservation, SentryAccountReadError> =>
  Effect.gen(function* () {
    const baseUrl = "https://sentry.io/api/0";
    const organization = Redacted.value(config.organizationSlug);
    const production = Redacted.value(config.productionProjectSlug);
    const nonProduction = Redacted.value(config.nonProductionProjectSlug);
    const organizationPath = `${baseUrl}/organizations/${encodeURIComponent(organization)}`;
    const organizationResponse = yield* readJson({
      client,
      url: `${organizationPath}/`,
      token: config.authToken,
      schema: OrganizationResponse,
    });
    const projects = yield* readJson({
      client,
      url: `${organizationPath}/projects/`,
      token: config.authToken,
      schema: ProjectsResponse,
    });
    const projectSlugs = new Set(projects.map((project) => project.slug));
    const productionObservation = yield* inspectProject({
      client,
      baseUrl,
      organization,
      project: production,
      token: config.authToken,
      exists: projectSlugs.has(production),
    });
    const nonProductionObservation = yield* inspectProject({
      client,
      baseUrl,
      organization,
      project: nonProduction,
      token: config.authToken,
      exists: projectSlugs.has(nonProduction),
    });
    return {
      _tag: "available" as const,
      storageRegion: normalizedRegion(
        Option.orElse(
          Option.flatMap(organizationResponse.dataRegion, (region) =>
            region === null ? Option.none() : Option.some(region.name)
          ),
          () =>
            Option.flatMap(organizationResponse.links, (links) =>
              regionNameFromUrl(links.regionUrl)
            )
        )
      ),
      projectsAreDistinct: production !== nonProduction,
      production: productionObservation,
      nonProduction: nonProductionObservation,
    };
  });

/** Reads Sentry organization/project state without mutating it and drops all account locators. */
export const inspectSentryAccount = (
  config: SentryAccountReaderConfig
): Effect.Effect<SentryAccountObservation, SentryAccountReadError, HttpClient.HttpClient> =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    inspectProtectedSentryAccount(config, httpClient.pipe(makeBoundedExternalHttpClient("sentry")))
  );

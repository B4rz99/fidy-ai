import { jsonStringSchema } from "~/shell/schema-codecs/contract";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import type { OutboundHttpResponse, SentryAccountResource } from "~/shell/outbound-http/contract";
import { OutboundHttp, type OutboundHttpService } from "~/shell/outbound-http/operations";
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
export class SentryAccountReadError extends Schema.TaggedError<SentryAccountReadError>()(
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

/** Redacted account locators used only while performing read-only Sentry inspection. */
export type SentryAccountReaderConfig = Readonly<{
  organizationSlug: Redacted.Redacted;
  productionProjectSlug: Redacted.Redacted;
  nonProductionProjectSlug: Redacted.Redacted;
}>;

/** Redacted account locators consumed by the operator-only Sentry verification command. */
export const sentryAccountConfig = Config.all({
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
  response: OutboundHttpResponse
): Effect.Effect<OutboundHttpResponse, SentryAccountReadError> =>
  isSuccessfulStatus(response.status)
    ? Effect.succeed(response)
    : Effect.fail(SentryAccountReadError.make({ reason: reasonForStatus(response.status) }));

const readJson = function <A>(input: {
  readonly outboundHttp: OutboundHttpService;
  readonly resource: SentryAccountResource;
  readonly schema: Schema.Codec<A, unknown>;
}): Effect.Effect<A, SentryAccountReadError> {
  return input.outboundHttp.execute({ _tag: "SentryAccount", resource: input.resource }).pipe(
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
  readonly outboundHttp: OutboundHttpService;
  readonly organization: Redacted.Redacted;
  readonly project: Redacted.Redacted;
  readonly exists: boolean;
}): Effect.Effect<Option.Option<SentryProjectObservation>, SentryAccountReadError> =>
  input.exists
    ? Effect.gen(function* () {
        const keys = yield* readJson({
          outboundHttp: input.outboundHttp,
          resource: {
            _tag: "ProjectKeys",
            organizationSlug: input.organization,
            projectSlug: input.project,
          },
          schema: ClientKeysResponse,
        });
        const environments = yield* readJson({
          outboundHttp: input.outboundHttp,
          resource: {
            _tag: "ProjectEnvironments",
            organizationSlug: input.organization,
            projectSlug: input.project,
          },
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
    : Effect.succeedNone;

/** Sanitized observation used when the management API itself cannot be inspected. */
export const unavailableSentryAccountObservation: SentryAccountObservation = {
  _tag: "unavailable",
};

const inspectProtectedSentryAccount = (
  config: SentryAccountReaderConfig,
  outboundHttp: OutboundHttpService
): Effect.Effect<SentryAccountObservation, SentryAccountReadError> =>
  Effect.gen(function* () {
    const production = Redacted.value(config.productionProjectSlug);
    const nonProduction = Redacted.value(config.nonProductionProjectSlug);
    const organizationResponse = yield* readJson({
      outboundHttp,
      resource: { _tag: "Organization", organizationSlug: config.organizationSlug },
      schema: OrganizationResponse,
    });
    const projects = yield* readJson({
      outboundHttp,
      resource: { _tag: "OrganizationProjects", organizationSlug: config.organizationSlug },
      schema: ProjectsResponse,
    });
    const projectSlugs = new Set(projects.map((project) => project.slug));
    const productionObservation = yield* inspectProject({
      outboundHttp,
      organization: config.organizationSlug,
      project: config.productionProjectSlug,
      exists: projectSlugs.has(production),
    });
    const nonProductionObservation = yield* inspectProject({
      outboundHttp,
      organization: config.organizationSlug,
      project: config.nonProductionProjectSlug,
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
): Effect.Effect<SentryAccountObservation, SentryAccountReadError, OutboundHttp> =>
  Effect.flatMap(OutboundHttp, (outboundHttp) =>
    inspectProtectedSentryAccount(config, outboundHttp)
  );

import { Exit, Schema } from "effect";
import { contractDigestPattern, gitRevisionPattern } from "./release-identity";

const ReleaseConfiguration = Schema.Struct({
  CONTRACT_DIGEST: Schema.String.check(Schema.isPattern(contractDigestPattern)),
  RELEASE_GIT_SHA: Schema.String.check(Schema.isPattern(gitRevisionPattern)),
});

type CoreEnvironment = typeof ReleaseConfiguration.Type;

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;

const jsonResponse = (body: string, status: number): Response =>
  new Response(body, { headers: jsonHeaders, status });

const fetch = (request: Request, environment: CoreEnvironment): Response => {
  const url = new URL(request.url);
  if (url.pathname !== "/health") {
    return jsonResponse('{"status":"not_found"}', HTTP_NOT_FOUND);
  }
  if (request.method !== "GET") {
    return new Response('{"status":"method_not_allowed"}', {
      headers: { ...jsonHeaders, allow: "GET" },
      status: 405,
    });
  }

  const configuration = Schema.decodeExit(ReleaseConfiguration)(environment);
  if (Exit.isFailure(configuration)) {
    return jsonResponse('{"status":"unavailable"}', HTTP_SERVICE_UNAVAILABLE);
  }

  return jsonResponse(
    JSON.stringify({
      contractDigest: configuration.value.CONTRACT_DIGEST,
      gitRevision: configuration.value.RELEASE_GIT_SHA,
      status: "available",
    }),
    HTTP_OK
  );
};

/** Private service-binding target that exposes only bounded topology health evidence. */
export default { fetch } satisfies ExportedHandler<CoreEnvironment>;

import type { AcceptanceWindowBindings } from "./contract";
import { backgroundWorkAllowed } from "./operations";
import { deploymentPhase } from "./internal/deployment";
import { env } from "cloudflare:workers";
import { type ManagedRuntime, Option, Predicate, Schema } from "effect";

const Fixture = Schema.declare<Pick<Fetcher, "fetch">>(
  (value): value is Pick<Fetcher, "fetch"> =>
    Predicate.hasProperty(value, "fetch") && Predicate.isFunction(value.fetch)
);

const Configuration = Schema.Struct({
  NATIVE_STORAGE_ADMISSION: Schema.optional(Schema.String),
  SQLITE_STORAGE_RELEASE: Schema.optional(Schema.Unknown),
  RECOVERY_ISOLATION: Schema.optional(Schema.String),
  RELEASE_FIXTURE: Schema.optional(Fixture),
  CLOUDFLARE_ACCESS_ISSUER: Schema.optional(Schema.String),
});

const denied = (): Promise<Response> =>
  Promise.resolve(new Response(null, { status: 503, headers: { "cache-control": "no-store" } }));

const firstRedirectStatus = 300,
  firstClientErrorStatus = 400;

const rejectKeyRedirect = (response: Response): Response | Promise<Response> => {
  if (response.status < firstRedirectStatus || response.status >= firstClientErrorStatus) {
    return response;
  }

  response.body?.cancel().catch(() => undefined);

  return denied();
};

const pinnedKeys = (request: Request, issuer: string): boolean =>
  /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(issuer) &&
  request.method === "GET" &&
  request.url === issuer + "/cdn-cgi/access/certs";

export const fetchForInstalledRelease = ({
  transport,
  bindings = env,
}: { transport: typeof fetch } & Partial<Readonly<{ bindings: unknown }>>): typeof fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const settings = Schema.decodeUnknownOption(Configuration)(bindings);

      if (Option.isNone(settings)) return denied();
      const config = settings.value;
      const phase = deploymentPhase(config);

      if (phase === "normal" || phase === "open") return transport(input, init);

      if (phase !== "closed") return denied();
      const request = new Request(input, init);

      if (pinnedKeys(request, config.CLOUDFLARE_ACCESS_ISSUER ?? "")) {
        return transport(request.url, {
          method: "GET",
          redirect: "manual",
          signal: request.signal,
          headers: { accept: "application/json" },
        }).then(rejectKeyRedirect);
      }

      if (config.RELEASE_FIXTURE === undefined) return denied();

      return config.RELEASE_FIXTURE.fetch(request);
    },
    {
      preconnect: (...args: Parameters<typeof transport.preconnect>): void => {
        const config = Schema.decodeUnknownOption(Configuration)(bindings);

        if (Option.isSome(config) && ["normal", "open"].includes(deploymentPhase(config.value))) {
          transport.preconnect(...args);
        }
      },
    }
  );

export const runInstalledBackgroundRequest = ({
  runtime,
  settings,
  run,
}: {
  runtime: Pick<ManagedRuntime.ManagedRuntime<never, never>, "runPromise">;
  settings: AcceptanceWindowBindings;
  run: () => Promise<Response>;
}): Promise<Response> =>
  runtime
    .runPromise(backgroundWorkAllowed(settings))
    .then((allowed) => (allowed ? run() : new Response(null, { status: 403 })));

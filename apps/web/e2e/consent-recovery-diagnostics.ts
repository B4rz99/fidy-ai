import type { Request, Response, TestInfo } from "@playwright/test";
import { Effect, Option, Schema, type Scope } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";

const { api } = browserAcceptanceTopology();
type ConsentRecoveryRequest = Pick<Request, "url" | "method">;
type ConsentRecoveryResponse = Pick<Response, "status"> &
  Readonly<{
    request: () => ConsentRecoveryRequest;
  }>;
type ConsentRecoveryListener = {
  (event: "request", listener: (request: ConsentRecoveryRequest) => void): void;
  (event: "requestfailed", listener: (request: ConsentRecoveryRequest) => void): void;
  (event: "response", listener: (response: ConsentRecoveryResponse) => void): void;
};
export type ConsentRecoveryPage = Readonly<{
  on: ConsentRecoveryListener;
  off: ConsentRecoveryListener;
}>;

const maximumHttpStatus = 599;
const ConsentRecoveryStage = Schema.Literals([
  "initial-transactions",
  "opening-review",
  "review-visible",
  "leaving-review",
  "consent-held",
  "consent-failed",
  "retry",
]);
const ConsentRecoveryObservation = Schema.Struct({
  stage: ConsentRecoveryStage,
  observedStage: ConsentRecoveryStage,
  resource: Schema.Literals(["consent", "session", "profile", "categories", "transactions"]),
  status: Schema.Union([
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: maximumHttpStatus })),
    Schema.Literals(["requested", "failed"]),
  ]),
});
const consentResources: ReadonlyMap<string, typeof ConsentRecoveryObservation.Type.resource> =
  new Map([
    ["/web/consent", "consent"],
    ["/web/session/binding", "session"],
    ["/user", "profile"],
    ["/categories", "categories"],
    ["/transactions", "transactions"],
  ]);
const consentRecoveryResource = (
  request: ConsentRecoveryRequest
): Option.Option<typeof ConsentRecoveryObservation.Type.resource> => {
  const url = URL.parse(request.url());
  if (url?.origin !== api || request.method() !== "GET") return Option.none();
  return Option.fromUndefinedOr(consentResources.get(url.pathname));
};

const attachConsentRecovery = Effect.fnUntraced(function* (
  information: Pick<TestInfo, "attach">,
  observations: ReadonlyArray<typeof ConsentRecoveryObservation.Type>
) {
  const body = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(ConsentRecoveryObservation))
  )(observations);
  yield* Effect.tryPromise(() =>
    information.attach("consent-recovery-statuses", {
      body,
      contentType: "application/json",
    })
  );
});

export const observeConsentRecovery = ({
  page,
  information,
}: Readonly<{
  page: ConsentRecoveryPage;
  information: Pick<TestInfo, "attach">;
}>): Effect.Effect<
  Readonly<{ mark: (stage: typeof ConsentRecoveryStage.Type) => void }>,
  never,
  Scope.Scope
> => {
  const observations: Array<typeof ConsentRecoveryObservation.Type> = [];
  const maximumObservations = 32;
  let stage: typeof ConsentRecoveryObservation.Type.stage = "initial-transactions";
  const requests = new WeakMap<
    ConsentRecoveryRequest,
    typeof ConsentRecoveryObservation.Type.stage
  >();
  const record = (
    request: ConsentRecoveryRequest,
    status: typeof ConsentRecoveryObservation.Type.status
  ): void => {
    const resource = consentRecoveryResource(request);
    const requestedStage = requests.get(request);
    if (requestedStage === undefined) return;
    if (Option.isNone(resource) || observations.length >= maximumObservations) return;
    observations.push({
      stage: requestedStage,
      observedStage: stage,
      resource: resource.value,
      status,
    });
  };
  const requested = (request: ConsentRecoveryRequest): void => {
    requests.set(request, stage);
    record(request, "requested");
  };
  const observe = (response: ConsentRecoveryResponse): void =>
    record(response.request(), response.status());
  const failed = (request: ConsentRecoveryRequest): void => record(request, "failed");
  return Effect.acquireRelease(
    Effect.sync(() => {
      page.on("request", requested);
      page.on("response", observe);
      page.on("requestfailed", failed);
      return {
        mark: (nextStage) => {
          stage = nextStage;
        },
      };
    }),
    () =>
      Effect.gen(function* () {
        page.off("request", requested);
        page.off("response", observe);
        page.off("requestfailed", failed);
        yield* attachConsentRecovery(information, observations);
      }).pipe(Effect.interruptible, Effect.timeout("1 second"), Effect.ignoreCause)
  );
};

import { Data, type DateTime, Effect, Option, Schema, pipe } from "effect";
import { HttpClientError } from "effect/http";
import { forwardFreshQuery, freshQuery } from "@/transport/fresh-query";
import { AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient, InitialTransactionPage } from "@/transport/client";
import { revalidateWorkspaceQuery, workspaceQueryRetention } from "@/transport/workspace-query";

type Client = FidyClient["Service"];

type Failure = Effect.Error<ReturnType<Client["transactions"]["listTransactions"]>>;

type Result = AsyncResult.AsyncResult<CanonicalSuccess<"transactions.listTransactions">, Failure>;

type PeriodBounds = Readonly<{
  from: DateTime.Utc;
  to: DateTime.Utc;
}>;

class Period extends Data.Class<
  PeriodBounds &
    Readonly<{
      client: FidyClient;
    }>
> {}

type InitialPage = Atom.Writable<Option.Option<Result>, Option.Option<Result>>;

const initialPages = Atom.family((_period: Period): InitialPage =>
  Atom.make<Option.Option<Result>>(Option.none()).pipe(
    Atom.setIdleTTL(workspaceQueryRetention.timeToLive)
  )
);

const makeSource = (period: Period): Atom.Atom<Result> => {
  const initial = initialPages(period);

  const remote = freshQuery({
    runtime: period.client.runtime,
    load: period.client
      .use((client) =>
        client.transactions.listTransactions({
          query: { from: period.from, to: period.to, limit: 25 },
        })
      )
      .pipe(
        Effect.catchIf(
          (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
          Effect.die
        )
      ),
    decorate: Atom.setIdleTTL(workspaceQueryRetention.timeToLive),
  });

  const source = Atom.readable(
    (get) => Option.getOrElse(get(initial), () => get(remote)),
    (refresh) => {
      refresh(remote);
      refresh(initial);
    }
  ).pipe(Atom.setIdleTTL(workspaceQueryRetention.timeToLive));

  return forwardFreshQuery({
    query: source,
    sources: [remote],
    before: (registry) => registry.set(initial, Option.none()),
  });
};

const sources = Atom.family(makeSource);

const views = Atom.family((source: Atom.Atom<Result>) =>
  forwardFreshQuery({ query: source.pipe(revalidateWorkspaceQuery), sources: [source] })
);

export const transactionFirstPage = ({
  client,
  period,
}: Readonly<{
  client: FidyClient;
  period: PeriodBounds;
}>): Atom.Atom<Result> =>
  pipe(new Period({ client, from: period.from, to: period.to }), sources, views);

export const transactionPageInitialValue = ({
  client,
  page,
  timestamp,
}: Readonly<{
  client: FidyClient;
  page: InitialTransactionPage;
  timestamp: number;
}>): readonly [InitialPage, Option.Option<Result>] => [
  initialPages(new Period({ client, from: page.from, to: page.to })),
  Option.some(AsyncResult.success(page.page, { timestamp })),
];

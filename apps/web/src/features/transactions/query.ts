import { type Context, Data, type DateTime, type Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient, InitialTransactionPage } from "@/transport/client";
import { revalidateWorkspaceQuery, workspaceQueryRetention } from "@/transport/workspace-query";

type Client = Context.Service.Shape<FidyClient>;
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
// Each weak family returns its mounted Atom, never an unretained container or another family.
const initialPages = Atom.family((_period: Period): InitialPage =>
  Atom.make<Option.Option<Result>>(Option.none()).pipe(Atom.setIdleTTL("1 minute"))
);
const makeSource = (period: Period): Atom.Atom<Result> => {
  const initial = initialPages(period);
  const remote = period.client.query("transactions", "listTransactions", {
    ...workspaceQueryRetention,
    query: { from: period.from, to: period.to, limit: 25 },
  });
  return Atom.readable(
    (get) => Option.getOrElse(get(initial), () => get(remote)),
    (refresh) => {
      refresh(remote);
      refresh(initial);
    }
  ).pipe(Atom.setIdleTTL("1 minute"), revalidateWorkspaceQuery);
};
const sources = Atom.family(makeSource);
/** One canonical page owner; the fresh bootstrap handoff is retired on explicit refresh. */
export const transactionFirstPage = ({
  client,
  period,
}: Readonly<{
  client: FidyClient;
  period: PeriodBounds;
}>): Atom.Atom<Result> => sources(new Period({ client, from: period.from, to: period.to }));
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

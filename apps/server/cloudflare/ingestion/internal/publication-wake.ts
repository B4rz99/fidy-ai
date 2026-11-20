import { Clock, Context, Effect } from "effect";

export const StatementPublicationWake = Context.Reference<Effect.Effect<void>>(
  "@fidy/server/cloudflare/ingestion/StatementPublicationWake",
  { defaultValue: () => Effect.void }
);

export const withPublicationWake =
  (schedule: (dueAtMs: number) => Promise<void>) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(
      work,
      StatementPublicationWake,
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((due) =>
          Effect.tryPromise({ try: () => schedule(due), catch: () => undefined })
        ),
        Effect.ignore
      )
    );

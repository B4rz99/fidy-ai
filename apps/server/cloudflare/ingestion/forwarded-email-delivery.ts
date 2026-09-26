import { Option, Schema } from "effect";

/** Versioned, secret-free identity from the private forwarded-email Queue. */
export const ForwardedEmailWork = Schema.Struct({
  receiptId: Schema.String.check(Schema.isUUID()),
  userId: Schema.String.check(Schema.isUUID()),
});

/** Route only decoded work to its User coordinator. No Queue identity conveys authority: the
 * coordinator rechecks ownership, Consent, retention, and the outcome before reading R2.
 * A failed coordinator call rejects for Queue redelivery; cron also reoffers unsettled receipts.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const receiveForwardedEmailWork =
  // @effect-diagnostics-next-line asyncFunction:off
  async (
    messages: ReadonlyArray<Readonly<{ body: unknown; ack: () => void }>>,
    coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>
  ): Promise<void> => {
    await Promise.all(
      messages.map((message) => {
        const work = Schema.decodeUnknownOption(ForwardedEmailWork)(message.body);
        if (Option.isNone(work)) {
          message.ack();
          return Promise.resolve();
        }
        return coordinator
          .getByName(work.value.userId)
          .fetch(
            new Request("https://coordinator.internal/forwarded-email-work", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: Schema.encodeSync(Schema.fromJsonString(ForwardedEmailWork))(work.value),
            })
          )
          .then((response) => {
            if (!response.ok) throw new Error("Forwarded email coordinator unavailable");
            message.ack();
          });
      })
    );
  };

/** Recognize a versioned identity-only Queue message before routing to User coordination. */
export const isForwardedEmailWork = (body: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(ForwardedEmailWork)(body));

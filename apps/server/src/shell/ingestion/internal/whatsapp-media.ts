import { Crypto, Data, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { maximumStatementBytes } from "~/core/ingestion/contract";
import type {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppMediaId,
} from "~/shell/channels/whatsapp/contract";
import type { OutboundHttpService } from "~/shell/outbound-http/operations";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { Hex } from "effect/encoding";
import { StatementContentDigest } from "~/shell/ingestion/contract";

const Mime = Schema.Literals([
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const Metadata = Schema.Struct({
  id: Schema.String,
  mime_type: Mime,
  sha256: StatementContentDigest,
  file_size: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: maximumStatementBytes })
  ),
  download_url: Schema.String,
  download_url_expires_at: Schema.String,
});
const Media = Schema.Struct({
  bytes: Schema.Uint8Array,
  sha256: StatementContentDigest,
  mimeType: Mime,
});
const maximumSignedMediaTokenLength = 8192;
const signedToken = Schema.NonEmptyString.check(Schema.isMaxLength(maximumSignedMediaTokenLength));
const httpOK = 200;
class StatementMediaUnavailable extends Data.TaggedError("StatementMediaUnavailable")<{}> {}

const readSignedToken = (
  value: string
): Effect.Effect<Redacted.Redacted<string>, StatementMediaUnavailable> =>
  Effect.gen(function* () {
    const url = yield* Effect.try(() => new URL(value));
    if (
      url.origin !== "https://api.kapso.ai" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.pathname !== "/meta/whatsapp/media_download"
    ) {
      return yield* new StatementMediaUnavailable();
    }
    const token = Schema.decodeUnknownOption(signedToken)(url.searchParams.get("token"));
    if ([...url.searchParams.keys()].length !== 1 || Option.isNone(token)) {
      return yield* new StatementMediaUnavailable();
    }
    return Redacted.make(token.value);
  }).pipe(Effect.mapError(() => new StatementMediaUnavailable()));

/** Provider URLs never become transport coordinates. Only a validated signed token may reach
 * the fixed Kapso download operation, which deliberately carries no project credential headers.
 */
export const readWhatsAppStatementMedia = ({
  outbound,
  mediaId,
  businessPhoneNumberId,
  current,
}: Readonly<{
  outbound: OutboundHttpService;
  mediaId: WhatsAppMediaId;
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  current: number;
}>): Effect.Effect<typeof Media.Type, StatementMediaUnavailable, Crypto.Crypto> =>
  Effect.gen(function* () {
    const response = yield* outbound.execute({
      _tag: "KapsoMediaMetadata",
      mediaId,
      businessPhoneNumberId,
    });
    if (response.status !== httpOK) return yield* new StatementMediaUnavailable();
    const json = yield* Schema.decodeEffect(UnknownJsonString)(
      new TextDecoder().decode(response.body)
    );
    const metadata = yield* Schema.decodeUnknownEffect(Metadata)(json);
    const expiry = DateTime.make(metadata.download_url_expires_at);
    if (
      metadata.id !== mediaId ||
      Option.isNone(expiry) ||
      DateTime.toEpochMillis(expiry.value) <= current
    ) {
      return yield* new StatementMediaUnavailable();
    }
    const token = yield* readSignedToken(metadata.download_url);
    const download = yield* outbound.execute({ _tag: "KapsoMediaDownload", token });
    if (download.status !== httpOK || download.body.length !== metadata.file_size) {
      return yield* new StatementMediaUnavailable();
    }
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", download.body);
    if (Hex.encode(digest) !== metadata.sha256) return yield* new StatementMediaUnavailable();
    return { bytes: download.body, sha256: metadata.sha256, mimeType: metadata.mime_type };
  }).pipe(Effect.mapError(() => new StatementMediaUnavailable()));

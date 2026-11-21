import { DateTime, Duration, Option, Schema } from "effect";
import { ManualPATGrantInput, User } from "@/transport/client";

export const PATDraft = Schema.Struct({
  recipientLabel: ManualPATGrantInput.fields.recipientLabel,
  scopes: ManualPATGrantInput.fields.scopes,
  lifetimeDays: ManualPATGrantInput.fields.lifetimeDays,
});

export type PATDraft = typeof PATDraft.Type;

const StoredDraft = Schema.Struct({
  version: Schema.Literal(1),
  userId: User.fields.id,
  expiresAt: Schema.Finite,
  draft: PATDraft,
});

const key = "fidy:pat-identity-confirmation";

const handoffMinutes = 20;

const lifetimeMilliseconds = Duration.toMillis(Duration.minutes(handoffMinutes));

const maximumBytes = 2048;

export const preservePATDraft = ({
  userId,
  draft,
}: Readonly<{ userId: string; draft: PATDraft }>): boolean => {
  try {
    window.sessionStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        userId,
        draft,
        expiresAt: DateTime.nowUnsafe().epochMilliseconds + lifetimeMilliseconds,
      })
    );

    return true;
  } catch {
    return false;
  }
};

export const resumePATDraft = (userId: string): Option.Option<PATDraft> => {
  try {
    const raw = window.sessionStorage.getItem(key);
    window.sessionStorage.removeItem(key);

    if (raw === null || raw.length > maximumBytes) return Option.none();
    const decoded = Schema.decodeOption(Schema.fromJsonString(StoredDraft))(raw);

    const now = DateTime.nowUnsafe().epochMilliseconds;

    return Option.flatMap(decoded, (saved) =>
      saved.userId === userId &&
      saved.expiresAt > now &&
      saved.expiresAt <= now + lifetimeMilliseconds
        ? Option.some(saved.draft)
        : Option.none()
    );
  } catch {
    return Option.none();
  }
};

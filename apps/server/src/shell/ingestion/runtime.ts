import type { Effect, FileSystem, Path, PlatformError } from "effect";
import type { EmailCatalogGenerationFailed } from "./contract";
import { generateNotificationEmailCatalog as generateCatalog } from "~/shell/ingestion/internal/email-interpretation/generate";

/**
 * Owner tooling composition for the checked-in email catalog. Check mode refuses stale output;
 * generation writes only the owner-private artifact and never publishes formats or fixtures.
 */
export const generateNotificationEmailCatalog = (
  check: boolean
): Effect.Effect<
  void,
  EmailCatalogGenerationFailed | PlatformError.PlatformError | PlatformError.BadArgument,
  FileSystem.FileSystem | Path.Path
> => generateCatalog(check);

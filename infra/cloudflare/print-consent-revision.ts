import { currentDisclosureFor } from "@fidy/server/consent-operations";

process.stdout.write(currentDisclosureFor().revision);

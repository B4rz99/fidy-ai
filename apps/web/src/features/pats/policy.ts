import { Duration } from "effect";

const bearerRevealMinutes = 10;

/** Maximum lifetime of a disclosed PAT in the view and a matching clipboard. */
export const bearerRevealLifetime = Duration.minutes(bearerRevealMinutes);

const formatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

/** Display privacy evidence times in Colombian local time, independently of the browser's time zone. */
export const formatPrivacyTime = (epochMilliseconds: number): string =>
  `${formatter.format(epochMilliseconds)} (hora de Colombia)`;

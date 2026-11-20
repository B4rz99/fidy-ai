const formatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

export const formatPrivacyTime = (epochMilliseconds: number): string =>
  `${formatter.format(epochMilliseconds)} (hora de Colombia)`;

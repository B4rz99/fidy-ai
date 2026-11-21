import { DateTime, Option } from "effect";
import type { RequestKind, TitularCase } from "./contract";

const monthDayOffset = 5;

const consultationDays = 10;

const complaintDays = 15;

const consultationExtensionDays = 5;

const complaintExtensionDays = 8;

const completionDays = 5;

const completionMonths = 2;

const bogotaZone = DateTime.zoneMakeNamedUnsafe("America/Bogota");

export const completionReviewDate = (value: TitularCase): Option.Option<string> =>
  Option.flatMap(value.completion, (completion) =>
    Option.map(DateTime.make(completion.requestedAtMs), (instant) =>
      DateTime.formatIsoDate(
        DateTime.add(DateTime.setZone(instant, bogotaZone), { months: completionMonths })
      )
    )
  );

const holidays = new Map(
  Object.entries({
    "2026": [
      "01-01",
      "01-12",
      "03-23",
      "04-02",
      "04-03",
      "05-01",
      "05-18",
      "06-08",
      "06-15",
      "06-29",
      "07-20",
      "08-07",
      "08-17",
      "10-12",
      "11-02",
      "11-16",
      "12-08",
      "12-25",
    ],
    "2027": [
      "01-01",
      "01-11",
      "03-22",
      "03-25",
      "03-26",
      "05-01",
      "05-10",
      "05-31",
      "06-07",
      "07-05",
      "07-20",
      "08-07",
      "08-16",
      "10-18",
      "11-01",
      "11-15",
      "12-08",
      "12-25",
    ],
  })
);

export const parseDate = (value: string): Option.Option<DateTime.Utc> =>
  DateTime.make(`${value}T00:00:00Z`).pipe(
    Option.filter((date) => DateTime.formatIsoDateUtc(date) === value)
  );

const workingDeadline = (
  value: string,
  count: number,
  includeReceipt: boolean
): Option.Option<string> => {
  const parsed = parseDate(value);

  if (Option.isNone(parsed)) return Option.none();
  let date = includeReceipt ? parsed.value : DateTime.add(parsed.value, { days: 1 });
  let remaining = count;

  while (remaining > 0) {
    const label = DateTime.formatIsoDateUtc(date);
    const excluded = holidays.get(label.slice(0, 4));

    if (excluded === undefined) return Option.none();

    if (
      DateTime.toPartsUtc(date).weekDay !== 0 &&
      !excluded.includes(label.slice(monthDayOffset))
    ) {
      remaining -= 1;
    }

    if (remaining > 0) date = DateTime.add(date, { days: 1 });
  }

  return Option.some(DateTime.formatIsoDateUtc(date));
};

export type CaseDeadlines = Readonly<{
  response: Option.Option<string>;
  maximumExtension: Option.Option<string>;
  completion: Option.Option<string>;
  transfer: Option.Option<string>;
  claimAnnotation: Option.Option<string>;
}>;

export const caseDeadlines = ({
  kind,
  receivedDate,
}: Readonly<{ kind: typeof RequestKind.Type; receivedDate: string }>): CaseDeadlines => {
  const consultation = ["Access", "AuthorizationProof", "UseExplanation"].includes(kind);

  const response = workingDeadline(
    receivedDate,
    consultation ? consultationDays : complaintDays,
    consultation
  );

  return {
    response,
    maximumExtension: Option.flatMap(response, (date) =>
      workingDeadline(
        date,
        consultation ? consultationExtensionDays : complaintExtensionDays,
        false
      )
    ),
    completion: consultation ? Option.none() : workingDeadline(receivedDate, completionDays, false),
    transfer: workingDeadline(receivedDate, 2, false),
    claimAnnotation: consultation ? Option.none() : workingDeadline(receivedDate, 2, false),
  };
};

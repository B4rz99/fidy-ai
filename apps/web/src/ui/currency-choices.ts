const names = new Intl.DisplayNames(["es-CO"], { type: "currency" });
const capitalized = (name: string): string => name.replace(/^./u, (first) => first.toUpperCase());

export const currencyChoices = <Code extends string>(
  codes: ReadonlyArray<Code>
): ReadonlyArray<Readonly<{ value: Code; label: string }>> =>
  codes.map((value) => ({ value, label: `${value} · ${capitalized(names.of(value) ?? value)}` }));

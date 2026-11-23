import { Option } from "effect";
import { type JSX, useState } from "react";

export type StressDataset = Readonly<{ value: string; label: string }>;

const restoreEnvironment = (_element: HTMLElement): (() => void) => {
  const root = document.documentElement;
  const fontSize = root.style.fontSize;
  const dark = root.classList.contains("dark");

  return (): void => {
    root.style.fontSize = fontSize;
    root.classList.toggle("dark", dark);
  };
};

export const DevStressControls = ({
  label,
  datasets,
  dataset,
  choose,
  fixtureNote,
}: Readonly<{
  label: string;
  datasets: ReadonlyArray<StressDataset>;
  dataset: string;
  choose: (value: string) => void;
  fixtureNote: Option.Option<string>;
}>): JSX.Element => {
  const [largeText, setLargeText] = useState(false);

  return (
    <section
      ref={restoreEnvironment}
      aria-label={label}
      className="fixed bottom-3 left-1/2 z-50 flex w-max max-w-[95vw] -translate-x-1/2 flex-wrap justify-center gap-1 rounded-xl border border-border bg-muted p-1 font-sans text-xs text-foreground shadow-sm"
    >
      {datasets.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={dataset === item.value}
          className={`rounded-lg px-2 py-1 ${dataset === item.value ? "bg-white text-black shadow-sm" : ""}`}
          onClick={() => choose(item.value)}
        >
          {item.label}
        </button>
      ))}
      <button
        type="button"
        aria-pressed={largeText}
        className="rounded-lg px-2 py-1"
        onClick={(): void => {
          document.documentElement.style.fontSize = largeText ? "" : "32px";
          setLargeText(!largeText);
        }}
      >
        200% text
      </button>
      <button
        type="button"
        className="rounded-lg px-2 py-1"
        onClick={() => document.documentElement.classList.toggle("dark")}
      >
        Dark mode
      </button>
      {Option.isSome(fixtureNote) ? (
        <span className="self-center px-2">{fixtureNote.value}</span>
      ) : null}
    </section>
  );
};

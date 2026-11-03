import type { ComponentProps, JSX } from "react";
import { Input } from "./input";

const minimumCharacters = 12;
const characterPadding = 3;
type AmountInputProps = Omit<
  ComponentProps<typeof Input>,
  "type" | "inputMode" | "variant" | "value"
> &
  Readonly<{ value: string; width: "full" | "content" }>;

/** Decimal drafts with end-caret editing. onValueChange retains localized separators; callers own exact Money validation. */
export const AmountInput = ({
  value,
  width,
  onClick,
  onValueChange,
  style,
  ...props
}: AmountInputProps): JSX.Element => (
  <Input
    {...props}
    value={value}
    inputMode="decimal"
    variant="amount"
    onValueChange={(text, eventDetails) => {
      if (/^-?[0-9.,]*$/u.test(text)) onValueChange?.(text, eventDetails);
    }}
    style={{
      ...style,
      width:
        width === "content"
          ? `${Math.max(value.length + characterPadding, minimumCharacters)}ch`
          : "100%",
      maxWidth: "100%",
    }}
    onClick={(event) => {
      const input = event.currentTarget;
      input.setSelectionRange(input.value.length, input.value.length);
      onClick?.(event);
    }}
  />
);

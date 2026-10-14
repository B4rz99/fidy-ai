import type { ComponentProps, JSX } from "react";
import { Input } from "./input";

const minimumCharacters = 12;
const characterPadding = 3;
type AmountInputProps = Omit<
  ComponentProps<typeof Input>,
  "type" | "inputMode" | "variant" | "value"
> &
  Readonly<{ value: string; width: "full" | "content" }>;

/** Decimal draft input; validation and exact monetary meaning belong to the caller. */
export const AmountInput = ({
  value,
  width,
  onClick,
  style,
  ...props
}: AmountInputProps): JSX.Element => (
  <Input
    {...props}
    value={value}
    inputMode="decimal"
    variant="amount"
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

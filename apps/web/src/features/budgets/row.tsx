import { HugeiconsIcon } from "@hugeicons/react";
import { CreditCardIcon, PencilIcon } from "@hugeicons/core-free-icons";
import { BigDecimal } from "effect";
import { type JSX, useState } from "react";
import { formatMoney } from "@/transport/money";
import { Button } from "@/ui/components/button";
import { AmountInput } from "@/ui/components/amount-input";
import { IconIndicator } from "@/ui/components/icon-indicator";
import { BudgetBalance, BudgetMeter } from "@/ui/components/budget-meter";
import {
  type BudgetStatus,
  type Category,
  type CurrentUser,
  budgetPercentage,
  budgetRemaining,
} from "./presentation";

type RowProps = Readonly<{
  status: BudgetStatus;
  category: Category;
  user: CurrentUser;
  disabled: boolean;
  onSave: (status: BudgetStatus, amount: string) => void;
  onSettings: () => void;
}>;
export const BudgetRow = ({
  status,
  category,
  user,
  disabled,
  onSave,
  onSettings,
}: RowProps): JSX.Element => {
  const initial = BigDecimal.format(status.budget.cap.amount);
  const [amount, setAmount] = useState(initial);
  const submit = (): void => {
    if (!disabled && amount !== initial) onSave(status, amount);
  };
  return (
    <div className="budget-row border-t">
      <div className="budget-tracks items-center gap-4 px-4 py-4">
        <BudgetRowLabel category={category} disabled={disabled} onSettings={onSettings} />
        <BudgetAmount
          status={status}
          category={category}
          disabled={disabled}
          amount={amount}
          onChange={setAmount}
          onSubmit={submit}
        />
        <span className="budget-value text-right whitespace-nowrap tabular-nums">
          <span className="budget-value-label">Gastado</span>
          {formatMoney({ locale: user.locale, money: status.spent })}
        </span>
        <RowBalance status={status} user={user} />
      </div>
      <div className="budget-progress pl-4">
        <BudgetMeter
          variant="default"
          value={budgetPercentage({
            cap: status.budget.cap.amount,
            spent: status.spent.amount,
          })}
          over={status.type === "over"}
          label={`Gasto de ${category.label}: ${formatMoney({ locale: user.locale, money: status.spent })}`}
        />
      </div>
    </div>
  );
};

const BudgetRowLabel = ({
  category,
  disabled,
  onSettings,
}: Pick<RowProps, "category" | "disabled" | "onSettings">): JSX.Element => (
  <div className="budget-row-label flex min-w-0 items-center gap-2">
    <IconIndicator icon={CreditCardIcon} tone="peach" appearance="category" />
    <span className="budget-name" title={category.label}>
      {category.label}
    </span>
    <Button
      size="icon"
      variant="ghost"
      aria-label={`Configurar ${category.label}`}
      disabled={disabled}
      onClick={onSettings}
    >
      <HugeiconsIcon icon={PencilIcon} strokeWidth={2} />
    </Button>
  </div>
);

const BudgetAmount = ({
  status,
  category,
  disabled,
  amount,
  onChange,
  onSubmit,
}: Pick<RowProps, "status" | "category" | "disabled"> &
  Readonly<{
    amount: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
  }>): JSX.Element => (
  <form
    className="budget-value"
    onSubmit={(event) => {
      event.preventDefault();
      onSubmit();
    }}
  >
    <span className="budget-value-label">Presupuesto</span>
    <AmountInput
      aria-label={`Presupuesto de ${category.label} (${status.budget.cap.currency})`}
      width="content"
      value={amount}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onSubmit}
    />
  </form>
);

const RowBalance = ({ status, user }: Pick<RowProps, "status" | "user">): JSX.Element => (
  <div className="budget-value text-right">
    <span className="budget-value-label">{status.type === "over" ? "Excedido" : "Disponible"}</span>
    <BudgetBalance over={status.type === "over"}>
      {formatMoney({
        locale: user.locale,
        money: {
          currency: status.budget.cap.currency,
          amount: budgetRemaining(status),
        },
      })}
    </BudgetBalance>
    <span className="sr-only">{status.type === "over" ? "Excedido" : "Disponible"}</span>
  </div>
);

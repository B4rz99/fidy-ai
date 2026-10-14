import { DateTime, Option } from "effect";
import type { FidyClient } from "@/transport/client";
import {
  type Budget,
  type BudgetReport,
  type BudgetStatus,
  type Category,
  type CurrentUser,
  defaultBudgetGroup,
} from "./presentation";

export type WorkspaceProps = Readonly<{
  apiClient: FidyClient;
  user: CurrentUser;
  month: string;
  report: BudgetReport;
  categories: ReadonlyArray<Category>;
  budgets: ReadonlyArray<Budget>;
  onRefresh: () => void;
  editable: boolean;
}>;
export type SaveState = "idle" | "saving" | "saved" | "failed" | "uncertain";
export type BudgetDraft = Readonly<{
  category: Category;
  budget: Option.Option<Budget>;
  groupCategoryIds: Option.Option<ReadonlyArray<Category["id"]>>;
}>;
export type BudgetEdit = Readonly<{
  target: BudgetDraft;
  amount: string;
  currency: string;
  groupName: string;
  groupCurrency: Option.Option<string>;
}>;
const monthLabelLength = 7;
/** One local calendar label; amounts and status continue to come from the canonical report. */
export const currentBudgetMonth = (user: CurrentUser): string =>
  DateTime.formatIsoDate(
    DateTime.setZone(DateTime.nowUnsafe(), DateTime.zoneMakeNamedUnsafe(user.timeZone))
  ).slice(0, monthLabelLength);
/** Move by calendar months without introducing host-zone date arithmetic. */
export const monthShift = ({
  month,
  offset,
}: Readonly<{ month: string; offset: number }>): string =>
  DateTime.formatIsoDateUtc(
    DateTime.add(DateTime.makeUnsafe(`${month}-01T00:00:00Z`), { months: offset })
  ).slice(0, monthLabelLength);
/** Locale controls the displayed calendar heading. */
export const monthTitle = ({
  month,
  user,
}: Readonly<{ month: string; user: CurrentUser }>): string =>
  new Intl.DateTimeFormat(user.locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    DateTime.makeUnsafe(`${month}-01T00:00:00Z`).epochMilliseconds
  );
/** Resolve the canonical category identity against this complete category projection. */
export const categoryFor = ({
  categories,
  id,
}: Readonly<{ categories: ReadonlyArray<Category>; id: string }>): Category =>
  Option.getOrThrow(Option.fromUndefinedOr(categories.find((category) => category.id === id)));
/** A persisted group takes precedence over the view's default category grouping. */
export const groupFor = ({
  status,
  categories,
}: Readonly<{ status: BudgetStatus; categories: ReadonlyArray<Category> }>): string =>
  status.budget.groupName ??
  defaultBudgetGroup(categoryFor({ categories, id: status.budget.categoryId }).label);
/** A row edit keeps category identity and currency stable. */
export const rowDraft = ({
  status,
  categories,
}: Readonly<{ status: BudgetStatus; categories: ReadonlyArray<Category> }>): BudgetDraft => ({
  category: categoryFor({ categories, id: status.budget.categoryId }),
  budget: Option.some(status.budget),
  groupCategoryIds: Option.none(),
});

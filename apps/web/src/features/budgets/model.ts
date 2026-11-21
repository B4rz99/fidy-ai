import { DateTime, Option } from "effect";
import {
  type Budget,
  type BudgetReport,
  type BudgetStatus,
  type Category,
  type CurrentUser,
  defaultBudgetGroup,
} from "./presentation";

export type WorkspaceProps = Readonly<{
  user: CurrentUser;
  month: string;
  report: BudgetReport;
  categories: ReadonlyArray<Category>;
  budgets: ReadonlyArray<Budget>;
  editing: BudgetEditing;
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

export type BudgetEditing = Readonly<{
  saveState: SaveState;
  writeAction: "save" | "delete";
  disabled: boolean;
  navigationDisabled: boolean;
  hasInlineDraft: boolean;
  inlineRecovery: Option.Option<BudgetEdit>;
  discardInline: () => void;
  moveMonth: (navigate: () => void) => void;
  draft: Option.Option<BudgetDraft>;
  write: (edit: BudgetEdit) => void;
  remove: () => void;
  refresh: () => void;
  closeEditor: () => void;
  assignCategory: (category: Category) => void;
  configureCategory: (status: BudgetStatus) => void;
  configureGroup: (group: string) => void;
  rowDisabled: (status: BudgetStatus) => boolean;
  rowAmount: (status: BudgetStatus) => string;
  changeRow: (status: BudgetStatus, amount: string) => void;
  saveRow: (status: BudgetStatus, amount: string) => void;
  freezePlan: () => void;
  rowKey: (status: BudgetStatus) => string;
}>;

const monthLabelLength = 7;

export const currentBudgetMonth = (user: CurrentUser): string =>
  DateTime.formatIsoDate(
    DateTime.setZone(DateTime.nowUnsafe(), DateTime.zoneMakeNamedUnsafe(user.timeZone))
  ).slice(0, monthLabelLength);

export const monthShift = ({
  month,
  offset,
}: Readonly<{ month: string; offset: number }>): string =>
  DateTime.formatIsoDateUtc(
    DateTime.add(DateTime.makeUnsafe(`${month}-01T00:00:00Z`), { months: offset })
  ).slice(0, monthLabelLength);

export const monthTitle = ({
  month,
  user,
}: Readonly<{ month: string; user: CurrentUser }>): string =>
  new Intl.DateTimeFormat(user.locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    DateTime.makeUnsafe(`${month}-01T00:00:00Z`).epochMilliseconds
  );

export const categoryFor = ({
  categories,
  id,
}: Readonly<{ categories: ReadonlyArray<Category>; id: string }>): Option.Option<Category> =>
  Option.fromUndefinedOr(categories.find((category) => category.id === id));

export const groupFor = ({
  status,
  categories,
}: Readonly<{ status: BudgetStatus; categories: ReadonlyArray<Category> }>): string =>
  status.budget.groupName ??
  defaultBudgetGroup(
    Option.match(categoryFor({ categories, id: status.budget.categoryId }), {
      onNone: () => "",
      onSome: (category) => category.label,
    })
  );

export const rowDraft = ({
  status,
  categories,
}: Readonly<{
  status: BudgetStatus;
  categories: ReadonlyArray<Category>;
}>): Option.Option<BudgetDraft> =>
  Option.map(categoryFor({ categories, id: status.budget.categoryId }), (category) => ({
    category,
    budget: Option.some(status.budget),
    groupCategoryIds: Option.none(),
  }));

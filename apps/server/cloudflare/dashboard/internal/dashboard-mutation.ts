import { defaultDashboard } from "../../../src/core/dashboard/operations";
import { categoryIds } from "../../../src/core/categories/contract";
import { type DashboardDocument, WidgetId } from "../../../src/core/dashboard/contract";
import { transactionId } from "../../canonical-work/operations";

export const defaultDocument = (): DashboardDocument =>
  defaultDashboard({
    restaurantCategoryId: categoryIds.restaurantes,
    widgetIds: [
      WidgetId.make(transactionId()),
      WidgetId.make(transactionId()),
      WidgetId.make(transactionId()),
      WidgetId.make(transactionId()),
    ],
  });

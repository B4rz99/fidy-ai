import { Option } from "effect";
import { createContext } from "react";

export const PlanningMonthContext = createContext<Option.Option<string>>(Option.none());

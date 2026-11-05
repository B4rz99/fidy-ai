import { Option } from "effect";
import type { ReviewWorkspaceQuery } from "../../../src/core/ingestion/contract";

export const reviewRelation = `SELECT *, CASE WHEN status != 'created' AND expires_at_ms <= ?
  THEN 'expired' ELSE status END AS visible_status FROM ingestion_review_sources WHERE user_id = ?`;

export const reviewPageSelection = ({
  query,
  current,
}: Readonly<{
  query: typeof ReviewWorkspaceQuery.Type;
  current: number;
}>): Readonly<{
  filter: string;
  params: ReadonlyArray<string | number>;
}> => {
  const status = Option.getOrElse(query.status, () => "pending");
  return status === "pending"
    ? { filter: "status = 'pending' AND expires_at_ms > ?", params: [current] }
    : {
        filter: "visible_status != 'pending' AND (? = 'history' OR visible_status = ?)",
        params: [status, status],
      };
};

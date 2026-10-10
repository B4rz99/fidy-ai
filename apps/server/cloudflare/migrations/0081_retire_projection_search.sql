-- Effective Dashboard search reads User-scoped leaves directly. The former padded trigram
-- representation has no runtime reader; rebuilding it on every capture/correction wastes work.
-- Retained Transactions, effective leaves, exact aggregates and their indexes are unchanged.
DROP TRIGGER dashboard_projection_list_insert;
DROP TRIGGER dashboard_projection_list_delete;
DROP TABLE dashboard_projection_list_search;

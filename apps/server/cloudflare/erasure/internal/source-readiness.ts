/** The q alias is the owner-selected erasure request; no caller SQL or deadline can remove unfinished deletion. */
export const unfinishedFinancialDeletion = `q.state IN('Draining','Sealing','Erasing')
  OR q.marker_written=0 OR q.coordinator_cleared=0
  OR EXISTS(SELECT 1 FROM users WHERE id=q.user_id)
  OR EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=q.user_id)
  OR EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id AND delete_done=0)
  OR (q.state='ExternalPending' AND NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id))`;

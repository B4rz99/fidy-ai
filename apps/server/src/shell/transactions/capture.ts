/** The Transaction owner refuses a capture whose final guarded AuditLogEntry changed no row. */
export const transactionCaptureCompletion = `INSERT INTO transaction_capture_assertion (id, accepted)
VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

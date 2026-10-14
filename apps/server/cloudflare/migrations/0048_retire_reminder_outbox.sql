-- Reminder intent and delivery lifecycle now have one executable category outbox.
-- Retained occurrences, reports, threshold links and canonical instruction history are unchanged.
DROP TABLE reminder_outbox;

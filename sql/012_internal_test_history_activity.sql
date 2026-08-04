ALTER TABLE lead_stage_history
  DROP CONSTRAINT IF EXISTS lead_stage_history_activity_type_check;

ALTER TABLE lead_stage_history
  ADD CONSTRAINT lead_stage_history_activity_type_check
    CHECK (
      activity_type IN (
        'LEAD_RECEIVED', 'HISTORICAL_IMPORT', 'WHATSAPP_OPENED',
        'STAGE_CHANGED', 'LABEL_SYNC_REQUESTED', 'LABEL_APPLIED', 'LABEL_REMOVED',
        'META_EVENT_QUEUED', 'META_EVENT_SENT', 'META_EVENT_FAILED',
        'META_EVENT_BLOCKED_INTERNAL_TEST', 'SYNC_CONFLICT', 'LOST'
      )
    );

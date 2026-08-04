ALTER TABLE lead_stage_history
  DROP CONSTRAINT IF EXISTS lead_stage_history_activity_type_check;

ALTER TABLE lead_stage_history
  ADD CONSTRAINT lead_stage_history_activity_type_check
    CHECK (
      activity_type IN (
        'LEAD_RECEIVED', 'HISTORICAL_IMPORT', 'WHATSAPP_OPENED',
        'STAGE_CHANGED', 'LABEL_SYNC_REQUESTED', 'LABEL_APPLIED', 'LABEL_REMOVED',
        'META_EVENT_QUEUED', 'META_EVENT_SENT', 'META_EVENT_FAILED',
        'META_EVENT_BLOCKED_INTERNAL_TEST', 'WHATSAPP_IDENTITY_VERIFIED',
        'WA2_CHAT_REBOUND', 'SYNC_CONFLICT', 'LOST'
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS lead_stage_history_wa2_rebind_idempotency_uidx
  ON lead_stage_history (tenant_id, lead_id, activity_type, (metadata->>'idempotencyKey'))
  WHERE activity_type = 'WA2_CHAT_REBOUND'
    AND metadata ? 'idempotencyKey';

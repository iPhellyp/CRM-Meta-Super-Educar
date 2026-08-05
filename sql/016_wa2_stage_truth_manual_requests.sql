ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS stage_source TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED',
  ADD COLUMN IF NOT EXISTS source_label_id TEXT,
  ADD COLUMN IF NOT EXISTS source_label_name TEXT,
  ADD COLUMN IF NOT EXISTS source_action_id UUID,
  ADD COLUMN IF NOT EXISTS source_receipt_id UUID,
  ADD COLUMN IF NOT EXISTS source_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage_verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED_LEGACY';

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_stage_source_check,
  DROP CONSTRAINT IF EXISTS leads_stage_verification_status_check;

ALTER TABLE leads
  ADD CONSTRAINT leads_stage_source_check CHECK (
    stage_source IN (
      'WHATSAPP_LABEL', 'MANUAL_TWO_STEP_PENDING',
      'MANUAL_TWO_STEP_APPROVED', 'SYSTEM_PROTECTED', 'LEGACY_UNVERIFIED'
    )
  ),
  ADD CONSTRAINT leads_stage_verification_status_check CHECK (
    stage_verification_status IN (
      'VERIFIED', 'UNVERIFIED_LEGACY', 'UNVERIFIED_NO_LABEL',
      'CONFLICT', 'PENDING_WA_LABEL', 'PROTECTED'
    )
  );

CREATE INDEX IF NOT EXISTS leads_stage_truth_idx
  ON leads (tenant_id, stage_source, stage_verification_status, updated_at DESC);

ALTER TABLE meta_conversion_events
  ADD COLUMN IF NOT EXISTS validity_status TEXT NOT NULL DEFAULT 'VALID',
  ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invalidated_reason TEXT,
  ADD COLUMN IF NOT EXISTS audit_run_id TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by_event_id TEXT,
  ADD COLUMN IF NOT EXISTS qualification_occurrence_id TEXT;

ALTER TABLE meta_conversion_events
  DROP CONSTRAINT IF EXISTS meta_conversion_events_validity_status_check;

ALTER TABLE meta_conversion_events
  ADD CONSTRAINT meta_conversion_events_validity_status_check CHECK (
    validity_status IN ('VALID', 'INVALIDATED')
  );

CREATE INDEX IF NOT EXISTS meta_conversion_events_validity_idx
  ON meta_conversion_events (tenant_id, event_name, validity_status, event_time DESC);

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
        'WA2_CHAT_REBOUND', 'SYNC_CONFLICT', 'LOST',
        'STAGE_SOURCE_ALIGNED', 'STAGE_SOURCE_NEUTRALIZED',
        'STAGE_VERIFICATION_CONFLICT', 'MQL_INVALIDATED',
        'MANUAL_STAGE_REQUESTED', 'MANUAL_STAGE_APPROVED',
        'MANUAL_STAGE_REJECTED', 'MANUAL_STAGE_APPLIED_PENDING_WA',
        'MANUAL_STAGE_COMPLETED'
      )
    );

CREATE TABLE IF NOT EXISTS manual_stage_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  lead_id UUID NOT NULL,
  current_stage TEXT NOT NULL,
  requested_stage TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  mandatory_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejected_by TEXT,
  rejected_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  emergency_override BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT manual_stage_change_requests_lead_fk
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT manual_stage_change_requests_status_check CHECK (
    status IN (
      'PENDING_APPROVAL', 'APPROVED_PENDING_WA', 'PENDING_WA_LINK',
      'COMPLETED', 'REJECTED', 'EXPIRED'
    )
  ),
  CONSTRAINT manual_stage_change_requests_stage_check CHECK (
    requested_stage IN (
      'NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE',
      'QUALIFIED', 'OPPORTUNITY', 'NEGOTIATING',
      'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT',
      'LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'
    )
  ),
  CONSTRAINT manual_stage_change_requests_reason_check CHECK (
    char_length(btrim(mandatory_reason)) BETWEEN 5 AND 1000
  )
);

CREATE INDEX IF NOT EXISTS manual_stage_change_requests_lead_idx
  ON manual_stage_change_requests (tenant_id, lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS manual_stage_change_requests_pending_idx
  ON manual_stage_change_requests (tenant_id, status, expires_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS manual_stage_change_requests_pending_uidx
  ON manual_stage_change_requests (tenant_id, lead_id)
  WHERE status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_WA', 'PENDING_WA_LINK');

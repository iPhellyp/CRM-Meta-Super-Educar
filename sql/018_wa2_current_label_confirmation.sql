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
        'WA2_CHAT_REBOUND', 'WA2_CURRENT_LABEL_STATE_CONFIRMED',
        'SYNC_CONFLICT', 'LOST', 'STAGE_SOURCE_ALIGNED',
        'STAGE_SOURCE_NEUTRALIZED', 'STAGE_VERIFICATION_CONFLICT',
        'MQL_INVALIDATED', 'MANUAL_STAGE_REQUESTED', 'MANUAL_STAGE_APPROVED',
        'MANUAL_STAGE_REJECTED', 'MANUAL_STAGE_APPLIED_PENDING_WA',
        'MANUAL_STAGE_COMPLETED'
      )
    );

ALTER TABLE lead_verified_whatsapp_identities
  DROP CONSTRAINT IF EXISTS lead_verified_whatsapp_identities_evidence_type_check;

ALTER TABLE lead_verified_whatsapp_identities
  ADD CONSTRAINT lead_verified_whatsapp_identities_evidence_type_check
    CHECK (evidence_type IN (
      'WA2_MESSAGE', 'WA2_CONTACT_STATE', 'WA2_CURRENT_LABEL_STATE'
    ));

ALTER TABLE lead_verified_whatsapp_identities
  DROP CONSTRAINT IF EXISTS lead_verified_whatsapp_identities_evidence_pair_check;

ALTER TABLE lead_verified_whatsapp_identities
  ADD CONSTRAINT lead_verified_whatsapp_identities_evidence_pair_check
    CHECK (
      (evidence_type = 'WA2_MESSAGE' AND evidence_wa_message_id IS NOT NULL
        AND evidence_reference = evidence_wa_message_id)
      OR
      (evidence_type IN ('WA2_CONTACT_STATE', 'WA2_CURRENT_LABEL_STATE')
        AND evidence_wa_message_id IS NULL)
    );

CREATE TABLE IF NOT EXISTS wa2_current_label_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  lead_id UUID NOT NULL,
  wa2_instance_id UUID NOT NULL,
  active_link_id UUID NOT NULL,
  verified_identity_id UUID NOT NULL,
  remote_chat_id TEXT NOT NULL,
  remote_contact_id TEXT NOT NULL,
  remote_label_id TEXT NOT NULL,
  remote_label_name TEXT NOT NULL,
  binding_id UUID NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence_type TEXT NOT NULL,
  evidence_reference TEXT NOT NULL,
  source_event_id UUID,
  actor TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  previous_stage TEXT NOT NULL,
  resulting_stage TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'STAGE_ALIGNED',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_current_label_confirmations_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT wa2_current_label_confirmations_lead_fk
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_current_label_confirmations_instance_fk
    FOREIGN KEY (tenant_id, wa2_instance_id) REFERENCES wa2_instances (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_current_label_confirmations_link_fk
    FOREIGN KEY (tenant_id, active_link_id) REFERENCES wa2_contact_links (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_current_label_confirmations_identity_fk
    FOREIGN KEY (tenant_id, verified_identity_id)
    REFERENCES lead_verified_whatsapp_identities (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_current_label_confirmations_binding_fk
    FOREIGN KEY (tenant_id, binding_id) REFERENCES wa2_label_bindings (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_current_label_confirmations_evidence_type_check
    CHECK (evidence_type IN (
      'WA2_CURRENT_LABEL_STATE', 'WA2_CONTACT_STATE', 'WA2_LABEL_APPLY_EVENT'
    )),
  CONSTRAINT wa2_current_label_confirmations_reference_check
    CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 255),
  CONSTRAINT wa2_current_label_confirmations_label_id_check
    CHECK (char_length(btrim(remote_label_id)) BETWEEN 1 AND 128),
  CONSTRAINT wa2_current_label_confirmations_label_name_check
    CHECK (char_length(btrim(remote_label_name)) BETWEEN 1 AND 200),
  CONSTRAINT wa2_current_label_confirmations_actor_check
    CHECK (char_length(btrim(actor)) BETWEEN 1 AND 320),
  CONSTRAINT wa2_current_label_confirmations_key_check
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 255),
  CONSTRAINT wa2_current_label_confirmations_stage_check
    CHECK (previous_stage = 'NEW' AND resulting_stage = 'QUALIFIED'),
  CONSTRAINT wa2_current_label_confirmations_result_check
    CHECK (result = 'STAGE_ALIGNED'),
  CONSTRAINT wa2_current_label_confirmations_event_pair_check
    CHECK (
      (evidence_type = 'WA2_LABEL_APPLY_EVENT' AND source_event_id IS NOT NULL)
      OR (evidence_type <> 'WA2_LABEL_APPLY_EVENT')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS wa2_current_label_confirmations_key_uidx
  ON wa2_current_label_confirmations (tenant_id, lead_id, wa2_instance_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS wa2_current_label_confirmations_lead_stage_uidx
  ON wa2_current_label_confirmations (tenant_id, lead_id, wa2_instance_id);

CREATE INDEX IF NOT EXISTS wa2_current_label_confirmations_evidence_idx
  ON wa2_current_label_confirmations (tenant_id, evidence_reference);

CREATE INDEX IF NOT EXISTS wa2_current_label_confirmations_label_idx
  ON wa2_current_label_confirmations (tenant_id, wa2_instance_id, remote_label_id, created_at);

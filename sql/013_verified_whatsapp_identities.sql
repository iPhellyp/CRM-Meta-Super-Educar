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
        'SYNC_CONFLICT', 'LOST'
      )
    );

CREATE TABLE lead_verified_whatsapp_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  lead_id UUID NOT NULL,
  wa2_instance_id UUID NOT NULL,
  canonical_phone TEXT NOT NULL,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_phone TEXT NOT NULL,
  phone_jid TEXT NOT NULL,
  lid_jid TEXT,
  verified BOOLEAN NOT NULL DEFAULT true,
  verification_source TEXT NOT NULL,
  verification_reason TEXT NOT NULL,
  remote_contact_id TEXT NOT NULL,
  remote_chat_id TEXT NOT NULL,
  evidence_wa_message_id TEXT NOT NULL,
  evidence_observed_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_verified_whatsapp_identities_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT lead_verified_whatsapp_identities_instance_fk
    FOREIGN KEY (tenant_id, wa2_instance_id)
    REFERENCES wa2_instances (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT lead_verified_whatsapp_identities_canonical_check
    CHECK (canonical_phone ~ '^55[1-9][0-9]9[0-9]{8}$'),
  CONSTRAINT lead_verified_whatsapp_identities_source_check
    CHECK (char_length(btrim(source_phone)) BETWEEN 1 AND 40),
  CONSTRAINT lead_verified_whatsapp_identities_phone_jid_check
    CHECK (phone_jid ~ '^[0-9]+@(s\\.whatsapp\\.net|c\\.us)$'),
  CONSTRAINT lead_verified_whatsapp_identities_lid_jid_check
    CHECK (lid_jid IS NULL OR lid_jid ~ '^[A-Za-z0-9._:-]+@lid$'),
  CONSTRAINT lead_verified_whatsapp_identities_source_name_check
    CHECK (char_length(btrim(verification_source)) BETWEEN 1 AND 200),
  CONSTRAINT lead_verified_whatsapp_identities_reason_check
    CHECK (char_length(btrim(verification_reason)) BETWEEN 1 AND 500),
  CONSTRAINT lead_verified_whatsapp_identities_contact_check
    CHECK (char_length(btrim(remote_contact_id)) BETWEEN 1 AND 200),
  CONSTRAINT lead_verified_whatsapp_identities_chat_check
    CHECK (char_length(btrim(remote_chat_id)) BETWEEN 1 AND 200),
  CONSTRAINT lead_verified_whatsapp_identities_evidence_check
    CHECK (char_length(btrim(evidence_wa_message_id)) BETWEEN 1 AND 255),
  CONSTRAINT lead_verified_whatsapp_identities_actor_check
    CHECK (char_length(btrim(verified_by)) BETWEEN 1 AND 320),
  CONSTRAINT lead_verified_whatsapp_identities_tenant_id_id_key
    UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX lead_verified_whatsapp_identities_lead_uidx
  ON lead_verified_whatsapp_identities (tenant_id, lead_id, wa2_instance_id, canonical_phone);

CREATE UNIQUE INDEX lead_verified_whatsapp_identities_phone_uidx
  ON lead_verified_whatsapp_identities (tenant_id, wa2_instance_id, canonical_phone);

CREATE INDEX lead_verified_whatsapp_identities_evidence_idx
  ON lead_verified_whatsapp_identities (tenant_id, evidence_wa_message_id);

CREATE INDEX lead_verified_whatsapp_identities_verified_idx
  ON lead_verified_whatsapp_identities (tenant_id, verified_at DESC);

ALTER TABLE lead_verified_whatsapp_identities
  ADD COLUMN IF NOT EXISTS evidence_type TEXT NOT NULL DEFAULT 'WA2_MESSAGE',
  ADD COLUMN IF NOT EXISTS evidence_reference TEXT;

UPDATE lead_verified_whatsapp_identities
SET evidence_reference = evidence_wa_message_id
WHERE evidence_reference IS NULL;

ALTER TABLE lead_verified_whatsapp_identities
  ALTER COLUMN evidence_reference SET NOT NULL,
  ALTER COLUMN evidence_wa_message_id DROP NOT NULL;

ALTER TABLE lead_verified_whatsapp_identities
  DROP CONSTRAINT IF EXISTS lead_verified_whatsapp_identities_evidence_type_check;

ALTER TABLE lead_verified_whatsapp_identities
  ADD CONSTRAINT lead_verified_whatsapp_identities_evidence_type_check
    CHECK (evidence_type IN ('WA2_MESSAGE', 'WA2_CONTACT_STATE'));

ALTER TABLE lead_verified_whatsapp_identities
  DROP CONSTRAINT IF EXISTS lead_verified_whatsapp_identities_evidence_reference_check;

ALTER TABLE lead_verified_whatsapp_identities
  ADD CONSTRAINT lead_verified_whatsapp_identities_evidence_reference_check
    CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 255);

ALTER TABLE lead_verified_whatsapp_identities
  DROP CONSTRAINT IF EXISTS lead_verified_whatsapp_identities_evidence_pair_check;

ALTER TABLE lead_verified_whatsapp_identities
  ADD CONSTRAINT lead_verified_whatsapp_identities_evidence_pair_check
    CHECK (
      (evidence_type = 'WA2_MESSAGE' AND evidence_wa_message_id IS NOT NULL
        AND evidence_reference = evidence_wa_message_id)
      OR
      (evidence_type = 'WA2_CONTACT_STATE' AND evidence_wa_message_id IS NULL)
    );

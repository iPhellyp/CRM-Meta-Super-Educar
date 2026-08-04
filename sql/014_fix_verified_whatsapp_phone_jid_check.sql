ALTER TABLE lead_verified_whatsapp_identities
  DROP CONSTRAINT IF EXISTS lead_verified_whatsapp_identities_phone_jid_check;

ALTER TABLE lead_verified_whatsapp_identities
  ADD CONSTRAINT lead_verified_whatsapp_identities_phone_jid_check
    CHECK (phone_jid ~ '^[0-9]+@(s[.]whatsapp[.]net|c[.]us)$');

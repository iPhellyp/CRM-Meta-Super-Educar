ALTER TABLE leads
  ADD COLUMN phone_normalized TEXT;

WITH normalized_phones AS (
  SELECT
    id,
    regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') AS digits
  FROM leads
)
UPDATE leads
SET phone_normalized = CASE
  WHEN normalized_phones.digits ~ '^[1-9][0-9]{9,10}$'
    THEN '55' || normalized_phones.digits
  WHEN normalized_phones.digits ~ '^55[1-9][0-9]{9,10}$'
    THEN normalized_phones.digits
  ELSE NULL
END
FROM normalized_phones
WHERE normalized_phones.id = leads.id;

ALTER TABLE leads
  ADD CONSTRAINT leads_phone_normalized_format_check
  CHECK (
    phone_normalized IS NULL
    OR phone_normalized ~ '^55[1-9][0-9]{9,10}$'
  );

ALTER TABLE leads
  ADD CONSTRAINT leads_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE INDEX leads_tenant_phone_normalized_idx
  ON leads (tenant_id, phone_normalized)
  WHERE phone_normalized IS NOT NULL;

CREATE TABLE wa2_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  remote_instance_id TEXT NOT NULL,
  name TEXT,
  role TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_instances_remote_instance_id_key UNIQUE (remote_instance_id),
  CONSTRAINT wa2_instances_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_instances_remote_id_check
    CHECK (
      char_length(remote_instance_id) BETWEEN 1 AND 128
      AND remote_instance_id ~ '^[A-Za-z0-9._:@-]+$'
    ),
  CONSTRAINT wa2_instances_name_check
    CHECK (name IS NULL OR (char_length(btrim(name)) BETWEEN 1 AND 200)),
  CONSTRAINT wa2_instances_role_check
    CHECK (role IS NULL OR (char_length(btrim(role)) BETWEEN 1 AND 80)),
  CONSTRAINT wa2_instances_default_enabled_check
    CHECK (NOT is_default OR enabled)
);

CREATE INDEX wa2_instances_tenant_enabled_idx
  ON wa2_instances (tenant_id, enabled);

CREATE UNIQUE INDEX wa2_instances_tenant_default_uidx
  ON wa2_instances (tenant_id)
  WHERE is_default = true;

CREATE TABLE wa2_contact_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  lead_id UUID NOT NULL,
  wa2_instance_id UUID NOT NULL,
  remote_contact_id TEXT NOT NULL,
  remote_chat_id TEXT NOT NULL,
  jid TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_by TEXT,
  unlinked_at TIMESTAMPTZ,
  unlinked_by TEXT,
  unlink_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_contact_links_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_contact_links_instance_fk
    FOREIGN KEY (tenant_id, wa2_instance_id)
    REFERENCES wa2_instances (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_contact_links_phone_check
    CHECK (phone_normalized ~ '^55[1-9][0-9]{9,10}$'),
  CONSTRAINT wa2_contact_links_remote_contact_check
    CHECK (char_length(btrim(remote_contact_id)) BETWEEN 1 AND 200),
  CONSTRAINT wa2_contact_links_remote_chat_check
    CHECK (char_length(btrim(remote_chat_id)) BETWEEN 1 AND 200),
  CONSTRAINT wa2_contact_links_jid_check
    CHECK (jid ~ '^[0-9]+@(s\.whatsapp\.net|c\.us)$'),
  CONSTRAINT wa2_contact_links_linked_by_check
    CHECK (linked_by IS NULL OR char_length(linked_by) <= 320),
  CONSTRAINT wa2_contact_links_unlinked_by_check
    CHECK (unlinked_by IS NULL OR char_length(unlinked_by) <= 320),
  CONSTRAINT wa2_contact_links_unlink_reason_check
    CHECK (unlink_reason IS NULL OR char_length(unlink_reason) <= 500)
);

CREATE UNIQUE INDEX wa2_contact_links_active_chat_uidx
  ON wa2_contact_links (tenant_id, wa2_instance_id, remote_chat_id)
  WHERE unlinked_at IS NULL;

CREATE UNIQUE INDEX wa2_contact_links_active_lead_uidx
  ON wa2_contact_links (tenant_id, wa2_instance_id, lead_id)
  WHERE unlinked_at IS NULL;

CREATE INDEX wa2_contact_links_lead_history_idx
  ON wa2_contact_links (tenant_id, lead_id, created_at DESC);

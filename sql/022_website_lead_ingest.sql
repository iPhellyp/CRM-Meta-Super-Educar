CREATE TABLE IF NOT EXISTS website_lead_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  external_system TEXT NOT NULL
    CHECK (external_system = 'SUPEREDUCAR_WEBSITE'),
  external_lead_id TEXT NOT NULL
    CHECK (char_length(btrim(external_lead_id)) BETWEEN 1 AND 200),
  website_submission_id UUID,
  website_event_id TEXT NOT NULL
    CHECK (char_length(website_event_id) BETWEEN 1 AND 300),
  lead_id UUID NOT NULL,
  payload_hash TEXT NOT NULL
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  interest TEXT NOT NULL
    CHECK (char_length(btrim(interest)) BETWEEN 1 AND 200),
  course_id TEXT,
  course_name TEXT,
  modality TEXT,
  name TEXT,
  name_is_placeholder BOOLEAN NOT NULL DEFAULT false,
  name_source TEXT NOT NULL DEFAULT 'USER_PROVIDED'
    CHECK (name_source IN ('USER_PROVIDED', 'TECHNICAL_PLACEHOLDER')),
  email TEXT,
  phone TEXT NOT NULL,
  phone_normalized TEXT NOT NULL
    CHECK (phone_normalized ~ '^55[1-9][0-9]{9,10}$'),
  submitted_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attribution_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT website_lead_submissions_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT website_lead_submissions_external_key
    UNIQUE (tenant_id, external_system, external_lead_id),
  CONSTRAINT website_lead_submissions_event_key
    UNIQUE (tenant_id, website_event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS website_lead_submissions_submission_uidx
  ON website_lead_submissions (tenant_id, external_system, website_submission_id)
  WHERE website_submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS website_lead_submissions_lead_idx
  ON website_lead_submissions (tenant_id, lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS website_lead_ingest_nonces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  external_system TEXT NOT NULL
    CHECK (external_system = 'SUPEREDUCAR_WEBSITE'),
  nonce_hash TEXT NOT NULL
    CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT website_lead_ingest_nonces_unique_key
    UNIQUE (tenant_id, external_system, nonce_hash)
);

CREATE INDEX IF NOT EXISTS website_lead_ingest_nonces_expiry_idx
  ON website_lead_ingest_nonces (tenant_id, external_system, expires_at);

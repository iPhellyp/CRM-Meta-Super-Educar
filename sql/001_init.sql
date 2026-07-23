CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'super-educar',
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  course TEXT,
  city TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL',
  stage TEXT NOT NULL DEFAULT 'NEW',
  meta_lead_id TEXT,
  meta_form_id TEXT,
  meta_ad_id TEXT,
  meta_adset_id TEXT,
  meta_campaign_id TEXT,
  raw_meta JSONB,
  qualified_at TIMESTAMPTZ,
  opportunity_at TIMESTAMPTZ,
  matriculated_at TIMESTAMPTZ,
  lost_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS leads_tenant_meta_lead_uidx
  ON leads (tenant_id, meta_lead_id)
  WHERE meta_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads (tenant_id, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads (tenant_id, phone);

CREATE TABLE IF NOT EXISTS meta_conversion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  meta_response JSONB,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meta_events_status_idx
  ON meta_conversion_events (status, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  event_key TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_stage_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  previous_stage TEXT NOT NULL,
  new_stage TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS lead_stage_history_lead_idx
  ON lead_stage_history (lead_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS meta_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('LEAD_IMPORT', 'CONVERSION')),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'RETRY', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meta_jobs_available_idx
  ON meta_jobs (status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_name TEXT PRIMARY KEY,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

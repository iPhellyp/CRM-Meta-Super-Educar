ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS awaiting_manual_reclassification BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reclassification_armed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reclassification_source TEXT,
  ADD COLUMN IF NOT EXISTS routing_source TEXT,
  ADD COLUMN IF NOT EXISTS import_phone_status TEXT;

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_import_phone_status_check;

ALTER TABLE leads
  ADD CONSTRAINT leads_import_phone_status_check CHECK (
    import_phone_status IS NULL OR import_phone_status IN (
      'PHONE_INVALID', 'PHONE_MISSING', 'POSSIBLE_PHONE_DUPLICATE'
    )
  );

CREATE INDEX IF NOT EXISTS leads_reclassification_idx
  ON leads (tenant_id, awaiting_manual_reclassification, reclassification_armed_at)
  WHERE awaiting_manual_reclassification = true;

CREATE TABLE IF NOT EXISTS lead_reclassification_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  lead_id UUID NOT NULL,
  import_id UUID NOT NULL,
  armed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  marked_by TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_reclassification_audits_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT lead_reclassification_audits_lead_fk
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT lead_reclassification_audits_import_fk
    FOREIGN KEY (tenant_id, import_id) REFERENCES lead_file_imports (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT lead_reclassification_audits_source_check
    CHECK (char_length(btrim(source)) BETWEEN 1 AND 120),
  CONSTRAINT lead_reclassification_audits_actor_check
    CHECK (char_length(btrim(marked_by)) BETWEEN 1 AND 320),
  CONSTRAINT lead_reclassification_audits_unique_lead_import
    UNIQUE (tenant_id, lead_id, import_id)
);

CREATE INDEX IF NOT EXISTS lead_reclassification_audits_lead_idx
  ON lead_reclassification_audits (tenant_id, lead_id, armed_at DESC);

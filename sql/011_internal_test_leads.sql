ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS is_internal_test BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS meta_outbound_eligible BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS leads_internal_test_idx
  ON leads (tenant_id, is_internal_test, meta_outbound_eligible);

CREATE TABLE IF NOT EXISTS lead_internal_test_flags (
  tenant_id TEXT NOT NULL,
  lead_id UUID NOT NULL,
  flag TEXT NOT NULL DEFAULT 'INTERNAL_TEST'
    CHECK (flag = 'INTERNAL_TEST'),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 200),
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  marked_by TEXT NOT NULL CHECK (char_length(btrim(marked_by)) BETWEEN 1 AND 320),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, lead_id),
  CONSTRAINT lead_internal_test_flags_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS lead_internal_test_flags_marked_idx
  ON lead_internal_test_flags (tenant_id, marked_at DESC);

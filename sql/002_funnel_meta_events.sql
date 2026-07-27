ALTER TABLE lead_stage_history
  ADD COLUMN IF NOT EXISTS tenant_id TEXT;

UPDATE lead_stage_history AS history
SET tenant_id = leads.tenant_id
FROM leads
WHERE history.lead_id = leads.id
  AND history.tenant_id IS NULL;

ALTER TABLE lead_stage_history
  ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE lead_stage_history
  ADD COLUMN IF NOT EXISTS observation TEXT;

CREATE INDEX IF NOT EXISTS lead_stage_history_tenant_changed_idx
  ON lead_stage_history (tenant_id, changed_at DESC);

INSERT INTO lead_stage_history (
  lead_id,
  tenant_id,
  previous_stage,
  new_stage,
  origin,
  observation
)
SELECT
  id,
  tenant_id,
  'OPPORTUNITY',
  'VESTIBULAR_COMPLETED',
  'SYSTEM',
  'Compatibilidade do funil definitivo.'
FROM leads
WHERE stage = 'OPPORTUNITY';

UPDATE leads
SET stage = 'VESTIBULAR_COMPLETED',
    updated_at = now()
WHERE stage = 'OPPORTUNITY';

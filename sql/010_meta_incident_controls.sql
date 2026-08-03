CREATE TABLE IF NOT EXISTS meta_incident_controls (
  tenant_id TEXT PRIMARY KEY,
  legacy_dataset_id TEXT NOT NULL,
  legacy_status TEXT NOT NULL DEFAULT 'CONTAMINATED_INCIDENT',
  outbound_enabled BOOLEAN NOT NULL DEFAULT false,
  cutoff_at TIMESTAMPTZ,
  allow_historical_backfill BOOLEAN NOT NULL DEFAULT false,
  allowed_events TEXT[] NOT NULL DEFAULT ARRAY['Marketing Qualified Lead', 'Sales Opportunity'],
  allowed_official_labels TEXT[] NOT NULL DEFAULT ARRAY['CRM 02', 'CRM 03', 'CRM 04'],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meta_incident_controls_legacy_dataset_idx
  ON meta_incident_controls (legacy_dataset_id);

INSERT INTO meta_incident_controls (
  tenant_id, legacy_dataset_id, legacy_status, outbound_enabled,
  cutoff_at, allow_historical_backfill
)
VALUES (
  'super-educar', '775516968145969', 'CONTAMINATED_INCIDENT_2026_08_03', false,
  now(), false
)
ON CONFLICT (tenant_id) DO UPDATE SET
  legacy_dataset_id = EXCLUDED.legacy_dataset_id,
  legacy_status = EXCLUDED.legacy_status,
  outbound_enabled = false,
  allow_historical_backfill = false,
  updated_at = now();

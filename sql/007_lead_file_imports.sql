CREATE TABLE lead_file_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREVIEW'
    CHECK (status IN ('PREVIEW', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED')),
  original_filename TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  format TEXT NOT NULL CHECK (format IN ('CSV', 'XLSX', 'XLS')),
  sheet_name TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  new_count INTEGER NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  update_count INTEGER NOT NULL DEFAULT 0 CHECK (update_count >= 0),
  possible_duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (possible_duplicate_count >= 0),
  invalid_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
  applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT lead_file_imports_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX lead_file_imports_tenant_created_idx
  ON lead_file_imports (tenant_id, created_at DESC);
CREATE INDEX lead_file_imports_tenant_status_idx
  ON lead_file_imports (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX lead_file_imports_active_hash_uidx
  ON lead_file_imports (tenant_id, sha256, sheet_name)
  WHERE status IN ('PREVIEW', 'PROCESSING', 'COMPLETED');

CREATE TABLE lead_file_import_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  import_id UUID NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number > 1),
  meta_lead_id TEXT,
  name TEXT,
  phone TEXT,
  phone_normalized TEXT,
  meta_created_at TIMESTAMPTZ,
  meta_ad_id TEXT,
  meta_adset_id TEXT,
  meta_campaign_id TEXT,
  meta_form_id TEXT,
  raw_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision TEXT NOT NULL
    CHECK (decision IN ('NEW', 'UPDATE', 'POSSIBLE_DUPLICATE', 'INVALID')),
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  existing_lead_id UUID,
  applied_lead_id UUID,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_file_import_items_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT lead_file_import_items_row_key UNIQUE (tenant_id, import_id, row_number),
  CONSTRAINT lead_file_import_items_import_fk
    FOREIGN KEY (tenant_id, import_id)
    REFERENCES lead_file_imports (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT lead_file_import_items_existing_lead_fk
    FOREIGN KEY (tenant_id, existing_lead_id)
    REFERENCES leads (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT lead_file_import_items_applied_lead_fk
    FOREIGN KEY (tenant_id, applied_lead_id)
    REFERENCES leads (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX lead_file_import_items_import_idx
  ON lead_file_import_items (tenant_id, import_id, row_number);
CREATE INDEX lead_file_import_items_decision_idx
  ON lead_file_import_items (tenant_id, import_id, decision);

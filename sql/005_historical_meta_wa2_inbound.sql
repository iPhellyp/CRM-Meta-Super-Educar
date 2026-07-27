CREATE TABLE wa2_label_event_cursors (
  tenant_id TEXT PRIMARY KEY,
  cursor_value TEXT,
  status TEXT NOT NULL DEFAULT 'IDLE'
    CHECK (status IN ('IDLE', 'RUNNING', 'ERROR')),
  locked_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  ignored_count INTEGER NOT NULL DEFAULT 0 CHECK (ignored_count >= 0),
  conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 80),
  last_error_message TEXT CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 500),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX wa2_label_event_cursors_claim_idx
  ON wa2_label_event_cursors (status, next_attempt_at, locked_at);

CREATE TABLE wa2_label_event_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  event_id UUID NOT NULL,
  remote_instance_id TEXT NOT NULL,
  remote_chat_id TEXT NOT NULL,
  jid TEXT NOT NULL,
  phone_normalized TEXT,
  remote_label_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('APPLY', 'REMOVE')),
  source TEXT NOT NULL CHECK (source IN ('INTERNAL_API', 'WHATSAPP', 'UNKNOWN')),
  eligible_for_crm BOOLEAN NOT NULL,
  ineligible_reason TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_label_event_receipts_event_id_key UNIQUE (event_id),
  CONSTRAINT wa2_label_event_receipts_tenant_event_key UNIQUE (tenant_id, event_id),
  CONSTRAINT wa2_label_event_receipts_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX wa2_label_event_receipts_tenant_received_idx
  ON wa2_label_event_receipts (tenant_id, received_at DESC);

CREATE TABLE wa2_inbound_label_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  receipt_id UUID NOT NULL,
  wa2_instance_id UUID,
  wa2_contact_link_id UUID,
  lead_id UUID,
  target_stage TEXT,
  action TEXT NOT NULL
    CHECK (action IN ('IGNORED', 'NOOP', 'STAGE_CHANGED', 'CONFLICT', 'PENDING_CONFIRMATION')),
  detail_code TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_inbound_label_actions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_inbound_label_actions_receipt_key UNIQUE (tenant_id, receipt_id),
  CONSTRAINT wa2_inbound_label_actions_receipt_fk
    FOREIGN KEY (tenant_id, receipt_id)
    REFERENCES wa2_label_event_receipts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa2_inbound_label_actions_instance_fk
    FOREIGN KEY (tenant_id, wa2_instance_id)
    REFERENCES wa2_instances (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa2_inbound_label_actions_link_fk
    FOREIGN KEY (tenant_id, wa2_contact_link_id)
    REFERENCES wa2_contact_links (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa2_inbound_label_actions_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX wa2_inbound_label_actions_tenant_processed_idx
  ON wa2_inbound_label_actions (tenant_id, processed_at DESC);

CREATE TABLE wa2_label_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  action_id UUID NOT NULL,
  lead_id UUID,
  conflict_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_label_conflicts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_label_conflicts_action_key UNIQUE (tenant_id, action_id),
  CONSTRAINT wa2_label_conflicts_action_fk
    FOREIGN KEY (tenant_id, action_id)
    REFERENCES wa2_inbound_label_actions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa2_label_conflicts_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX wa2_label_conflicts_panel_idx
  ON wa2_label_conflicts (tenant_id, status, created_at DESC);

CREATE TABLE wa2_stage_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  action_id UUID NOT NULL,
  lead_id UUID NOT NULL,
  wa2_contact_link_id UUID NOT NULL,
  requested_stage TEXT NOT NULL CHECK (requested_stage = 'MATRICULATED'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
  confirmed_at TIMESTAMPTZ,
  confirmed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_stage_confirmations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_stage_confirmations_action_key UNIQUE (tenant_id, action_id),
  CONSTRAINT wa2_stage_confirmations_action_fk
    FOREIGN KEY (tenant_id, action_id)
    REFERENCES wa2_inbound_label_actions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa2_stage_confirmations_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa2_stage_confirmations_link_fk
    FOREIGN KEY (tenant_id, wa2_contact_link_id)
    REFERENCES wa2_contact_links (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX wa2_stage_confirmations_panel_idx
  ON wa2_stage_confirmations (tenant_id, status, created_at DESC);

CREATE TABLE meta_historical_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  page_id TEXT NOT NULL CHECK (page_id ~ '^[0-9]{1,100}$'),
  form_id TEXT NOT NULL CHECK (form_id ~ '^[0-9]{1,100}$'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED')),
  cursor_value TEXT,
  received_count INTEGER NOT NULL DEFAULT 0 CHECK (received_count >= 0),
  created_count INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  invalid_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
  conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  locked_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_code TEXT,
  last_error_message TEXT,
  started_by TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_historical_imports_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX meta_historical_imports_claim_idx
  ON meta_historical_imports (tenant_id, status, next_attempt_at, locked_at);
CREATE INDEX meta_historical_imports_panel_idx
  ON meta_historical_imports (tenant_id, created_at DESC);

CREATE TABLE meta_historical_import_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  import_id UUID NOT NULL,
  meta_lead_id TEXT NOT NULL,
  lead_id UUID,
  result TEXT NOT NULL CHECK (result IN ('CREATED', 'UPDATED', 'INVALID', 'FAILED')),
  error_code TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_historical_import_items_tenant_item_key
    UNIQUE (tenant_id, import_id, meta_lead_id),
  CONSTRAINT meta_historical_import_items_import_fk
    FOREIGN KEY (tenant_id, import_id)
    REFERENCES meta_historical_imports (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT meta_historical_import_items_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX meta_historical_import_items_progress_idx
  ON meta_historical_import_items (tenant_id, import_id, processed_at);

CREATE TABLE wa2_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  wa2_instance_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED')),
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  locked_at TIMESTAMPTZ,
  started_by TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_reconciliation_runs_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_reconciliation_runs_instance_fk
    FOREIGN KEY (tenant_id, wa2_instance_id)
    REFERENCES wa2_instances (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX wa2_reconciliation_runs_claim_idx
  ON wa2_reconciliation_runs (tenant_id, status, locked_at, created_at);
CREATE INDEX wa2_reconciliation_runs_panel_idx
  ON wa2_reconciliation_runs (tenant_id, created_at DESC);

CREATE TABLE wa2_reconciliation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  run_id UUID NOT NULL,
  lead_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
  result TEXT CHECK (
    result IS NULL OR result IN (
      'LINKED', 'ALREADY_LINKED', 'PHONE_INVALID', 'CONTACT_NOT_FOUND',
      'CONTACT_WITHOUT_CHAT', 'AMBIGUOUS', 'LID', 'GROUP', 'CONFLICT',
      'SYNC_SCHEDULED', 'DONE', 'FAILED'
    )
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at TIMESTAMPTZ,
  last_error_code TEXT,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_reconciliation_items_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_reconciliation_items_run_lead_key UNIQUE (tenant_id, run_id, lead_id),
  CONSTRAINT wa2_reconciliation_items_run_fk
    FOREIGN KEY (tenant_id, run_id)
    REFERENCES wa2_reconciliation_runs (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa2_reconciliation_items_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX wa2_reconciliation_items_claim_idx
  ON wa2_reconciliation_items (tenant_id, status, locked_at, created_at);
CREATE INDEX wa2_reconciliation_items_results_idx
  ON wa2_reconciliation_items (tenant_id, run_id, result);

ALTER TABLE wa2_label_jobs
  ALTER COLUMN stage_history_id DROP NOT NULL;
ALTER TABLE wa2_label_jobs
  ADD COLUMN reconciliation_item_id UUID;
ALTER TABLE wa2_label_jobs
  ADD CONSTRAINT wa2_label_jobs_reconciliation_item_fk
    FOREIGN KEY (tenant_id, reconciliation_item_id)
    REFERENCES wa2_reconciliation_items (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE wa2_label_jobs
  ADD CONSTRAINT wa2_label_jobs_origin_check
    CHECK (
      (stage_history_id IS NOT NULL AND reconciliation_item_id IS NULL)
      OR (stage_history_id IS NULL AND reconciliation_item_id IS NOT NULL)
    );
CREATE UNIQUE INDEX wa2_label_jobs_reconciliation_item_uidx
  ON wa2_label_jobs (tenant_id, reconciliation_item_id)
  WHERE reconciliation_item_id IS NOT NULL;

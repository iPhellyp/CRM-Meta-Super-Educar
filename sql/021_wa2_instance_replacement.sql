CREATE TABLE IF NOT EXISTS wa2_logical_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  canonical_phone TEXT NOT NULL,
  normalized_pn_jid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  current_wa2_instance_id UUID,
  generation INTEGER NOT NULL DEFAULT 1,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_logical_accounts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_logical_accounts_phone_key UNIQUE (tenant_id, normalized_pn_jid),
  CONSTRAINT wa2_logical_accounts_instance_fk
    FOREIGN KEY (tenant_id, current_wa2_instance_id)
    REFERENCES wa2_instances (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_logical_accounts_phone_check
    CHECK (canonical_phone ~ '^55[1-9][0-9]9[0-9]{8}$'),
  CONSTRAINT wa2_logical_accounts_pn_check
    CHECK (normalized_pn_jid ~ '^[0-9]+@(s[.]whatsapp[.]net|c[.]us)$'),
  CONSTRAINT wa2_logical_accounts_status_check
    CHECK (status IN ('ACTIVE', 'REPLACED', 'UNVERIFIED')),
  CONSTRAINT wa2_logical_accounts_generation_check CHECK (generation >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS wa2_logical_accounts_current_instance_uidx
  ON wa2_logical_accounts (tenant_id, current_wa2_instance_id)
  WHERE current_wa2_instance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wa2_logical_account_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  logical_account_id UUID NOT NULL,
  generation INTEGER NOT NULL,
  wa2_instance_id UUID NOT NULL,
  remote_instance_id TEXT NOT NULL,
  active_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_until TIMESTAMPTZ,
  replacement_reason TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_logical_account_generations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_logical_account_generations_account_fk
    FOREIGN KEY (tenant_id, logical_account_id)
    REFERENCES wa2_logical_accounts (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_logical_account_generations_instance_fk
    FOREIGN KEY (tenant_id, wa2_instance_id)
    REFERENCES wa2_instances (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_logical_account_generations_generation_key
    UNIQUE (tenant_id, logical_account_id, generation),
  CONSTRAINT wa2_logical_account_generations_status_check
    CHECK (status IN ('ACTIVE', 'REPLACED', 'HISTORICAL')),
  CONSTRAINT wa2_logical_account_generations_period_check
    CHECK (active_until IS NULL OR active_until >= active_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS wa2_logical_account_generations_active_uidx
  ON wa2_logical_account_generations (tenant_id, logical_account_id)
  WHERE status = 'ACTIVE' AND active_until IS NULL;

CREATE TABLE IF NOT EXISTS wa2_instance_replacement_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  logical_account_id UUID,
  old_instance_id UUID NOT NULL,
  new_instance_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'DETECTED',
  cutover_at TIMESTAMPTZ,
  dry_run_at TIMESTAMPTZ,
  authorized_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  total_links INTEGER NOT NULL DEFAULT 0,
  recoverable_links INTEGER NOT NULL DEFAULT 0,
  already_aligned INTEGER NOT NULL DEFAULT 0,
  blocked_links INTEGER NOT NULL DEFAULT 0,
  label_matches INTEGER NOT NULL DEFAULT 0,
  label_conflicts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_instance_replacement_runs_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_instance_replacement_runs_account_fk
    FOREIGN KEY (tenant_id, logical_account_id)
    REFERENCES wa2_logical_accounts (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_instance_replacement_runs_old_fk
    FOREIGN KEY (tenant_id, old_instance_id)
    REFERENCES wa2_instances (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_instance_replacement_runs_new_fk
    FOREIGN KEY (tenant_id, new_instance_id)
    REFERENCES wa2_instances (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_instance_replacement_runs_distinct_instances
    CHECK (old_instance_id <> new_instance_id),
  CONSTRAINT wa2_instance_replacement_runs_status_check
    CHECK (status IN ('DETECTED', 'VERIFYING', 'DRY_RUN_COMPLETED', 'WAITING_AUTHORIZATION', 'EXECUTING', 'COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED')),
  CONSTRAINT wa2_instance_replacement_runs_counts_check
    CHECK (total_links >= 0 AND recoverable_links >= 0 AND already_aligned >= 0 AND blocked_links >= 0 AND label_matches >= 0 AND label_conflicts >= 0)
);

CREATE INDEX IF NOT EXISTS wa2_instance_replacement_runs_tenant_created_idx
  ON wa2_instance_replacement_runs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wa2_instance_replacement_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  run_id UUID NOT NULL,
  lead_id UUID NOT NULL,
  old_link_id UUID,
  candidate_chat_id TEXT,
  candidate_contact_id TEXT,
  normalized_pn_jid TEXT,
  result TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  writes JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_instance_replacement_items_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_instance_replacement_items_run_fk
    FOREIGN KEY (tenant_id, run_id)
    REFERENCES wa2_instance_replacement_runs (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_instance_replacement_items_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_instance_replacement_items_link_fk
    FOREIGN KEY (tenant_id, old_link_id)
    REFERENCES wa2_contact_links (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_instance_replacement_items_result_check
    CHECK (result IN ('EXACT_SINGLE_MATCH', 'ALREADY_ALIGNED', 'NO_MATCH', 'MULTIPLE_MATCHES', 'IDENTITY_CONFLICT', 'PHONE_CONFLICT', 'INVALID_PHONE', 'LID_WITHOUT_PN', 'NON_INDIVIDUAL_CHAT')),
  CONSTRAINT wa2_instance_replacement_items_pn_check
    CHECK (normalized_pn_jid IS NULL OR normalized_pn_jid ~ '^[0-9]+@(s[.]whatsapp[.]net|c[.]us)$')
);

CREATE UNIQUE INDEX IF NOT EXISTS wa2_instance_replacement_items_run_lead_uidx
  ON wa2_instance_replacement_items (tenant_id, run_id, lead_id);

CREATE INDEX IF NOT EXISTS wa2_instance_replacement_items_run_result_idx
  ON wa2_instance_replacement_items (tenant_id, run_id, result);

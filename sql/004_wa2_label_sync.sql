ALTER TABLE lead_stage_history
  ADD CONSTRAINT lead_stage_history_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE wa2_contact_links
  ADD CONSTRAINT wa2_contact_links_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE wa2_label_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  wa2_instance_id UUID NOT NULL,
  stage TEXT NOT NULL,
  remote_label_id TEXT NOT NULL,
  remote_label_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_label_bindings_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_label_bindings_instance_stage_key
    UNIQUE (tenant_id, wa2_instance_id, stage),
  CONSTRAINT wa2_label_bindings_instance_fk
    FOREIGN KEY (tenant_id, wa2_instance_id)
    REFERENCES wa2_instances (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_label_bindings_stage_check
    CHECK (
      stage IN (
        'NEW',
        'CONTACTED',
        'QUALIFIED',
        'VESTIBULAR_REGISTERED',
        'VESTIBULAR_COMPLETED',
        'MATRICULATED',
        'LOST'
      )
    ),
  CONSTRAINT wa2_label_bindings_remote_id_check
    CHECK (
      char_length(remote_label_id) BETWEEN 1 AND 128
      AND remote_label_id ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT wa2_label_bindings_remote_name_check
    CHECK (char_length(btrim(remote_label_name)) BETWEEN 1 AND 200)
);

CREATE INDEX wa2_label_bindings_tenant_instance_idx
  ON wa2_label_bindings (tenant_id, wa2_instance_id, enabled);

CREATE TABLE wa2_label_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  lead_id UUID NOT NULL,
  wa2_instance_id UUID NOT NULL,
  wa2_contact_link_id UUID NOT NULL,
  stage_history_id UUID NOT NULL,
  target_stage TEXT NOT NULL,
  target_remote_label_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_label_jobs_lead_fk
    FOREIGN KEY (tenant_id, lead_id)
    REFERENCES leads (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_label_jobs_instance_fk
    FOREIGN KEY (tenant_id, wa2_instance_id)
    REFERENCES wa2_instances (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_label_jobs_contact_link_fk
    FOREIGN KEY (tenant_id, wa2_contact_link_id)
    REFERENCES wa2_contact_links (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_label_jobs_stage_history_fk
    FOREIGN KEY (tenant_id, stage_history_id)
    REFERENCES lead_stage_history (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa2_label_jobs_change_key
    UNIQUE (
      tenant_id,
      stage_history_id,
      wa2_instance_id,
      wa2_contact_link_id
    ),
  CONSTRAINT wa2_label_jobs_target_stage_check
    CHECK (
      target_stage IN (
        'NEW',
        'CONTACTED',
        'QUALIFIED',
        'VESTIBULAR_REGISTERED',
        'VESTIBULAR_COMPLETED',
        'MATRICULATED',
        'LOST'
      )
    ),
  CONSTRAINT wa2_label_jobs_target_label_check
    CHECK (
      char_length(target_remote_label_id) BETWEEN 1 AND 128
      AND target_remote_label_id ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT wa2_label_jobs_status_check
    CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
  CONSTRAINT wa2_label_jobs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT wa2_label_jobs_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 10),
  CONSTRAINT wa2_label_jobs_error_code_check
    CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 80),
  CONSTRAINT wa2_label_jobs_error_message_check
    CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 500)
);

CREATE INDEX wa2_label_jobs_claim_idx
  ON wa2_label_jobs (status, available_at, created_at);

CREATE INDEX wa2_label_jobs_stale_idx
  ON wa2_label_jobs (locked_at)
  WHERE status = 'RUNNING';

CREATE INDEX wa2_label_jobs_tenant_created_idx
  ON wa2_label_jobs (tenant_id, created_at DESC);

CREATE INDEX wa2_label_jobs_lead_created_idx
  ON wa2_label_jobs (tenant_id, lead_id, created_at DESC);

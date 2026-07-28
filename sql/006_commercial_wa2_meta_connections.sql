CREATE TABLE tenant_settings (
  tenant_id TEXT PRIMARY KEY,
  whatsapp_initial_message TEXT NOT NULL DEFAULT
    'Olá, {{nome}}! Tudo bem? Sou da Super Educar e estou entrando em contato sobre seu interesse em nossos cursos.',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_settings_whatsapp_message_check
    CHECK (char_length(whatsapp_initial_message) BETWEEN 1 AND 1000)
);

CREATE TABLE meta_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  business_id TEXT NOT NULL,
  ad_account_id TEXT,
  app_id TEXT,
  encrypted_access_token TEXT NOT NULL,
  encrypted_app_secret TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'VALID', 'INVALID', 'ERROR')),
  active BOOLEAN NOT NULL DEFAULT true,
  last_validated_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_connections_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT meta_connections_tenant_business_key UNIQUE (tenant_id, business_id),
  CONSTRAINT meta_connections_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT meta_connections_business_check CHECK (business_id ~ '^[0-9]{1,100}$'),
  CONSTRAINT meta_connections_ad_account_check
    CHECK (ad_account_id IS NULL OR ad_account_id ~ '^[0-9]{1,100}$'),
  CONSTRAINT meta_connections_app_check CHECK (app_id IS NULL OR app_id ~ '^[0-9]{1,100}$'),
  CONSTRAINT meta_connections_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 500)
);

CREATE INDEX meta_connections_tenant_active_idx
  ON meta_connections (tenant_id, active, created_at DESC);

CREATE TABLE meta_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  meta_connection_id UUID NOT NULL,
  page_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_pages_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT meta_pages_tenant_page_key UNIQUE (tenant_id, page_id),
  CONSTRAINT meta_pages_connection_fk
    FOREIGN KEY (tenant_id, meta_connection_id)
    REFERENCES meta_connections (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT meta_pages_page_id_check CHECK (page_id ~ '^[0-9]{1,100}$'),
  CONSTRAINT meta_pages_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200)
);

CREATE INDEX meta_pages_connection_idx
  ON meta_pages (tenant_id, meta_connection_id, active);

CREATE TABLE meta_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  meta_page_id UUID NOT NULL,
  form_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  last_imported_at TIMESTAMPTZ,
  cursor_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_forms_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT meta_forms_tenant_form_key UNIQUE (tenant_id, form_id),
  CONSTRAINT meta_forms_page_fk
    FOREIGN KEY (tenant_id, meta_page_id)
    REFERENCES meta_pages (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT meta_forms_form_id_check CHECK (form_id ~ '^[0-9]{1,100}$'),
  CONSTRAINT meta_forms_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200)
);

CREATE INDEX meta_forms_page_idx ON meta_forms (tenant_id, meta_page_id, active);

CREATE TABLE meta_datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  meta_connection_id UUID NOT NULL,
  dataset_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  encrypted_test_event_code TEXT,
  last_test_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_datasets_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT meta_datasets_tenant_dataset_key UNIQUE (tenant_id, dataset_id),
  CONSTRAINT meta_datasets_connection_fk
    FOREIGN KEY (tenant_id, meta_connection_id)
    REFERENCES meta_connections (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT meta_datasets_dataset_id_check CHECK (dataset_id ~ '^[0-9]{1,100}$'),
  CONSTRAINT meta_datasets_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT meta_datasets_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 500)
);

CREATE INDEX meta_datasets_connection_idx
  ON meta_datasets (tenant_id, meta_connection_id, active);

ALTER TABLE leads
  ADD COLUMN whatsapp TEXT,
  ADD COLUMN whatsapp_normalized TEXT,
  ADD COLUMN remote_jid TEXT,
  ADD COLUMN lost_reason TEXT,
  ADD COLUMN lost_notes TEXT,
  ADD COLUMN meta_connection_id UUID,
  ADD COLUMN business_id TEXT,
  ADD COLUMN ad_account_id TEXT,
  ADD COLUMN dataset_id TEXT,
  ADD COLUMN source_created_at TIMESTAMPTZ;

ALTER TABLE leads
  ADD CONSTRAINT leads_whatsapp_normalized_check
    CHECK (whatsapp_normalized IS NULL OR whatsapp_normalized ~ '^55[1-9][0-9]{9,10}$'),
  ADD CONSTRAINT leads_meta_connection_fk
    FOREIGN KEY (tenant_id, meta_connection_id)
    REFERENCES meta_connections (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT leads_lost_reason_check
    CHECK (
      lost_reason IS NULL OR lost_reason IN (
        'NO_INTEREST', 'NO_RESPONSE', 'INVALID_PHONE', 'OUT_OF_PROFILE',
        'COURSE_UNAVAILABLE', 'PRICE', 'DUPLICATED', 'ENROLLED_ELSEWHERE', 'OTHER'
      )
    ),
  ADD CONSTRAINT leads_lost_notes_check
    CHECK (lost_notes IS NULL OR char_length(lost_notes) <= 1000);

WITH phone_candidates AS (
  SELECT id,
         regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') AS digits
  FROM leads
  WHERE phone_normalized IS NULL
    AND lower(COALESCE(phone, '')) !~ '@lid$'
)
UPDATE leads lead
SET phone_normalized = CASE
  WHEN candidate.digits ~ '^[1-9][0-9]{9,10}$' THEN '55' || candidate.digits
  WHEN candidate.digits ~ '^55[1-9][0-9]{9,10}$' THEN candidate.digits
  ELSE NULL
END
FROM phone_candidates candidate
WHERE candidate.id = lead.id;

ALTER TABLE lead_stage_history
  ADD COLUMN activity_type TEXT NOT NULL DEFAULT 'STAGE_CHANGED',
  ADD COLUMN reason TEXT,
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN meta_event_id UUID;

ALTER TABLE lead_stage_history
  ADD CONSTRAINT lead_stage_history_activity_type_check
    CHECK (
      activity_type IN (
        'LEAD_RECEIVED', 'HISTORICAL_IMPORT', 'WHATSAPP_OPENED',
        'STAGE_CHANGED', 'LABEL_SYNC_REQUESTED', 'LABEL_APPLIED', 'LABEL_REMOVED',
        'META_EVENT_QUEUED', 'META_EVENT_SENT', 'META_EVENT_FAILED',
        'SYNC_CONFLICT', 'LOST'
      )
    ),
  ADD CONSTRAINT lead_stage_history_reason_check
    CHECK (reason IS NULL OR char_length(reason) <= 1000),
  ADD CONSTRAINT lead_stage_history_meta_event_fk
    FOREIGN KEY (meta_event_id) REFERENCES meta_conversion_events(id) ON DELETE RESTRICT;

ALTER TABLE wa2_instances
  ADD COLUMN phone TEXT,
  ADD COLUMN remote_status TEXT,
  ADD COLUMN last_sync_at TIMESTAMPTZ,
  ADD COLUMN last_error TEXT;

ALTER TABLE wa2_instances
  ADD CONSTRAINT wa2_instances_phone_check
    CHECK (phone IS NULL OR char_length(phone) <= 40),
  ADD CONSTRAINT wa2_instances_status_check
    CHECK (remote_status IS NULL OR char_length(remote_status) <= 40),
  ADD CONSTRAINT wa2_instances_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 500);

ALTER TABLE wa2_label_bindings DROP CONSTRAINT wa2_label_bindings_stage_check;
ALTER TABLE wa2_label_jobs DROP CONSTRAINT wa2_label_jobs_target_stage_check;
ALTER TABLE wa2_stage_confirmations
  DROP CONSTRAINT wa2_stage_confirmations_requested_stage_check;

UPDATE leads SET stage = CASE stage
  WHEN 'CONTACTED' THEN 'IN_SERVICE'
  WHEN 'VESTIBULAR_REGISTERED' THEN 'NEGOTIATING'
  WHEN 'VESTIBULAR_COMPLETED' THEN 'OPPORTUNITY'
  WHEN 'MATRICULATED' THEN 'ENROLLED'
  ELSE stage
END;

UPDATE lead_stage_history SET
  previous_stage = CASE previous_stage
    WHEN 'CONTACTED' THEN 'IN_SERVICE'
    WHEN 'VESTIBULAR_REGISTERED' THEN 'NEGOTIATING'
    WHEN 'VESTIBULAR_COMPLETED' THEN 'OPPORTUNITY'
    WHEN 'MATRICULATED' THEN 'ENROLLED'
    ELSE previous_stage
  END,
  new_stage = CASE new_stage
    WHEN 'CONTACTED' THEN 'IN_SERVICE'
    WHEN 'VESTIBULAR_REGISTERED' THEN 'NEGOTIATING'
    WHEN 'VESTIBULAR_COMPLETED' THEN 'OPPORTUNITY'
    WHEN 'MATRICULATED' THEN 'ENROLLED'
    ELSE new_stage
  END;

UPDATE wa2_label_bindings SET stage = CASE stage
  WHEN 'CONTACTED' THEN 'IN_SERVICE'
  WHEN 'VESTIBULAR_REGISTERED' THEN 'NEGOTIATING'
  WHEN 'VESTIBULAR_COMPLETED' THEN 'OPPORTUNITY'
  WHEN 'MATRICULATED' THEN 'ENROLLED'
  ELSE stage
END;

UPDATE wa2_label_jobs SET target_stage = CASE target_stage
  WHEN 'CONTACTED' THEN 'IN_SERVICE'
  WHEN 'VESTIBULAR_REGISTERED' THEN 'NEGOTIATING'
  WHEN 'VESTIBULAR_COMPLETED' THEN 'OPPORTUNITY'
  WHEN 'MATRICULATED' THEN 'ENROLLED'
  ELSE target_stage
END;

UPDATE wa2_label_bindings
SET enabled = false, updated_at = now()
WHERE stage IN ('ENROLLED', 'PAID');

UPDATE wa2_label_jobs
SET status = 'FAILED',
    last_error_code = 'PROTECTED_STAGE_REQUIRES_SOURCE_CONFIRMATION',
    last_error_message = 'Matrícula e pagamento exigem confirmação do sistema de origem.',
    locked_at = NULL,
    finished_at = now(),
    updated_at = now()
WHERE target_stage IN ('ENROLLED', 'PAID')
  AND status IN ('PENDING', 'RUNNING');

UPDATE wa2_stage_confirmations
SET requested_stage = 'ENROLLED'
WHERE requested_stage = 'MATRICULATED';

ALTER TABLE wa2_label_bindings
  ADD CONSTRAINT wa2_label_bindings_stage_check CHECK (
    stage IN (
      'NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE', 'QUALIFIED',
      'OPPORTUNITY', 'NEGOTIATING', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT',
      'ENROLLED', 'PAID', 'LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'
    )
  );

ALTER TABLE wa2_label_jobs
  ADD CONSTRAINT wa2_label_jobs_target_stage_check CHECK (
    target_stage IN (
      'NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE', 'QUALIFIED',
      'OPPORTUNITY', 'NEGOTIATING', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT',
      'ENROLLED', 'PAID', 'LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'
    )
  );

ALTER TABLE wa2_stage_confirmations
  ADD CONSTRAINT wa2_stage_confirmations_requested_stage_check
    CHECK (requested_stage = 'ENROLLED');

ALTER TABLE wa2_reconciliation_runs
  DROP CONSTRAINT wa2_reconciliation_runs_status_check,
  ADD COLUMN heartbeat_at TIMESTAMPTZ,
  ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_error TEXT;

ALTER TABLE wa2_reconciliation_runs
  ADD CONSTRAINT wa2_reconciliation_runs_status_check
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')),
  ADD CONSTRAINT wa2_reconciliation_runs_retry_count_check CHECK (retry_count >= 0),
  ADD CONSTRAINT wa2_reconciliation_runs_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 500);

WITH duplicate_active_runs AS (
  SELECT id, row_number() OVER (
    PARTITION BY tenant_id, wa2_instance_id
    ORDER BY created_at DESC, id
  ) AS position
  FROM wa2_reconciliation_runs
  WHERE status IN ('PENDING', 'RUNNING')
)
UPDATE wa2_reconciliation_runs run
SET status = 'CANCELLED',
    completed_at = now(),
    last_error = 'Cancelado pela migration 006: havia outro job ativo mais recente.',
    updated_at = now()
FROM duplicate_active_runs duplicate
WHERE run.id = duplicate.id AND duplicate.position > 1;

CREATE UNIQUE INDEX wa2_reconciliation_runs_active_uidx
  ON wa2_reconciliation_runs (tenant_id, wa2_instance_id)
  WHERE status IN ('PENDING', 'RUNNING');

ALTER TABLE wa2_reconciliation_items
  DROP CONSTRAINT wa2_reconciliation_items_result_check;

UPDATE wa2_reconciliation_items SET result = CASE result
  WHEN 'LINKED' THEN 'UPDATED'
  WHEN 'ALREADY_LINKED' THEN 'MATCHED'
  WHEN 'CONTACT_NOT_FOUND' THEN 'NOT_FOUND_IN_WA2'
  WHEN 'CONTACT_WITHOUT_CHAT' THEN 'ERROR'
  WHEN 'AMBIGUOUS' THEN 'CONFLICT'
  WHEN 'LID' THEN 'LID_UNRESOLVED'
  WHEN 'GROUP' THEN 'ERROR'
  WHEN 'SYNC_SCHEDULED' THEN 'UPDATED'
  WHEN 'DONE' THEN 'MATCHED'
  WHEN 'FAILED' THEN 'ERROR'
  ELSE result
END
WHERE result IS NOT NULL;

ALTER TABLE wa2_reconciliation_items
  ADD CONSTRAINT wa2_reconciliation_items_result_check CHECK (
    result IS NULL OR result IN (
      'MATCHED', 'UPDATED', 'PHONE_EMPTY', 'PHONE_INVALID', 'NOT_FOUND_IN_WA2',
      'LID_UNRESOLVED', 'LABEL_UNMAPPED', 'CONFLICT', 'ERROR'
    )
  );

ALTER TABLE meta_historical_imports
  ADD COLUMN meta_connection_id UUID,
  ADD COLUMN meta_page_record_id UUID,
  ADD COLUMN meta_form_record_id UUID,
  ADD COLUMN period_start TIMESTAMPTZ,
  ADD COLUMN period_end TIMESTAMPTZ;

ALTER TABLE meta_historical_imports
  ADD CONSTRAINT meta_historical_imports_connection_fk
    FOREIGN KEY (tenant_id, meta_connection_id)
    REFERENCES meta_connections (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT meta_historical_imports_page_fk
    FOREIGN KEY (tenant_id, meta_page_record_id)
    REFERENCES meta_pages (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT meta_historical_imports_form_fk
    FOREIGN KEY (tenant_id, meta_form_record_id)
    REFERENCES meta_forms (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT meta_historical_imports_period_check
    CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start);

ALTER TABLE meta_conversion_events
  ADD COLUMN meta_connection_id UUID,
  ADD COLUMN meta_dataset_id UUID;

ALTER TABLE meta_conversion_events
  ADD CONSTRAINT meta_conversion_events_connection_fk
    FOREIGN KEY (tenant_id, meta_connection_id)
    REFERENCES meta_connections (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT meta_conversion_events_dataset_fk
    FOREIGN KEY (tenant_id, meta_dataset_id)
    REFERENCES meta_datasets (tenant_id, id) ON DELETE RESTRICT;

CREATE INDEX leads_commercial_stage_idx
  ON leads (tenant_id, stage, updated_at DESC);
CREATE INDEX leads_meta_connection_idx
  ON leads (tenant_id, meta_connection_id, created_at DESC);
CREATE INDEX leads_meta_page_form_idx
  ON leads (tenant_id, meta_page_id, meta_form_id);
CREATE INDEX leads_lost_reason_idx
  ON leads (tenant_id, lost_reason, updated_at DESC)
  WHERE lost_reason IS NOT NULL;
CREATE INDEX wa2_reconciliation_items_status_created_idx
  ON wa2_reconciliation_items (tenant_id, status, created_at);

CREATE TABLE scheduled_task_runs (
  tenant_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  local_run_date DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_task_runs_key
    PRIMARY KEY (tenant_id, task_name, local_run_date),
  CONSTRAINT scheduled_task_runs_name_check
    CHECK (char_length(task_name) BETWEEN 1 AND 100)
);

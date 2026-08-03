CREATE TABLE wa2_label_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  wa2_instance_id UUID NOT NULL,
  remote_label_id TEXT NOT NULL,
  remote_label_name TEXT NOT NULL,
  official BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wa2_label_catalog_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT wa2_label_catalog_instance_fk FOREIGN KEY (tenant_id, wa2_instance_id)
    REFERENCES wa2_instances (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa2_label_catalog_key UNIQUE (tenant_id, wa2_instance_id, remote_label_id),
  CONSTRAINT wa2_label_catalog_remote_id_check CHECK (
    char_length(remote_label_id) BETWEEN 1 AND 128
    AND remote_label_id ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT wa2_label_catalog_name_check CHECK (char_length(btrim(remote_label_name)) BETWEEN 1 AND 200)
);

CREATE INDEX wa2_label_catalog_tenant_instance_idx
  ON wa2_label_catalog (tenant_id, wa2_instance_id, enabled);

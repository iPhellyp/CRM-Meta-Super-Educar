ALTER TABLE wa2_label_event_receipts
  ADD COLUMN IF NOT EXISTS remote_label_name TEXT
    CHECK (remote_label_name IS NULL OR char_length(btrim(remote_label_name)) BETWEEN 1 AND 200);

CREATE INDEX IF NOT EXISTS wa2_label_event_receipts_catalog_idx
  ON wa2_label_event_receipts (tenant_id, remote_instance_id, remote_label_id);

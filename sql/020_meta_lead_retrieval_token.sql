ALTER TABLE meta_connections
  ADD COLUMN IF NOT EXISTS encrypted_lead_retrieval_access_token TEXT;

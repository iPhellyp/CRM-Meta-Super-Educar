-- Restore defaults required by the raw outbox insert.
-- Forward-only and preserves all existing delivery rows.
ALTER TABLE "CrmLabelEventDelivery"
  ALTER COLUMN "status" SET DEFAULT 'PENDING',
  ALTER COLUMN "nextAttemptAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

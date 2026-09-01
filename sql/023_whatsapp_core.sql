DO $$
BEGIN
  CREATE TYPE "WhatsappStatus" AS ENUM ('disconnected', 'connecting', 'qr', 'connected', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'scheduled', 'running', 'paused', 'completed', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "CampaignRecipientStatus" AS ENUM ('pending', 'scheduled', 'sending', 'sent', 'failed', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "WhatsappInstanceRole" AS ENUM ('SALES', 'SUPPORT', 'BILLING', 'POST_SALES', 'AFFILIATE', 'GENERAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "WhatsappLabelEventOperation" AS ENUM ('APPLY', 'REMOVE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "WhatsappLabelEventSource" AS ENUM ('INTERNAL_API', 'WHATSAPP', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "CrmLabelEventDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'RETRY', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "WhatsappInstance" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "role" "WhatsappInstanceRole" NOT NULL DEFAULT 'GENERAL',
  "status" "WhatsappStatus" NOT NULL DEFAULT 'disconnected',
  "sessionKey" TEXT NOT NULL UNIQUE,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "lastConnectedAt" TIMESTAMP(3),
  "lastSyncAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "ImportBatch" (
  "id" TEXT PRIMARY KEY,
  "filename" TEXT NOT NULL,
  "totalRows" INTEGER NOT NULL,
  "insertedRows" INTEGER NOT NULL,
  "duplicatedRows" INTEGER NOT NULL,
  "invalidRows" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "WhatsappSession" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "status" "WhatsappStatus" NOT NULL DEFAULT 'disconnected',
  "qrCode" TEXT,
  "connectedPhone" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsappSession_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Contact" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phoneRaw" TEXT NOT NULL,
  "phoneNormalized" TEXT NOT NULL,
  "message" TEXT,
  "source" TEXT NOT NULL,
  "optedOut" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Contact_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "WhatsappChat" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "jid" TEXT NOT NULL,
  "name" TEXT,
  "isGroup" BOOLEAN NOT NULL DEFAULT false,
  "unreadCount" INTEGER NOT NULL DEFAULT 0,
  "lastMessageAt" TIMESTAMP(3),
  "lastMessageText" TEXT,
  "lastInboundAt" TIMESTAMP(3),
  "lastOutboundAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsappChat_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "WhatsappContact" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "jid" TEXT NOT NULL,
  "phone" TEXT,
  "name" TEXT,
  "pushName" TEXT,
  "isBusiness" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsappContact_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "WhatsappMessage" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "waMessageId" TEXT NOT NULL,
  "jid" TEXT NOT NULL,
  "fromMe" BOOLEAN NOT NULL DEFAULT false,
  "senderJid" TEXT,
  "timestamp" TIMESTAMP(3),
  "messageType" TEXT,
  "text" TEXT,
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsappMessage_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WhatsappMessage_chatId_fkey"
    FOREIGN KEY ("chatId") REFERENCES "WhatsappChat"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "WhatsappLabel" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "waLabelId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT,
  "predefined" BOOLEAN NOT NULL DEFAULT false,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "rawJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsappLabel_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "WhatsappChatLabel" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "labelId" TEXT NOT NULL,
  "jid" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsappChatLabel_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WhatsappChatLabel_chatId_fkey"
    FOREIGN KEY ("chatId") REFERENCES "WhatsappChat"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WhatsappChatLabel_labelId_fkey"
    FOREIGN KEY ("labelId") REFERENCES "WhatsappLabel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "WhatsappLabelEvent" (
  "id" BIGSERIAL PRIMARY KEY,
  "eventId" UUID NOT NULL UNIQUE,
  "instanceId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "jid" TEXT NOT NULL,
  "phoneNormalized" TEXT,
  "waLabelId" TEXT NOT NULL,
  "operation" "WhatsappLabelEventOperation" NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "source" "WhatsappLabelEventSource" NOT NULL,
  "correlationKey" TEXT,
  "eligibleForCrm" BOOLEAN NOT NULL DEFAULT false,
  "ineligibleReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsappLabelEvent_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "WhatsappIdentity" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "lidJid" TEXT NOT NULL,
  "phoneJid" TEXT,
  "phoneNormalized" TEXT,
  "source" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsappIdentity_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "CrmLabelEventDelivery" (
  "id" BIGSERIAL PRIMARY KEY,
  "eventId" UUID NOT NULL UNIQUE,
  "payload" JSONB NOT NULL,
  "status" "CrmLabelEventDeliveryStatus" NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL,
  "lastError" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "Campaign" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "defaultMessage" TEXT,
  "intervalMinutes" INTEGER NOT NULL,
  "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
  "targetMode" TEXT NOT NULL DEFAULT 'manual',
  "targetLabelId" TEXT,
  "excludeGroups" BOOLEAN NOT NULL DEFAULT true,
  "excludeAlreadySentDays" INTEGER,
  "dedupeMode" TEXT NOT NULL DEFAULT 'same_campaign',
  "dedupeKey" TEXT,
  "creationKey" TEXT,
  "maxRecipients" INTEGER,
  "sendWindowStart" TEXT,
  "sendWindowEnd" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "scheduledAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "mediaKind" TEXT,
  "mediaPath" TEXT,
  "mediaOriginalName" TEXT,
  "mediaMimeType" TEXT,
  "mediaSizeBytes" INTEGER,
  "lastError" TEXT,
  "dispatchConfig" JSONB,
  "nextDispatchAt" TIMESTAMP(3),
  CONSTRAINT "Campaign_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Campaign_targetLabelId_fkey"
    FOREIGN KEY ("targetLabelId") REFERENCES "WhatsappLabel"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "CampaignRecipient" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "contactId" TEXT,
  "chatId" TEXT,
  "jid" TEXT,
  "messageFinal" TEXT NOT NULL,
  "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'pending',
  "dedupeKey" TEXT,
  "skippedReason" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "scheduledAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignRecipient_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CampaignRecipient_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CampaignRecipient_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "SendLog" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL,
  "jid" TEXT NOT NULL,
  "chatId" TEXT,
  "campaignId" TEXT,
  "recipientId" TEXT,
  "messageHash" TEXT,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SendLog_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SendLog_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "SendLog_recipientId_fkey"
    FOREIGN KEY ("recipientId") REFERENCES "CampaignRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Contact_instanceId_idx" ON "Contact"("instanceId");
CREATE INDEX IF NOT EXISTS "Contact_source_idx" ON "Contact"("source");
CREATE INDEX IF NOT EXISTS "Contact_optedOut_idx" ON "Contact"("optedOut");
CREATE UNIQUE INDEX IF NOT EXISTS "Contact_instanceId_phoneNormalized_key" ON "Contact"("instanceId", "phoneNormalized");
CREATE INDEX IF NOT EXISTS "WhatsappInstance_isDefault_idx" ON "WhatsappInstance"("isDefault");
CREATE INDEX IF NOT EXISTS "WhatsappInstance_role_idx" ON "WhatsappInstance"("role");
CREATE INDEX IF NOT EXISTS "WhatsappSession_instanceId_idx" ON "WhatsappSession"("instanceId");
CREATE INDEX IF NOT EXISTS "WhatsappChat_instanceId_jid_idx" ON "WhatsappChat"("instanceId", "jid");
CREATE INDEX IF NOT EXISTS "WhatsappChat_lastMessageAt_idx" ON "WhatsappChat"("lastMessageAt");
CREATE INDEX IF NOT EXISTS "WhatsappChat_isGroup_idx" ON "WhatsappChat"("isGroup");
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappChat_instanceId_jid_key" ON "WhatsappChat"("instanceId", "jid");
CREATE INDEX IF NOT EXISTS "WhatsappContact_instanceId_phone_idx" ON "WhatsappContact"("instanceId", "phone");
CREATE INDEX IF NOT EXISTS "WhatsappContact_phone_idx" ON "WhatsappContact"("phone");
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappContact_instanceId_jid_key" ON "WhatsappContact"("instanceId", "jid");
CREATE INDEX IF NOT EXISTS "WhatsappMessage_instanceId_jid_idx" ON "WhatsappMessage"("instanceId", "jid");
CREATE INDEX IF NOT EXISTS "WhatsappMessage_chatId_timestamp_idx" ON "WhatsappMessage"("chatId", "timestamp");
CREATE INDEX IF NOT EXISTS "WhatsappMessage_fromMe_idx" ON "WhatsappMessage"("fromMe");
CREATE INDEX IF NOT EXISTS "WhatsappMessage_jid_idx" ON "WhatsappMessage"("jid");
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappMessage_instanceId_jid_waMessageId_key" ON "WhatsappMessage"("instanceId", "jid", "waMessageId");
CREATE INDEX IF NOT EXISTS "WhatsappLabel_instanceId_waLabelId_idx" ON "WhatsappLabel"("instanceId", "waLabelId");
CREATE INDEX IF NOT EXISTS "WhatsappLabel_deleted_idx" ON "WhatsappLabel"("deleted");
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappLabel_instanceId_waLabelId_key" ON "WhatsappLabel"("instanceId", "waLabelId");
CREATE INDEX IF NOT EXISTS "WhatsappChatLabel_instanceId_jid_idx" ON "WhatsappChatLabel"("instanceId", "jid");
CREATE INDEX IF NOT EXISTS "WhatsappChatLabel_jid_idx" ON "WhatsappChatLabel"("jid");
CREATE INDEX IF NOT EXISTS "WhatsappChatLabel_labelId_idx" ON "WhatsappChatLabel"("labelId");
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappChatLabel_instanceId_chatId_labelId_key" ON "WhatsappChatLabel"("instanceId", "chatId", "labelId");
CREATE INDEX IF NOT EXISTS "WhatsappLabelEvent_instanceId_id_idx" ON "WhatsappLabelEvent"("instanceId", "id");
CREATE INDEX IF NOT EXISTS "WhatsappLabelEvent_createdAt_id_idx" ON "WhatsappLabelEvent"("createdAt", "id");
CREATE INDEX IF NOT EXISTS "WhatsappIdentity_instanceId_confidence_idx" ON "WhatsappIdentity"("instanceId", "confidence");
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappIdentity_instanceId_lidJid_key" ON "WhatsappIdentity"("instanceId", "lidJid");
CREATE INDEX IF NOT EXISTS "WhatsappIdentity_instanceId_phoneNormalized_idx" ON "WhatsappIdentity"("instanceId", "phoneNormalized");
CREATE INDEX IF NOT EXISTS "CrmLabelEventDelivery_claim_idx" ON "CrmLabelEventDelivery"("status", "nextAttemptAt", "id");
CREATE INDEX IF NOT EXISTS "Campaign_instanceId_createdAt_idx" ON "Campaign"("instanceId", "createdAt");
CREATE INDEX IF NOT EXISTS "Campaign_instanceId_status_scheduledAt_idx" ON "Campaign"("instanceId", "status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "Campaign_instanceId_status_nextDispatchAt_idx" ON "Campaign"("instanceId", "status", "nextDispatchAt");
CREATE INDEX IF NOT EXISTS "Campaign_status_idx" ON "Campaign"("status");
CREATE INDEX IF NOT EXISTS "Campaign_targetMode_idx" ON "Campaign"("targetMode");
CREATE INDEX IF NOT EXISTS "Campaign_targetLabelId_idx" ON "Campaign"("targetLabelId");
CREATE UNIQUE INDEX IF NOT EXISTS "Campaign_instanceId_creationKey_key" ON "Campaign"("instanceId", "creationKey");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_instanceId_campaignId_idx" ON "CampaignRecipient"("instanceId", "campaignId");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_status_idx" ON "CampaignRecipient"("campaignId", "status");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_contactId_idx" ON "CampaignRecipient"("contactId");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_jid_idx" ON "CampaignRecipient"("jid");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_dedupeKey_idx" ON "CampaignRecipient"("dedupeKey");
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_contactId_key" ON "CampaignRecipient"("campaignId", "contactId");
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_jid_key" ON "CampaignRecipient"("campaignId", "jid");
CREATE INDEX IF NOT EXISTS "SendLog_instanceId_jid_sentAt_idx" ON "SendLog"("instanceId", "jid", "sentAt");
CREATE INDEX IF NOT EXISTS "SendLog_jid_sentAt_idx" ON "SendLog"("jid", "sentAt");
CREATE INDEX IF NOT EXISTS "SendLog_campaignId_idx" ON "SendLog"("campaignId");
CREATE INDEX IF NOT EXISTS "SendLog_recipientId_idx" ON "SendLog"("recipientId");
CREATE INDEX IF NOT EXISTS "SendLog_messageHash_idx" ON "SendLog"("messageHash");

export const META_CLEAN_DATASET_ID = '1059632093187676';
export const META_LEGACY_DATASET_ID = '775516968145969';

const DIGITS = /^\d{1,100}$/;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function assertMetaCleanDatasetId(datasetId) {
  const value = String(datasetId || '').trim();
  if (value !== META_CLEAN_DATASET_ID || value === META_LEGACY_DATASET_ID) {
    throw new Error('META_CLEAN_DATASET_INVALID');
  }
  return value;
}

export function buildMetaCleanMqlCanary({
  tenantId,
  metaLeadId,
  eventTime,
  confirmationId,
  datasetId = META_CLEAN_DATASET_ID,
}) {
  const dataset = assertMetaCleanDatasetId(datasetId);
  const tenant = String(tenantId || '').trim();
  const lead = String(metaLeadId || '').trim();
  const confirmation = String(confirmationId || '').trim();
  if (!SAFE_COMPONENT.test(tenant)) throw new Error('META_CLEAN_TENANT_INVALID');
  if (!DIGITS.test(lead)) throw new Error('META_CLEAN_META_LEAD_ID_INVALID');
  if (!SAFE_COMPONENT.test(confirmation)) throw new Error('META_CLEAN_CONFIRMATION_INVALID');
  const parsedEventTime = new Date(eventTime);
  if (!Number.isFinite(parsedEventTime.getTime())) throw new Error('META_CLEAN_EVENT_TIME_INVALID');

  const eventId = `crm-clean-canary:${tenant}:${dataset}:${lead}:mql:${confirmation}`;
  return {
    dataset_id: dataset,
    data: [{
      event_name: 'Marketing Qualified Lead',
      event_time: Math.floor(parsedEventTime.getTime() / 1000),
      event_id: eventId,
      action_source: 'system_generated',
      custom_data: {
        event_source: 'crm',
        lead_event_source: 'CRM Super Educar',
      },
      user_data: {
        lead_id: lead,
      },
    }],
  };
}

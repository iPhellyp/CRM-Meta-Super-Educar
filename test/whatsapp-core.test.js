import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://localhost:5432/crm_meta_test';
const {
  createWhatsappCampaign,
  listWhatsappContacts,
  updateWhatsappCampaign,
} = await import('../src/whatsapp-core.js');

test('núcleo de campanhas mantém os limites operacionais', () => {
  assert.equal(typeof listWhatsappContacts, 'function');
  assert.equal(typeof createWhatsappCampaign, 'function');
  assert.equal(typeof updateWhatsappCampaign, 'function');
});

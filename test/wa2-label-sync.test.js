import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WA2_LABEL_STAGES,
  WA2_REMOTE_CONFIRM_DELAY_MS,
  WA2_STAGE_LABEL_NAMES,
  getWa2StageLabelName,
  normalizeWa2LabelName,
  isTemporaryWa2LabelError,
  planWa2LabelMutations,
  sanitizeWa2LabelJobError,
  stagesSharingWa2Label,
  synchronizeWa2LabelJob,
  wa2LabelIdempotencyKey,
  wa2LabelJobCompletionDecision,
  wa2LabelRetryDelayMs,
} from '../src/wa2-label-sync.js';

test('mapeamento usa as seis etiquetas oficiais em todas as etapas', () => {
  assert.deepEqual(WA2_STAGE_LABEL_NAMES, {
    NEW: 'CRM 01 - Em atendimento',
    CONTACT_STARTED: 'CRM 01 - Em atendimento',
    NO_RESPONSE: 'CRM 01 - Em atendimento',
    IN_SERVICE: 'CRM 01 - Em atendimento',
    QUALIFIED: 'CRM 02 - Qualificado',
    OPPORTUNITY: 'CRM 04 - Vestibular concluído',
    NEGOTIATING: 'CRM 03 - Inscrição no vestibular',
    AWAITING_ENROLLMENT: 'CRM 04 - Vestibular concluído',
    AWAITING_PAYMENT: 'CRM 04 - Vestibular concluído',
    ENROLLED: 'CRM 05 - Matriculado',
    PAID: 'CRM 05 - Matriculado',
    LOST: 'CRM 99 - Perdido',
    NO_INTEREST: 'CRM 99 - Perdido',
    INVALID_PHONE: 'CRM 99 - Perdido',
    DUPLICATED: 'CRM 99 - Perdido',
  });
  assert.equal(WA2_LABEL_STAGES.length, 15);
  assert.equal(getWa2StageLabelName('UNKNOWN'), null);
});

test('etapas compartilham as seis etiquetas comerciais oficiais', () => {
  assert.deepEqual(
    stagesSharingWa2Label('NEW'),
    ['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE'],
  );
  assert.deepEqual(stagesSharingWa2Label('QUALIFIED'), ['QUALIFIED']);
  assert.deepEqual(stagesSharingWa2Label('NEGOTIATING'), ['NEGOTIATING']);
  assert.deepEqual(
    stagesSharingWa2Label('OPPORTUNITY'),
    ['OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT'],
  );
  assert.deepEqual(stagesSharingWa2Label('ENROLLED'), ['ENROLLED', 'PAID']);
  assert.deepEqual(
    stagesSharingWa2Label('LOST'),
    ['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'],
  );
  assert.equal(new Set(Object.values(WA2_STAGE_LABEL_NAMES)).size, 6);
});

test('sugestão de etiqueta ignora acento, caixa e espaços', () => {
  assert.equal(
    normalizeWa2LabelName('  CRM 04 - VESTIBULAR CONCLUÍDO  '),
    normalizeWa2LabelName('crm 04 - vestibular concluido'),
  );
});

test('plano aplica desejada, remove apenas CRM conhecida e preserva externa', () => {
  assert.deepEqual(planWa2LabelMutations({
    currentLabelIds: ['crm-old', 'external-personal'],
    knownCrmLabelIds: ['crm-old', 'crm-target'],
    targetLabelId: 'crm-target',
  }), {
    apply: ['crm-target'],
    remove: ['crm-old'],
  });
});

test('plano já correto não repete aplicação nem remoção', () => {
  assert.deepEqual(planWa2LabelMutations({
    currentLabelIds: ['crm-target', 'external'],
    knownCrmLabelIds: ['crm-old', 'crm-target'],
    targetLabelId: 'crm-target',
  }), { apply: [], remove: [] });
});

test('mutação enfileirada não confirma conclusão enquanto estado remoto não converge', async () => {
  const calls = [];
  let listCalls = 0;
  const client = {
    listWa2ChatLabels: async () => {
      listCalls += 1;
      return [
        { id: 'crm-old', name: 'Antiga' },
        { id: 'external', name: 'Pessoal' },
      ];
    },
    applyWa2ChatLabel: async (...args) => {
      calls.push(['apply', ...args]);
      return { operation: 'apply', changed: true, enqueued: true, jobId: 'remote-1' };
    },
    removeWa2ChatLabel: async (...args) => {
      calls.push(['remove', ...args]);
      return { operation: 'remove', changed: true, enqueued: true, jobId: 'remote-2' };
    },
  };
  const result = await synchronizeWa2LabelJob({
    id: '11111111-1111-4111-8111-111111111111',
    remote_instance_id: 'instance-1',
    remote_chat_id: 'chat-1',
    target_remote_label_id: 'crm-target',
    known_remote_label_ids: ['crm-old', 'crm-target'],
  }, client);
  assert.deepEqual(result, {
    applied: 1,
    removed: 1,
    alreadyCorrect: false,
    mutationEnqueued: true,
    confirmed: false,
    remotePending: true,
  });
  assert.equal(listCalls, 2);
  assert.deepEqual(calls, [
    ['apply', 'instance-1', 'chat-1', 'crm-target', {
      idempotencyKey: wa2LabelIdempotencyKey(
        '11111111-1111-4111-8111-111111111111',
        'apply',
        'crm-target',
      ),
    }],
    ['remove', 'instance-1', 'chat-1', 'crm-old', {
      idempotencyKey: wa2LabelIdempotencyKey(
        '11111111-1111-4111-8111-111111111111',
        'remove',
        'crm-old',
      ),
    }],
  ]);
  assert.equal(calls.flat().includes('external'), false);
});

test('releitura convergente confirma DONE e preserva etiqueta externa', async () => {
  let listCalls = 0;
  const removed = [];
  const result = await synchronizeWa2LabelJob({
    id: '11111111-1111-4111-8111-111111111111',
    remote_instance_id: 'instance-1',
    remote_chat_id: 'chat-1',
    target_remote_label_id: 'crm-target',
    known_remote_label_ids: ['crm-old', 'crm-target'],
  }, {
    listWa2ChatLabels: async () => {
      listCalls += 1;
      return listCalls === 1
        ? [{ id: 'crm-old' }, { id: 'external' }]
        : [{ id: 'crm-target' }, { id: 'external' }];
    },
    applyWa2ChatLabel: async () => ({
      operation: 'apply', changed: true, enqueued: true, jobId: 'remote-1',
    }),
    removeWa2ChatLabel: async (_instance, _chat, labelId) => {
      removed.push(labelId);
      return { operation: 'remove', changed: true, enqueued: true, jobId: 'remote-2' };
    },
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.remotePending, false);
  assert.deepEqual(removed, ['crm-old']);
  assert.equal(removed.includes('external'), false);
});

test('execução seguinte detecta convergência e não repete mutação', async () => {
  let mutations = 0;
  const result = await synchronizeWa2LabelJob({
    id: '11111111-1111-4111-8111-111111111111',
    remote_instance_id: 'instance-1',
    remote_chat_id: 'chat-1',
    target_remote_label_id: 'crm-target',
    known_remote_label_ids: ['crm-target'],
  }, {
    listWa2ChatLabels: async () => [{ id: 'crm-target', name: 'Atual' }],
    applyWa2ChatLabel: async () => { mutations += 1; },
    removeWa2ChatLabel: async () => { mutations += 1; },
  });
  assert.deepEqual(result, {
    applied: 0,
    removed: 0,
    alreadyCorrect: true,
    mutationEnqueued: false,
    confirmed: true,
    remotePending: false,
  });
  assert.equal(mutations, 0);
});

test('changed=false sem estado final correto não confirma DONE', async () => {
  let lists = 0;
  const result = await synchronizeWa2LabelJob({
    id: '11111111-1111-4111-8111-111111111111',
    remote_instance_id: 'instance-1',
    remote_chat_id: 'chat-1',
    target_remote_label_id: 'crm-target',
    known_remote_label_ids: ['crm-target'],
  }, {
    listWa2ChatLabels: async () => {
      lists += 1;
      return [];
    },
    applyWa2ChatLabel: async () => ({
      operation: 'apply', changed: false, enqueued: false, jobId: null,
    }),
    removeWa2ChatLabel: async () => {
      throw new Error('não deveria remover');
    },
  });
  assert.equal(lists, 2);
  assert.equal(result.confirmed, false);
  assert.equal(result.remotePending, true);
  assert.equal(result.mutationEnqueued, false);
});

test('estado não confirmado volta a PENDING futuro e falha ao atingir o limite', () => {
  const now = 1_800_000_000_000;
  const pending = wa2LabelJobCompletionDecision(
    { confirmed: false },
    { attempts: 2, max_attempts: 5 },
    { now },
  );
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.pendingCode, 'WA2_REMOTE_PENDING');
  assert.equal(pending.availableAt.getTime(), now + WA2_REMOTE_CONFIRM_DELAY_MS);

  const failed = wa2LabelJobCompletionDecision(
    { confirmed: false },
    { attempts: 5, max_attempts: 5 },
    { now },
  );
  assert.deepEqual(failed, {
    status: 'FAILED',
    error: {
      code: 'WA2_LABEL_SYNC_NOT_CONFIRMED',
      message: 'O estado final da etiqueta não foi confirmado no WA2.',
    },
  });
  assert.deepEqual(
    wa2LabelJobCompletionDecision(
      { confirmed: true },
      { attempts: 5, max_attempts: 5 },
      { now },
    ),
    { status: 'DONE' },
  );
});

test('chave idempotente é estável por job, operação e etiqueta', () => {
  const first = wa2LabelIdempotencyKey('job-1', 'apply', 'label-1');
  assert.equal(first, wa2LabelIdempotencyKey('job-1', 'apply', 'label-1'));
  assert.notEqual(first, wa2LabelIdempotencyKey('job-1', 'remove', 'label-1'));
  assert.notEqual(first, wa2LabelIdempotencyKey('job-2', 'apply', 'label-1'));
  assert.match(first, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
});

test('backoff segue 1m, 5m, 15m e 1h', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(wa2LabelRetryDelayMs),
    [60_000, 300_000, 900_000, 3_600_000, 3_600_000],
  );
});

test('classifica falhas transitórias e terminais', () => {
  for (const error of [
    { code: 'WA2_TIMEOUT' },
    { code: 'WA2_UNAVAILABLE' },
    { status: 409 },
    { status: 429 },
    { status: 503 },
  ]) {
    assert.equal(isTemporaryWa2LabelError(error), true);
  }
  for (const error of [{ status: 404 }, { status: 422 }, { code: 'WA2_LABEL_INVALID' }]) {
    assert.equal(isTemporaryWa2LabelError(error), false);
  }
});

test('erro persistido é limitado e não preserva quebras de linha', () => {
  const safe = sanitizeWa2LabelJobError({
    code: 'WA2_TIMEOUT',
    message: `falha\n${'x'.repeat(600)}`,
  });
  assert.equal(safe.code, 'WA2_TIMEOUT');
  assert.equal(safe.message.includes('\n'), false);
  assert.equal(safe.message.length, 500);
});

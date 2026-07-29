import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dashboardView } from '../src/views.js';

const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8');
const views = await readFile(new URL('../src/views.js', import.meta.url), 'utf8');

test('Design System declara camadas e tokens fundamentais', () => {
  assert.match(css, /@layer tokens, base, layout, components, utilities, responsive, accessibility;/);
  for (const token of [
    '--color-brand', '--color-bg', '--color-surface', '--color-border',
    '--color-text', '--color-success', '--color-warning', '--color-error',
    '--color-info', '--color-whatsapp', '--color-meta', '--color-wa2',
    '--space-1', '--space-16', '--radius-sm', '--radius-full',
    '--shadow-sm', '--shadow-modal', '--control-height', '--touch-target',
    '--focus-ring', '--z-header', '--z-dialog', '--z-toast',
  ]) {
    assert.match(css, new RegExp(token));
  }
});

test('fundação preserva foco, toque e movimento reduzido', () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /--touch-target:\s*44px/);
  assert.match(css, /min-height:\s*var\(--control-height\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('layout oferece skip link, landmarks, labels, CSRF e escape', () => {
  assert.match(views, /class="skip-link" href="#main-content"/);
  assert.match(views, /<main id="main-content">/);
  assert.match(views, /<nav aria-label="Navegação principal">/);
  const html = dashboardView({
    leads: [],
    counts: {
      total: 0, new: 0, in_service: 0, qualified: 0, opportunities: 0,
      enrolled: 0, paid: 0, lost: 0, qualificationRate: 0,
      matriculationRate: 0, metaPending: 0, metaRetry: 0, metaFailed: 0,
    },
    metaStatus: { configured: false, graphVersion: 'v25.0', testMode: false, missing: [] },
    filters: {},
    csrfToken: '<csrf>',
  });
  assert.equal(html.includes('value="<csrf>"'), false);
  assert.match(html, /name="_csrf" value="&lt;csrf&gt;"/);
  assert.match(html, /<label>Busca<input/);
});

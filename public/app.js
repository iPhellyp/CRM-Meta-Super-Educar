function setContextMessage(region, message, { error = false } = {}) {
  if (!region) return;
  region.textContent = message;
  region.classList.toggle('error-text', error);
  region.setAttribute('role', error ? 'alert' : 'status');
}

function setWhatsAppLoading(form, loading) {
  const button = form.querySelector('[data-whatsapp-submit]');
  const label = button?.querySelector('[data-button-label]');
  form.classList.toggle('loading', loading);
  form.setAttribute('aria-busy', String(loading));
  if (button) button.disabled = loading;
  if (label) label.textContent = loading ? 'Abrindo WhatsApp…' : 'Abrir no WhatsApp';
}

function closeReservedPopup(popup) {
  try {
    if (popup && !popup.closed) popup.close();
  } catch {
    // A navegação externa pode tornar a referência inacessível.
  }
}

function isStrictWhatsAppUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://wa.me/')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'wa.me' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '';
  } catch {
    return false;
  }
}

function setupWhatsAppActions() {
  for (const form of document.querySelectorAll('[data-whatsapp-form]')) {
    let submitting = false;
    const button = form.querySelector('[data-whatsapp-submit]');
    const fallback = form.querySelector('[data-whatsapp-fallback]');
    const status = form.querySelector('[data-whatsapp-status]');

    form.addEventListener('submit', async (event) => {
      if (event.submitter === fallback) return;
      event.preventDefault();
      if (submitting) return;

      const popup = window.open('about:blank', '_blank');
      if (!popup) {
        fallback?.removeAttribute('hidden');
        setContextMessage(status, 'A nova aba foi bloqueada. Abra nesta aba para continuar.', {
          error: true,
        });
        button?.focus();
        return;
      }

      try {
        popup.opener = null;
      } catch {
        // Alguns navegadores impedem alterar opener; a navegação ainda pode prosseguir.
      }

      submitting = true;
      fallback?.setAttribute('hidden', '');
      setContextMessage(status, 'Preparando a conversa no WhatsApp.');
      setWhatsAppLoading(form, true);

      try {
        const response = await fetch(form.action, {
          method: 'POST',
          body: new FormData(form),
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        const payload = await response.json().catch(() => null);
        if (
          !response.ok ||
          payload?.ok !== true ||
          !isStrictWhatsAppUrl(payload.redirectUrl)
        ) {
          throw new Error(payload?.error?.message || 'Não foi possível abrir o WhatsApp.');
        }
        popup.location.replace(payload.redirectUrl);
        setContextMessage(status, 'WhatsApp aberto em uma nova aba.');
      } catch (error) {
        closeReservedPopup(popup);
        setContextMessage(
          status,
          error instanceof Error ? error.message : 'Não foi possível abrir o WhatsApp.',
          { error: true },
        );
        button?.focus();
      } finally {
        submitting = false;
        setWhatsAppLoading(form, false);
      }
    });
  }
}

function setupActionDisclosures() {
  const disclosures = [...document.querySelectorAll('[data-action-disclosure]')];
  for (const disclosure of disclosures) {
    disclosure.addEventListener('toggle', () => {
      if (!disclosure.open) return;
      const leadActions = disclosure.closest('[data-lead-actions]');
      for (const sibling of leadActions?.querySelectorAll('[data-action-disclosure][open]') || []) {
        if (sibling !== disclosure) sibling.removeAttribute('open');
      }
    });
    disclosure.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !disclosure.open) return;
      event.preventDefault();
      disclosure.removeAttribute('open');
      disclosure.querySelector('summary')?.focus();
    });
  }

  document.addEventListener('click', (event) => {
    for (const disclosure of disclosures) {
      if (disclosure.open && !disclosure.contains(event.target)) {
        disclosure.removeAttribute('open');
      }
    }
  });
}

function setupLostDialog() {
  const dialog = document.querySelector('#lost-dialog');
  const form = document.querySelector('#lost-form');
  const reason = form?.querySelector('[name="lostReason"]');
  const notes = form?.querySelector('[name="lostNotes"]');
  let opener = null;

  for (const button of document.querySelectorAll('[data-lost-lead]')) {
    button.addEventListener('click', () => {
      if (!dialog || !form) return;
      opener = button;
      form.action = `/leads/${encodeURIComponent(button.dataset.lostLead)}/lost`;
      reason.value = '';
      if (notes) {
        notes.value = '';
        notes.required = false;
      }
      dialog.showModal();
      reason?.focus();
    });
  }

  for (const button of document.querySelectorAll('[data-close-dialog]')) {
    button.addEventListener('click', () => button.closest('dialog')?.close());
  }

  reason?.addEventListener('change', () => {
    if (notes) notes.required = reason.value === 'OTHER';
  });

  dialog?.addEventListener('close', () => {
    opener?.focus();
    opener = null;
  });
}

function setupFormLoading() {
  for (const form of document.querySelectorAll('form[method="post"]')) {
    form.addEventListener('submit', (event) => {
      if (event.defaultPrevented) return;
      if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) {
        event.preventDefault();
        return;
      }
      form.classList.add('loading');
      form.setAttribute('aria-busy', 'true');
      for (const button of form.querySelectorAll('button[type="submit"], button:not([type])')) {
        button.disabled = true;
        button.dataset.originalText = button.textContent;
        button.textContent = 'Processando…';
      }
      if (form.target === '_blank') {
        window.setTimeout(() => {
          form.classList.remove('loading');
          form.setAttribute('aria-busy', 'false');
          for (const button of form.querySelectorAll('button[type="submit"], button:not([type])')) {
            button.disabled = false;
            button.textContent = button.dataset.originalText || button.textContent;
          }
        }, 1_000);
      }
    });
  }
}

setupWhatsAppActions();
setupActionDisclosures();
setupLostDialog();
setupFormLoading();

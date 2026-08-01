function setContextMessage(region, message, { error = false } = {}) {
  if (!region) return;
  region.textContent = message;
  region.classList.toggle('error-text', error);
  region.setAttribute('role', error ? 'alert' : 'status');
}

function setupCopyPhoneActions() {
  for (const button of document.querySelectorAll('[data-copy-phone]')) {
    button.addEventListener('click', async (event) => {
      const phone = event.currentTarget.dataset.copyPhone;
      const status = event.currentTarget.closest('.whatsapp-action')
        ?.querySelector('[data-whatsapp-status]');
      try {
        await navigator.clipboard.writeText(phone);
        setContextMessage(status, 'Telefone copiado.');
      } catch {
        const field = document.createElement('textarea');
        field.value = phone;
        field.setAttribute('readonly', '');
        field.className = 'sr-only';
        document.body.append(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        setContextMessage(status, copied ? 'Telefone copiado.' : 'Não foi possível copiar.', {
          error: !copied,
        });
      }
    });
  }
}

function setupWhatsAppLogging() {
  for (const link of document.querySelectorAll('[data-whatsapp-link]')) {
    link.addEventListener('click', () => {
      const url = link.dataset.whatsappLogUrl;
      const csrf = link.dataset.whatsappCsrf;
      if (!url || !csrf) return;
      const body = new URLSearchParams({ _csrf: csrf });
      try {
        const payload = new Blob([body.toString()], {
          type: 'application/x-www-form-urlencoded;charset=UTF-8',
        });
        if (navigator.sendBeacon?.(url, payload)) return;
      } catch {
        // O link direto continua funcionando mesmo sem logging.
      }
      try {
        fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body,
        }).catch(() => {});
      } catch {
        // O link direto continua funcionando mesmo sem logging.
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

function focusableElements(container) {
  return [...container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
    + 'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

function setupNavigationDrawer() {
  const toggle = document.querySelector('[data-nav-toggle]');
  const drawer = document.querySelector('[data-nav-drawer]');
  const backdrop = document.querySelector('[data-nav-backdrop]');
  const closeButton = drawer?.querySelector('[data-nav-close]');
  const main = document.querySelector('main');
  if (!toggle || !drawer) return;

  const mobile = window.matchMedia('(max-width: 1099px)');
  let open = false;

  const close = ({ restoreFocus = true } = {}) => {
    if (!open) return;
    open = false;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', mobile.matches ? 'true' : 'false');
    drawer.inert = mobile.matches;
    document.body.classList.remove('nav-open');
    if (main) main.inert = false;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Abrir menu principal');
    if (restoreFocus) toggle.focus();
  };

  const openDrawer = () => {
    if (!mobile.matches) return;
    open = true;
    drawer.inert = false;
    drawer.setAttribute('aria-hidden', 'false');
    drawer.classList.add('open');
    document.body.classList.add('nav-open');
    if (main) main.inert = true;
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Fechar menu principal');
    closeButton?.focus();
  };

  const syncMode = () => {
    if (!mobile.matches) {
      open = false;
      drawer.classList.remove('open');
      drawer.inert = false;
      drawer.setAttribute('aria-hidden', 'false');
      document.body.classList.remove('nav-open');
      if (main) main.inert = false;
      toggle.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!open) {
      drawer.inert = true;
      drawer.setAttribute('aria-hidden', 'true');
    }
  };

  toggle.addEventListener('click', () => open ? close() : openDrawer());
  closeButton?.addEventListener('click', () => close());
  backdrop?.addEventListener('click', () => close());
  drawer.addEventListener('click', (event) => {
    if (event.target.closest('a[href]')) close({ restoreFocus: false });
  });
  drawer.addEventListener('keydown', (event) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(drawer);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  mobile.addEventListener('change', syncMode);
  syncMode();
}

function setupFilterDrawer() {
  const dialog = document.querySelector('#advanced-filters');
  const opener = document.querySelector('[data-filter-open]');
  const closeButton = dialog?.querySelector('[data-filter-close]');
  if (!dialog || !opener) return;
  let shouldRestoreFocus = false;

  opener.addEventListener('click', () => {
    shouldRestoreFocus = true;
    dialog.showModal();
    dialog.querySelector('input:not([type="hidden"]), select, button')?.focus();
  });
  closeButton?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (shouldRestoreFocus) opener.focus();
    shouldRestoreFocus = false;
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

function setupRequiredSelections() {
  for (const form of document.querySelectorAll('[data-required-selection]')) {
    const choices = [...form.querySelectorAll('input[type="checkbox"][name="formRecordIds"]')];
    const submit = form.querySelector('[data-selection-submit]');
    const feedback = form.querySelector('[data-selection-feedback]');
    if (!choices.length || !submit) continue;
    const sync = () => {
      const selected = choices.filter((choice) => choice.checked).length;
      submit.disabled = selected === 0;
      if (feedback) {
        feedback.textContent = selected
          ? `${selected} formulário(s) selecionado(s).`
          : 'Selecione ao menos um formulário.';
      }
    };
    for (const choice of choices) choice.addEventListener('change', sync);
    sync();
  }
}

const PWA_CACHE_PREFIX = 'crm-meta-public-';
const PWA_DISMISS_KEY = 'crm:pwa-install-dismissed';

function safeSessionGet(key) {
  try {
    return window.sessionStorage?.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionSet(key, value) {
  try {
    window.sessionStorage?.setItem(key, value);
  } catch {
    // Preferências de instalação não são essenciais para a operação.
  }
}

async function clearOwnApplicationData() {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_APP_CACHES' });
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith(PWA_CACHE_PREFIX)).map((key) => caches.delete(key)),
      );
    }
  } catch {
    // O servidor também envia Clear-Site-Data no logout.
  }
  try {
    window.sessionStorage?.removeItem(PWA_DISMISS_KEY);
  } catch {
    // Sem dados comerciais no sessionStorage.
  }
}

function setupPwaShell() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const installPanel = document.querySelector('[data-pwa-install-panel]');
  const installButton = document.querySelector('[data-pwa-install]');
  const installDismiss = document.querySelector('[data-pwa-install-dismiss]');
  const iosNotice = document.querySelector('[data-pwa-ios]');
  const iosDismiss = document.querySelector('[data-pwa-dismiss]');
  const updateNotice = document.querySelector('[data-pwa-update]');
  const reloadButton = document.querySelector('[data-pwa-reload]');
  const connectionStatus = document.querySelector('[data-connection-status]');
  let deferredInstallPrompt = null;
  let waitingWorker = null;
  let reloadRequested = false;

  const dismissInstall = () => {
    safeSessionSet(PWA_DISMISS_KEY, '1');
    installPanel?.setAttribute('hidden', '');
    iosNotice?.setAttribute('hidden', '');
  };
  installDismiss?.addEventListener('click', dismissInstall);
  iosDismiss?.addEventListener('click', dismissInstall);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (!safeSessionGet(PWA_DISMISS_KEY)) installPanel?.removeAttribute('hidden');
  });
  installButton?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    installPanel?.setAttribute('hidden', '');
    await deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    safeSessionSet(PWA_DISMISS_KEY, '1');
  });
  window.addEventListener('appinstalled', () => {
    installPanel?.setAttribute('hidden', '');
    iosNotice?.setAttribute('hidden', '');
  });

  const standalone = window.matchMedia?.('(display-mode: standalone)').matches ||
    navigator.standalone === true;
  const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  if (isiOS && !standalone && !safeSessionGet(PWA_DISMISS_KEY)) {
    iosNotice?.removeAttribute('hidden');
  }

  const showUpdate = (worker) => {
    waitingWorker = worker;
    updateNotice?.removeAttribute('hidden');
  };
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).then((registration) => {
      if (registration.waiting) showUpdate(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdate(worker);
          }
        });
      });
    }).catch(() => {
      // A aplicação continua funcional sem instalação PWA.
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadRequested) window.location.reload();
    });
  }

  for (const form of document.querySelectorAll('form')) {
    const markDirty = () => { form.dataset.dirty = 'true'; };
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
  }
  reloadButton?.addEventListener('click', () => {
    const hasDraft = document.querySelector('form[data-dirty="true"]');
    if (hasDraft && !window.confirm('Há dados não enviados. Recarregar e descartá-los?')) return;
    reloadRequested = true;
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
  });

  const syncConnection = () => {
    const offline = navigator.onLine === false;
    if (connectionStatus) connectionStatus.hidden = !offline;
    if (!offline && document.querySelector('[data-offline-retry]')) window.location.reload();
  };
  window.addEventListener('online', syncConnection);
  window.addEventListener('offline', syncConnection);
  syncConnection();

  for (const form of document.querySelectorAll('[data-pwa-logout]')) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await clearOwnApplicationData();
      form.submit();
    });
  }
}

function setupOfflineRetry() {
  document.querySelector('[data-offline-retry]')?.addEventListener('click', () => {
    window.location.reload();
  });
}

setupCopyPhoneActions();
setupWhatsAppLogging();
setupActionDisclosures();
setupLostDialog();
setupNavigationDrawer();
setupFilterDrawer();
setupRequiredSelections();
setupPwaShell();
setupOfflineRetry();
setupFormLoading();

function setupLeadChangesPolling() {
  if (!document.querySelector('[data-lead-id]')) return;
  let cursor = new Date(0).toISOString();
  let running = false;
  let timer = 0;
  const poll = async () => {
    if (running || document.hidden) return;
    running = true;
    try {
      const response = await fetch(`/api/leads/changes?cursor=${encodeURIComponent(cursor)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return;
      const data = await response.json();
      if (typeof data.cursor === 'string') cursor = data.cursor;
      for (const item of Array.isArray(data.leads) ? data.leads : []) {
        const lead = item?.lead;
        if (!lead?.id) continue;
        const selector = `[data-lead-id="${CSS.escape(String(lead.id))}"]`;
        const nodes = [...document.querySelectorAll(selector)];
        const checked = nodes.flatMap((node) => [...node.querySelectorAll('input.lead-select:checked')]).length > 0;
        const row = document.querySelector(`tr${selector}`);
        const card = document.querySelector(`article${selector}`);
        if (item.removed) {
          row?.remove(); card?.remove();
          continue;
        }
        if (row && item.rowHtml) {
          const replacement = document.createRange().createContextualFragment(item.rowHtml).firstElementChild;
          if (replacement) { row.replaceWith(replacement); if (checked) replacement.querySelector('.lead-select')?.click(); }
        }
        if (card && item.cardHtml) {
          const replacement = document.createRange().createContextualFragment(item.cardHtml).firstElementChild;
          if (replacement) { card.replaceWith(replacement); if (checked) replacement.querySelector('.lead-select')?.click(); }
        }
      }
    } catch { /* reconecta no próximo ciclo */ }
    finally { running = false; }
  };
  const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(async () => { await poll(); schedule(); }, 2000); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void poll(); schedule(); } });
  void poll();
  schedule();
}

setupLeadChangesPolling();


{
  const autoRefreshElement = document.querySelector('[data-auto-refresh-ms]');
  const autoRefreshMs = Number(autoRefreshElement?.getAttribute('data-auto-refresh-ms') || 0);
  if (Number.isFinite(autoRefreshMs) && autoRefreshMs >= 1000) {
    window.setTimeout(() => window.location.reload(), autoRefreshMs);
  }
}

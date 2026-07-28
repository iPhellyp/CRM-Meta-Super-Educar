const lostDialog = document.querySelector('#lost-dialog');
const lostForm = document.querySelector('#lost-form');

for (const button of document.querySelectorAll('[data-lost-lead]')) {
  button.addEventListener('click', () => {
    if (!lostDialog || !lostForm) return;
    lostForm.action = `/leads/${encodeURIComponent(button.dataset.lostLead)}/lost`;
    lostDialog.showModal();
  });
}

for (const button of document.querySelectorAll('[data-close-dialog]')) {
  button.addEventListener('click', () => button.closest('dialog')?.close());
}

for (const form of document.querySelectorAll('form[method="post"]')) {
  form.addEventListener('submit', (event) => {
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) {
      event.preventDefault();
      return;
    }
    form.classList.add('loading');
    for (const button of form.querySelectorAll('button[type="submit"], button:not([type])')) {
      button.disabled = true;
      button.dataset.originalText = button.textContent;
      button.textContent = 'Processando…';
    }
    if (form.target === '_blank') {
      window.setTimeout(() => {
        form.classList.remove('loading');
        for (const button of form.querySelectorAll('button[type="submit"], button:not([type])')) {
          button.disabled = false;
          button.textContent = button.dataset.originalText || button.textContent;
        }
      }, 1_000);
    }
  });
}

const lostReason = lostForm?.querySelector('[name="lostReason"]');
const lostNotes = lostForm?.querySelector('[name="lostNotes"]');
lostReason?.addEventListener('change', () => {
  if (lostNotes) lostNotes.required = lostReason.value === 'OTHER';
});

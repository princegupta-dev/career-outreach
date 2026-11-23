// Runs inside Chrome. No model-generated code is ever executed.
export const READ_FIELDS = `(() => {
  const scope = document.querySelector('[data-job-hunter-scope]') || document;
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const labelOf = e => {
    const ids = (e.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
    const labels = [...(e.labels || [])].map(l => l.innerText.trim()).filter(Boolean);
    return (e.getAttribute('aria-label') || ids.map(id => document.getElementById(id)?.innerText || '').join(' ') || labels.join(' ') || e.getAttribute('placeholder') || e.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 600);
  };
  const result = [], groups = new Set();
  scope.querySelectorAll('[data-job-hunter-field]').forEach(e => e.removeAttribute('data-job-hunter-field'));
  for (const e of scope.querySelectorAll('input, textarea, select, [contenteditable="true"], button[aria-haspopup="listbox"], [role="combobox"], [role="checkbox"]')) {
    if (result.length >= 60) break;
    const type = (e.getAttribute('type') || '').toLowerCase(), tag = e.tagName.toLowerCase();
    const namedUpload = type === 'file' && (e.required || /\\b(resume|cv|cover letter)\\b/i.test(labelOf(e))) && !!e.closest('form, [role="dialog"], [data-job-hunter-scope]') && visible(e.closest('form, [role="dialog"], [data-job-hunter-scope]'));
    if ((!visible(e) && !namedUpload) || e.disabled || e.readOnly || !e.closest('form, [role="dialog"], [class*="application" i], [class*="questionnaire" i], [data-job-hunter-scope]')) continue;
    if (['hidden','password','submit','reset','image','search'].includes(type) || type === 'button' && e.getAttribute('aria-haspopup') !== 'listbox' && e.getAttribute('role') !== 'combobox') continue;
    const id = 'field-' + result.length;
    let label = labelOf(e), kind = tag === 'textarea' || e.isContentEditable ? 'textarea' : tag === 'select' ? 'select' : ['number','tel','email','url'].includes(type) ? type : 'text';
    let value = e.value || e.isContentEditable && e.innerText || '', options = [], reason;
    if (type === 'radio') {
      const group = [...scope.querySelectorAll('input[type="radio"]')].filter(r => r.name === e.name && r.form === e.form && (visible(r) || [...(r.labels||[])].some(visible)));
      const key = group[0]; if (groups.has(key)) continue; groups.add(key);
      const fieldset = e.closest('fieldset, [role="radiogroup"]');
      label = fieldset?.querySelector('legend')?.innerText || fieldset?.getAttribute('aria-label') || fieldset?.querySelector('p, h3, h4')?.innerText || '';
      if (!label) { const p = e.closest('label')?.parentElement || e.parentElement; label = p?.querySelector('p, legend, h3, h4')?.innerText || ''; }
      options = group.map(labelOf); value = group.find(r => r.checked) ? 'already selected' : ''; kind = 'radio';
      group.forEach(r => r.setAttribute('data-job-hunter-field', id));
    } else e.setAttribute('data-job-hunter-field', id);
    if (tag === 'select') {
      options = [...e.options].map(o => o.textContent.trim());
      const selected = e.options[e.selectedIndex];
      if (!value || selected?.disabled || /^(?:select|choose|please select|--)(?:\\b|$)/i.test(selected?.textContent.trim() || '')) value = '';
      if (e.multiple) { kind = 'manual'; reason = 'Review multiple selections yourself.'; }
    }
    if (type === 'checkbox' || type === 'file' || type === 'date') { kind = 'manual'; reason = type === 'file' ? 'Choose and upload the file yourself.' : 'Review this choice yourself.'; value = ''; }
    if (e.getAttribute('role') === 'combobox' || e.getAttribute('aria-haspopup') === 'listbox') { kind = 'combobox'; value = e.value || ''; reason = undefined; }
    if (e.getAttribute('role') === 'checkbox') { kind = 'manual'; value = e.getAttribute('aria-checked') === 'true' ? 'Already selected' : ''; reason = 'Review this choice yourself.'; }
    if (!label) { kind = 'manual'; label = 'Unlabelled field'; reason = 'This control has no clear question or label.'; }
    result.push({ id, label: label.trim().slice(0,600), kind, value: String(value), options, reason, required: !!e.required || e.getAttribute('aria-required') === 'true' || !/\\boptional\\b/i.test(label), maxLength: e.maxLength > 0 ? e.maxLength : undefined });
  }
  return result;
})()`;


import { analyze, deliveryBefore, FIELDS, kindLabel, ruDate } from './parser.js';

const SAMPLES = ['01_contract.txt', '02_amendment_signed.txt', '03_contract.txt', '04_contract.txt', '05_supplier_email.txt', '06_amendment_draft.txt'];
const files = new Map(); // имя файла → текст; повторная загрузка того же имени заменяет файл
let result = { docs: [], rows: [], unlinked: [] };
let lastQuestion = null;

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function readFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1251').decode(buf); }
}

async function addFiles(list) {
  for (const f of list) files.set(f.name, await readFile(f));
  render();
}

$('#files').onchange = async e => { await addFiles(e.target.files); e.target.value = ''; };
const drop = $('#drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
$('#sample').onclick = async () => {
  for (const n of SAMPLES) files.set(n, await (await fetch(`documents/${n}`)).text());
  render();
};
$('#clear').onclick = () => { files.clear(); lastQuestion = null; render(); };
$('#date').onchange = render;

// ——— ссылки на источник ———
const where = p => p.label ? `п. ${p.label}` : `абзац ${p.n}`;
const link = (doc, para) => `<a class="src" href="#${doc.id}-p${para.n}">${esc(doc.name)}, ${where(para)}</a>`;
const cite = (doc, para) => para ? `<span class="cite">${link(doc, para)}<q>${esc(para.text)}</q></span>` : `<span class="cite">${esc(doc.name)}: подходящий абзац не найден</span>`;
const docTitle = d => `${kindLabel(d)} «${esc(d.title)}»`;

function fieldCell(f, key) {
  const fmt = FIELDS[key].format;
  if (f.review) {
    return `<span class="badge warn">Нужна проверка: несколько значений</span>`
      + f.candidates.map(c => `<div>${c.value?.ambiguous ? '?' : esc(fmt(c.value))}${cite(c.doc, c.para)}</div>`).join('');
  }
  let html = f.value == null ? `<span class="na">нет данных</span>` : `<span class="val">${esc(fmt(f.value))}</span>`;
  if (f.changedBy) {
    const was = f.previous?.value != null && !f.previous.review ? `, было ${esc(fmt(f.previous.value))}` : '';
    html += `<br><span class="badge">Изменено: ${esc(f.changedBy.name)}${was}</span>`;
  }
  html += cite(f.doc, f.para);
  for (const x of f.ignored ?? [])
    html += `<span class="cite">Не является ${key === 'amount' ? 'суммой договора' : 'сроком поставки'}: ${esc(fmt(x.value))} — ${link(x.doc, x.para)}</span>`;
  return html;
}

function proposalItem(p) {
  const v = p.review ? 'несколько значений' : FIELDS[p.key].format(p.value);
  return `<li><b>${FIELDS[p.key].label} → ${esc(v)}</b><br><span class="badge warn">${esc(p.note)}</span>${p.para ? cite(p.doc, p.para) : ''}</li>`;
}

function renderTable() {
  $('#rows').innerHTML = result.rows.length ? result.rows.map(r => `<tr>
    <td><span class="val">${esc(r.number)}</span><span class="cite">${link(r.doc, r.doc.paras[0])}</span></td>
    <td>${r.supplier ? esc(r.supplier.value) + cite(r.doc, r.supplier.para) : '<span class="na">нет данных</span>'}</td>
    <td>${fieldCell(r.fields.amount, 'amount')}</td>
    <td>${fieldCell(r.fields.delivery, 'delivery')}</td>
    <td>${r.proposals.length || r.issues.length
      ? `<ul class="plain">${r.issues.map(i => `<li><span class="badge warn">Проверить</span> ${esc(i)}</li>`).join('')}${r.proposals.map(proposalItem).join('')}</ul>`
      : '<span class="muted">нет</span>'}</td>
  </tr>`).join('') : `<tr><td colspan="5" class="empty">Договоры не загружены.</td></tr>`;
}

function renderDocs() {
  $('#unlinked').innerHTML = result.unlinked.length
    ? `<p><span class="badge warn">Требуют проверки</span> Не удалось распознать тип или привязать к договору: ${result.unlinked.map(d => `${esc(d.name)}${d.linkIssue ? ` (${esc(d.linkIssue)})` : ''}`).join(', ')}</p>` : '';
  $('#docs').innerHTML = result.docs.map(d => `<details class="doc" id="${d.id}">
    <summary><b>${esc(d.name)}</b> — ${esc(kindLabel(d))}${d.kind !== 'contract' && d.contract ? `, к договору ${esc(d.contract)}` : ''}${d.kind === 'amendment' && d.signed && d.effectiveOn ? `, вступает в силу ${ruDate(d.effectiveOn)}` : ''}</summary>
    <ol>${d.paras.map(p => `<li id="${d.id}-p${p.n}">${esc(p.text)}</li>`).join('')}</ol>
  </details>`).join('');
}

// ——— вопросы ———
function answerField(no, key) {
  const r = result.rows.find(x => x.number === no);
  if (!r) return `Договор ${esc(no)} не загружен.`;
  const f = r.fields[key];
  const label = FIELDS[key].label;
  const props = r.proposals.filter(p => p.key === key);
  let html = f.review ? `<p><b>${label} по ${esc(no)}: нужна ручная проверка</b>, в документах несколько значений.</p>`
    : f.value == null ? `<p><b>${label} по ${esc(no)}: нет данных.</b> В тексте договора значение не указано.</p>`
    : `<p><b>${label} по ${esc(no)} на ${ruDate($('#date').value)}: ${esc(FIELDS[key].format(f.value))}.</b>${f.changedBy ? ` Значение изменено документом ${docTitle(f.changedBy)}.` : ''}</p>`;
  html += fieldCell(f, key);
  html += props.length ? `<p>Несогласованные изменения (на результат не влияют):</p><ul class="plain">${props.map(proposalItem).join('')}</ul>`
    : `<p class="muted">Несогласованных изменений по этому полю нет.</p>`;
  return html;
}

function answerBefore(iso) {
  const { early, unknown } = deliveryBefore(result.rows, iso);
  let html = early.length ? `<p><b>Срок поставки раньше ${ruDate(iso)}: ${early.map(e => esc(e.row.number)).join(', ')}.</b></p><ul class="plain">${early.map(e => `<li><b>${esc(e.row.number)}</b> — ${ruDate(e.row.fields.delivery.value)}${cite(e.row.fields.delivery.doc, e.row.fields.delivery.para)}${
    e.proposals.length ? `<ul class="plain">${e.proposals.map(proposalItem).join('')}</ul>` : '<span class="muted">Несогласованных изменений срока нет.</span>'}</li>`).join('')}</ul>`
    : `<p><b>Договоров со сроком поставки раньше ${ruDate(iso)} нет.</b></p>`;
  if (unknown.length) html += `<p><span class="badge warn">Не оценены</span> срок не определён: ${unknown.map(r => esc(r.number)).join(', ')}.</p>`;
  return html;
}

function renderAnswer() {
  if (!lastQuestion) { $('#answer').innerHTML = ''; return; }
  $('#answer').innerHTML = lastQuestion.q === 'field' ? answerField(lastQuestion.no, lastQuestion.key) : answerBefore(lastQuestion.date);
}

function ask(q) {
  lastQuestion = q;
  if (q.q === 'field') { $('#qkey').value = q.key; $('#qno').value = q.no; } else $('#qdate').value = q.date;
  renderAnswer();
}

document.querySelectorAll('.quick button').forEach(b => {
  b.onclick = () => ask(b.dataset.q === 'field' ? { q: 'field', no: b.dataset.no, key: b.dataset.field } : { q: 'before', date: b.dataset.date });
});
$('#qfield').onsubmit = e => { e.preventDefault(); ask({ q: 'field', no: $('#qno').value, key: $('#qkey').value }); };
$('#qbefore').onsubmit = e => { e.preventDefault(); ask({ q: 'before', date: $('#qdate').value }); };

// Переход к абзацу: раскрыть документ, прокрутить, подсветить.
document.addEventListener('click', e => {
  const a = e.target.closest('a.src');
  if (!a) return;
  e.preventDefault();
  const li = document.getElementById(a.hash.slice(1));
  if (!li) return;
  li.closest('details').open = true;
  document.querySelectorAll('li.flash').forEach(x => x.classList.remove('flash'));
  li.classList.add('flash');
  li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  history.replaceState(null, '', a.hash);
});

function render() {
  const list = [...files].map(([name, text]) => ({ name, text })).sort((a, b) => a.name.localeCompare(b.name));
  result = analyze(list, $('#date').value || '2026-03-10');
  $('#loaded').textContent = list.length ? `Загружено файлов: ${list.length}. Договоров: ${result.rows.length}.` : 'Файлы не загружены.';
  const sel = $('#qno'), cur = sel.value;
  sel.innerHTML = result.rows.map(r => `<option>${esc(r.number)}</option>`).join('');
  if (cur) sel.value = cur;
  renderTable();
  renderDocs();
  renderAnswer();
}

render();

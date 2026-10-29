// Разбор TXT-документов по договорам поставки на правилах, без LLM.
// Чистые функции: работают и в браузере, и в node --test.

const MONEY = String.raw`(?<![\d.,])(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?(?:\s*\([^)]*\))?\s*(?:рубл|руб\.|₽)`;
const DATE = String.raw`(\d{2})\.(\d{2})\.(\d{4})`;
const AMBIGUOUS = { ambiguous: true };

const isoOf = m => `${m[3]}-${m[2]}-${m[1]}`;
export const ruDate = iso => iso.split('-').reverse().join('.');
export const rub = n => n.toLocaleString('ru-RU') + ' ₽';

function money(text) {
  const all = [...new Set([...text.matchAll(new RegExp(MONEY, 'gi'))].map(m => +m[1].replace(/\D/g, '') + (+m[2] || 0) / 100))];
  if (all.length <= 1) return all[0] ?? null;
  const target = text.match(new RegExp(String.raw`(?<![а-яё])на\s+` + MONEY, 'i')); // «изменить с X на Y»
  return target ? +target[1].replace(/\D/g, '') : AMBIGUOUS;
}

function deliveryDate(text) {
  const all = [...new Set([...text.matchAll(new RegExp(DATE, 'g'))].map(isoOf))];
  if (all.length <= 1) return all[0] ?? null;
  const target = text.match(new RegExp(String.raw`(?:не позднее|(?<![а-яё])на)\s+` + DATE, 'i'));
  return target ? isoOf(target) : AMBIGUOUS;
}

// Поле = какие абзацы о нём говорят, какие абзацы похожи, но не про него, и как достать значение.
// ponytail: новое поле (например, неустойка) добавляется одной записью здесь.
export const FIELDS = {
  amount: {
    label: 'Сумма',
    match: /общ\S*\s+стоимост|стоимост\S*\s+(?:договора|поставки)/i,
    skip: /аванс|лимит|бюджет/i,
    pick: money,
    format: rub,
  },
  delivery: {
    label: 'Срок поставки',
    match: /поставить|срок\S*\s+поставки/i,
    skip: /оплат/i,
    pick: deliveryDate,
    format: ruDate,
  },
};

export function parseDoc(name, text) {
  const paras = text.replace(/^﻿/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .map((t, i) => ({ n: i + 1, text: t, label: t.match(/^(\d+(?:\.\d+)*)\./)?.[1] ?? null }));
  const title = paras[0]?.text ?? '';
  const statusPara = paras.find(p => /^Статус\s*:/i.test(p.text)) ?? null;
  const status = statusPara?.text ?? '';
  const draft = /^ПРОЕКТ/i.test(title) || /проект|не\s+подписан/i.test(status);
  const signed = !draft && /подписан\S*\s+обеими\s+сторонами/i.test(status);
  const signedOn = status.match(new RegExp(String.raw`подписан\S*[^\d]*?` + DATE, 'i'));
  const kind = /СОГЛАШЕНИ/i.test(title) ? 'amendment'
    : /^ДОГОВОР/i.test(title) ? 'contract'
    : /ПИСЬМО/i.test(title) ? 'letter'
    : 'unknown';
  const doc = { name, paras, title, kind, draft, signed, statusPara, signedOn: signedOn ? isoOf(signedOn) : null };

  if (kind === 'contract') doc.number = title.match(/№\s*([^\s,]+)/)?.[1] ?? null;
  const effPara = paras.find(p => /вступа\S*\s+в\s+силу/i.test(p.text) && (new RegExp(DATE).test(p.text) || /с\s+момента\s+подписания/i.test(p.text)));
  if (effPara) {
    const m = effPara.text.match(new RegExp(DATE));
    doc.effectivePara = effPara;
    doc.effectiveOn = m ? isoOf(m) : doc.signedOn;
  }
  return doc;
}

// Значение поля в одном документе: {value, para} | {value: null, para: основание} | {review, candidates}.
export function fromDoc(doc, key) {
  const f = FIELDS[key];
  const hits = doc.paras.filter(p => f.match.test(p.text));
  const used = hits.filter(p => !f.skip.test(p.text));
  const ignored = hits.filter(p => f.skip.test(p.text) && f.pick(p.text) !== null)
    .map(p => ({ doc, para: p, value: f.pick(p.text) }));
  const found = used.map(p => ({ doc, para: p, value: f.pick(p.text) })).filter(x => x.value !== null);
  const distinct = new Set(found.map(x => x.value));
  if (found.some(x => x.value === AMBIGUOUS) || distinct.size > 1)
    return { review: true, candidates: found, doc, ignored };
  if (found.length) return { ...found[0], ignored };
  return { value: null, doc, para: used[0] ?? null, ignored };
}

const mentions = (text, no) => new RegExp(String.raw`(?<![\w-])` + no.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`(?![\w-])`).test(text);

function linkContract(doc, numbers) {
  const inTitle = numbers.filter(no => mentions(doc.title, no));
  const hits = inTitle.length ? inTitle : numbers.filter(no => doc.paras.some(p => mentions(p.text, no)));
  if (hits.length > 1) doc.linkIssue = `Упоминает несколько договоров: ${hits.join(', ')}`;
  return hits.length === 1 ? hits[0] : null;
}

const KIND = { contract: 'Договор', amendment: 'Допсоглашение', letter: 'Письмо', unknown: 'Не распознан' };
export const kindLabel = d => d.kind === 'amendment' && !d.signed ? 'Проект допсоглашения' : KIND[d.kind];

function resolve(no, docs, checkDate) {
  const own = docs.filter(d => d.kind === 'contract' && d.number === no);
  const base = own[0];
  const issues = [];
  if (own.length > 1) issues.push(`Несколько файлов договора: ${own.map(d => d.name).join(', ')}. Использован ${base.name}`);
  if (!base.signed) issues.push(`Договор не отмечен как подписанный обеими сторонами (${base.name})`);

  const supplierPara = base.paras.find(p => /Поставщик\s*:/i.test(p.text));
  const supplier = supplierPara && { value: supplierPara.text.match(/Поставщик\s*:\s*(.+?)(?:\.\s|\.?$)/i)[1], doc: base, para: supplierPara };
  const fields = Object.fromEntries(Object.keys(FIELDS).map(k => [k, fromDoc(base, k)]));
  const proposals = [];
  const applied = [];

  const propose = (d, note) => {
    for (const key in FIELDS) {
      const r = fromDoc(d, key);
      if (r.value != null || r.review) proposals.push({ key, note, ...r });
    }
  };

  for (const d of docs.filter(d => d.contract === no)) {
    if (d.kind === 'letter') propose(d, 'Предложение в письме, не согласовано');
    else if (d.kind !== 'amendment') continue;
    else if (!d.signed) propose(d, 'Проект, не подписан');
    else if (!d.effectiveOn) {
      issues.push(`${d.name}: подписано, но дата вступления в силу не найдена. Изменения не применены`);
      propose(d, 'Подписано, дата вступления в силу не найдена');
    } else if (d.effectiveOn > checkDate || (d.signedOn && d.signedOn > checkDate)) {
      propose(d, `Подписано, вступает в силу ${ruDate(d.effectiveOn)}, на дату проверки не действует`);
    } else applied.push(d);
  }

  applied.sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn) || (a.signedOn ?? '').localeCompare(b.signedOn ?? ''));
  for (const d of applied) {
    for (const key in FIELDS) {
      const r = fromDoc(d, key);
      if (r.value == null && !r.review) continue;
      const prev = fields[key];
      if (prev.changedBy?.effectiveOn === d.effectiveOn && prev.value !== r.value)
        fields[key] = { review: true, candidates: [prev, r], doc: d };
      else fields[key] = { ...r, changedBy: d, previous: prev };
    }
  }
  return { number: no, doc: base, supplier, fields, proposals, issues };
}

export function analyze(files, checkDate) {
  const docs = files.map(f => parseDoc(f.name, f.text));
  docs.forEach((d, i) => { d.id = `doc${i}`; });
  const numbers = [...new Set(docs.filter(d => d.kind === 'contract' && d.number).map(d => d.number))];
  for (const d of docs) d.contract = d.kind === 'contract' ? d.number : linkContract(d, numbers);
  const rows = numbers.map(no => resolve(no, docs, checkDate));
  const unlinked = docs.filter(d => d.kind === 'unknown' || !d.contract);
  return { docs, rows, unlinked };
}

// Вопрос 4: договоры со сроком поставки раньше даты + несогласованные изменения срока по ним.
export function deliveryBefore(rows, iso) {
  return {
    early: rows.filter(r => typeof r.fields.delivery.value === 'string' && r.fields.delivery.value < iso)
      .map(r => ({ row: r, proposals: r.proposals.filter(p => p.key === 'delivery') })),
    unknown: rows.filter(r => typeof r.fields.delivery.value !== 'string'),
  };
}

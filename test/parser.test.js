import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { analyze, deliveryBefore } from '../parser.js';

const dir = new URL('../documents/', import.meta.url);
const sample = () => readdirSync(dir).map(name => ({ name, text: readFileSync(new URL(name, dir), 'utf8') }));
const CHECK = '2026-03-10';
const row = (res, no) => res.rows.find(r => r.number === no);

test('находит три договора и поставщиков', () => {
  const res = analyze(sample(), CHECK);
  assert.deepEqual(res.rows.map(r => [r.number, r.supplier.value]), [
    ['STN-101', 'ООО «Вектор Прибор»'],
    ['STN-102', 'ООО «Контур Электро»'],
    ['STN-103', 'ООО «ПромСнаб Сервис»'],
  ]);
  assert.deepEqual(res.unlinked, []);
});

test('Q1: STN-101 на 10.03.2026 — срок и сумма из подписанного ДС №1, проект ДС №2 только предложение', () => {
  const r = row(analyze(sample(), CHECK), 'STN-101');
  assert.equal(r.fields.delivery.value, '2026-04-30');
  assert.equal(r.fields.delivery.changedBy.name, '02_amendment_signed.txt');
  assert.equal(r.fields.delivery.previous.value, '2026-04-15');
  assert.equal(r.fields.delivery.para.text, '2. Пункт 3.1 договора изложить в следующей редакции: «Поставщик обязуется поставить оборудование не позднее 30.04.2026».');
  assert.equal(r.fields.amount.value, 1380000);
  assert.deepEqual(r.proposals.map(p => [p.key, p.value, p.doc.name]), [
    ['amount', 1450000, '06_amendment_draft.txt'],
    ['delivery', '2026-05-10', '06_amendment_draft.txt'],
  ]);
});

test('Q2: STN-102 — 840 000, аванс не считается суммой', () => {
  const a = row(analyze(sample(), CHECK), 'STN-102').fields.amount;
  assert.equal(a.value, 840000);
  assert.equal(a.para.label, '2.1');
  assert.deepEqual(a.ignored.map(x => x.value), [252000]);
});

test('Q3: STN-103 — нет данных, лимит бюджета не выдаётся за сумму', () => {
  const a = row(analyze(sample(), CHECK), 'STN-103').fields.amount;
  assert.equal(a.value, null);
  assert.equal(a.para.label, '2.1');
  assert.deepEqual(a.ignored.map(x => x.value), [600000]);
});

test('Q4: раньше 01.04.2026 только STN-102, есть несогласованный перенос на 27.03.2026', () => {
  const { early, unknown } = deliveryBefore(analyze(sample(), CHECK).rows, '2026-04-01');
  assert.deepEqual(early.map(e => [e.row.number, e.row.fields.delivery.value]), [['STN-102', '2026-03-20']]);
  assert.deepEqual(early[0].proposals.map(p => [p.value, p.doc.name]), [['2026-03-27', '05_supplier_email.txt']]);
  assert.deepEqual(unknown, []);
});

test('ДС, вступающее в силу после даты проверки, не применяется', () => {
  const r = row(analyze(sample(), '2026-02-20'), 'STN-101');
  assert.equal(r.fields.delivery.value, '2026-04-15');
  assert.equal(r.fields.amount.value, 1200000);
  assert.ok(r.proposals.some(p => p.doc.name === '02_amendment_signed.txt' && /не действует/.test(p.note)));
});

test('имена файлов не влияют на результат', () => {
  const renamed = sample().map((f, i) => ({ name: `doc_${9 - i}.txt`, text: f.text }));
  const r = row(analyze(renamed, CHECK), 'STN-101');
  assert.equal(r.fields.delivery.value, '2026-04-30');
  assert.equal(r.fields.delivery.changedBy.name, 'doc_8.txt');
});

test('новый договор того же формата с другими значениями', () => {
  const src = readFileSync(new URL('03_contract.txt', dir), 'utf8');
  const text = src.replaceAll('STN-102', 'STN-104')
    .replace('840 000 (восемьсот сорок тысяч) рублей', '915 500 рублей')
    .replace('20.03.2026', '25.03.2026');
  const r = row(analyze([...sample(), { name: 'new.txt', text }], CHECK), 'STN-104');
  assert.equal(r.fields.amount.value, 915500);
  assert.equal(r.fields.delivery.value, '2026-03-25');
  assert.deepEqual(r.proposals, []); // письмо относится к STN-102, не к новому договору
});

test('неподписанный договор и ДС без даты вступления в силу требуют проверки', () => {
  const files = sample().map(f => ({
    ...f,
    text: f.text.replace('Статус: подписан обеими сторонами 20.02.2026.', 'Статус: проект, не подписан.')
      .replace('4. Настоящее соглашение вступает в силу 01.03.2026.', ''),
  }));
  const res = analyze(files, CHECK);
  assert.match(row(res, 'STN-103').issues.join(), /не отмечен как подписанный/);
  const r101 = row(res, 'STN-101');
  assert.equal(r101.fields.delivery.value, '2026-04-15');
  assert.match(r101.issues.join(), /дата вступления в силу не найдена/);
});

test('«изменить с X на Y» берёт новое значение', () => {
  const files = [
    { name: 'a.txt', text: 'ДОГОВОР ПОСТАВКИ № X-1\nСтатус: подписан обеими сторонами 01.01.2026.\n2.1. Общая стоимость поставки 100 000 рублей.\n3.1. Поставщик обязуется поставить товар не позднее 01.06.2026.' },
    { name: 'b.txt', text: 'ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ № 1 К ДОГОВОРУ X-1\nСтатус: подписано обеими сторонами 01.02.2026.\n1. Изменить общую стоимость поставки с 100 000 рублей на 120 000 рублей.\n2. Перенести срок поставки с 01.06.2026 на 15.06.2026.\n3. Соглашение вступает в силу с момента подписания.' },
  ];
  const r = row(analyze(files, CHECK), 'X-1');
  assert.equal(r.fields.amount.value, 120000);
  assert.equal(r.fields.delivery.value, '2026-06-15');
});

test('два значения суммы в одном абзаце без указания нового — нужна проверка', () => {
  const text = 'ДОГОВОР ПОСТАВКИ № X-1\nСтатус: подписан обеими сторонами 01.01.2026.\n2.1. Общая стоимость поставки 100 000 рублей или 120 000 рублей.';
  assert.equal(row(analyze([{ name: 'x.txt', text }], CHECK), 'X-1').fields.amount.review, true);
});

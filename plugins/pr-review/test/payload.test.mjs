import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload } from '../lib/payload.mjs';

const commentable = new Map([
  ['src/A.java', { RIGHT: [[10, 20]], LEFT: [[5, 6]] }],
  ['src/B.java', { RIGHT: [[1, 2]], LEFT: [] }],
]);

const c = (over) => ({
  file: 'src/A.java', side: 'RIGHT', line: 12, start_line: null,
  severity: 'major', baseSeverity: 'major', escalated: false, tension: false,
  analysts: ['gi'], id: 'aaaaaa',
  items: [{ analyst: 'gi', analystTitle: 'Gate', title: 't', problem: 'p', evidence: 'e', fix: 'f', confidence: 'hoch' }],
  ...over,
});

const renderBody = () => 'BILANZ';

test('event ist immer COMMENT und nicht ueberschreibbar', () => {
  const out = buildPayload([c()], { commentable, renderBody });
  assert.equal(out.event, 'COMMENT');
  assert.equal(out.body, 'BILANZ');
});

test('gueltige Zeile wird zu einem Inline-Kommentar mit path, line, side', () => {
  const out = buildPayload([c()], { commentable, renderBody });
  assert.equal(out.comments.length, 1);
  assert.equal(out.comments[0].path, 'src/A.java');
  assert.equal(out.comments[0].line, 12);
  assert.equal(out.comments[0].side, 'RIGHT');
  assert.ok(out.comments[0].body.includes('Gate'));
  assert.equal('position' in out.comments[0], false);
});

test('Zeile ausserhalb des Diffs wird ankerlos, nicht gepostet', () => {
  const out = buildPayload([c({ line: 99, id: 'bbbbbb' })], { commentable, renderBody });
  assert.equal(out.comments.length, 0);
  assert.equal(out.report.anchorless.length, 1);
  assert.equal(out.report.anchorless[0].id, 'bbbbbb');
});

test('unbekannte Datei wird ankerlos', () => {
  const out = buildPayload([c({ file: 'src/Weg.java', id: 'cccccc' })], { commentable, renderBody });
  assert.equal(out.report.anchorless.length, 1);
});

test('gueltiges start_line ergibt einen Bereichskommentar mit start_side', () => {
  const out = buildPayload([c({ start_line: 10, line: 12 })], { commentable, renderBody });
  assert.equal(out.comments[0].start_line, 10);
  assert.equal(out.comments[0].start_side, 'RIGHT');
});

test('ungueltiges start_line faellt auf einen einzeiligen Kommentar zurueck', () => {
  const out = buildPayload([c({ start_line: 3, line: 12 })], { commentable, renderBody });
  assert.equal(out.comments.length, 1);
  assert.equal('start_line' in out.comments[0], false);
});

test('bereits gepostete IDs werden uebersprungen', () => {
  const out = buildPayload([c({ id: 'aaaaaa' }), c({ id: 'dddddd', line: 13 })], {
    commentable, previousIds: new Set(['aaaaaa']), renderBody,
  });
  assert.equal(out.comments.length, 1);
  assert.equal(out.report.skippedExisting.length, 1);
  assert.equal(out.report.skippedExisting[0].id, 'aaaaaa');
});

test('Deckel greift und der Rest wird als gekappt gemeldet', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    c({ id: String(i).padStart(6, '0'), line: 10 + (i % 11), severity: i < 5 ? 'blocker' : 'minor' }));
  const out = buildPayload(many, { commentable, cap: 25, renderBody });
  assert.equal(out.comments.length, 25);
  assert.equal(out.report.capped.length, 5);
  assert.equal(out.report.posted[0].severity, 'blocker');
  assert.ok(out.report.capped.every((x) => x.severity === 'minor'));
});

test('renderBody bekommt den Report, damit die Bilanz die Zahlen kennt', () => {
  let seen = null;
  buildPayload([c({ line: 99 })], { commentable, renderBody: (r) => { seen = r; return 'x'; } });
  assert.equal(seen.anchorless.length, 1);
  assert.equal(seen.posted.length, 0);
});

test('LEFT-Seite wird gegen die LEFT-Map geprueft', () => {
  const ok = buildPayload([c({ side: 'LEFT', line: 5 })], { commentable, renderBody });
  assert.equal(ok.comments.length, 1);
  const bad = buildPayload([c({ side: 'LEFT', line: 12 })], { commentable, renderBody });
  assert.equal(bad.report.anchorless.length, 1);
});

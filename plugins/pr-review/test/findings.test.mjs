import test from 'node:test';
import assert from 'node:assert/strict';
import { severityRank, clampSeverity, raiseSeverity, validateFinding, validateAll } from '../lib/findings.mjs';

const ctx = () => ({
  analysts: new Map([
    ['sec', { name: 'sec', title: 'Sicherheit', severity_max: 'blocker' }],
    ['cx', { name: 'cx', title: 'Komplexität', severity_max: 'minor' }],
  ]),
  haystacks: new Map([['src/A.java', 'line1\n  @Disabled("flaky")\nline3\n']]),
  knownFiles: new Set(['src/A.java']),
});

const good = (over = {}) => ({
  file: 'src/A.java', line: 2, side: 'RIGHT', severity: 'major',
  title: 'Test stillgelegt', problem: 'Warum das schlimm ist.',
  evidence: '@Disabled("flaky")', fix: 'Annotation entfernen.', confidence: 'high',
  ...over,
});

test('severityRank ordnet die Leiter', () => {
  assert.ok(severityRank('info') < severityRank('minor'));
  assert.ok(severityRank('major') < severityRank('blocker'));
});

test('clampSeverity und raiseSeverity respektieren die Grenzen', () => {
  assert.equal(clampSeverity('blocker', 'minor'), 'minor');
  assert.equal(clampSeverity('info', 'blocker'), 'info');
  assert.equal(raiseSeverity('major'), 'blocker');
  assert.equal(raiseSeverity('blocker'), 'blocker');
  assert.equal(raiseSeverity('info'), 'info');
});

test('gueltiger Befund wird angenommen', () => {
  const r = validateFinding({ ...good(), analyst: 'sec' }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.finding.severity, 'major');
  assert.equal(r.finding.baseSeverity, 'major');
  assert.equal(r.finding.start_line, null);
});

test('severity_max des Analysten deckelt, verwirft aber nicht', () => {
  const r = validateFinding({ ...good(), analyst: 'cx' }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.finding.severity, 'minor');
  assert.equal(r.finding.baseSeverity, 'minor');
});

test('Evidenz nicht im Bundle auffindbar wird verworfen', () => {
  const r = validateFinding({ ...good({ evidence: 'gibt-es-nicht' }), analyst: 'sec' }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'evidence not found in the bundle');
});

test('mehrzeilige oder zu lange Evidenz wird verworfen', () => {
  assert.equal(validateFinding({ ...good({ evidence: 'a\nb' }), analyst: 'sec' }, ctx()).reason, 'evidence must be a single line');
  assert.equal(validateFinding({ ...good({ evidence: 'x'.repeat(201) }), analyst: 'sec' }, ctx()).reason, 'evidence longer than 200 characters');
});

test('niedriges Vertrauen bei minor wird verworfen, bei blocker behalten', () => {
  const low = validateFinding({ ...good({ severity: 'minor', confidence: 'low' }), analyst: 'sec' }, ctx());
  assert.equal(low.ok, false);
  assert.equal(low.reason, 'low confidence on low severity');
  const kept = validateFinding({ ...good({ severity: 'blocker', confidence: 'low' }), analyst: 'sec' }, ctx());
  assert.equal(kept.ok, true);
  assert.equal(kept.finding.confidence, 'low');
});

test('die Vertrauensregel prueft die gemeldete Severity, nicht die gedeckelte', () => {
  // "cx" hat severity_max: minor -- eine legitime repo-lokale Entscheidung. Wurde die
  // Regel an der GEDECKELTEN Severity geprueft, war "niedrig" fuer diesen Analysten auf
  // jeder Stufe unbenutzbar: alles landet auf minor, also fiel alles durch. Ein
  // schwerwiegender Verdacht ist auch unsicher mitteilungswuerdig; der Deckel begrenzt
  // die Lautstaerke, er entscheidet nicht ueber die Existenz.
  const r = validateFinding({ ...good({ severity: 'major', confidence: 'low' }), analyst: 'cx' }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.finding.severity, 'minor'); // Deckel greift weiterhin
  assert.equal(r.finding.confidence, 'low');
  // Als minor gemeldet bleibt es verworfen, auch bei diesem Analysten.
  const low = validateFinding({ ...good({ severity: 'minor', confidence: 'low' }), analyst: 'cx' }, ctx());
  assert.equal(low.ok, false);
  assert.equal(low.reason, 'low confidence on low severity');
});

test('fehlende Pflichtfelder und unbekannte Datei werden verworfen', () => {
  assert.match(validateFinding({ ...good({ fix: '' }), analyst: 'sec' }, ctx()).reason, /fix/);
  assert.match(validateFinding({ ...good({ file: 'src/Weg.java' }), analyst: 'sec' }, ctx()).reason, /not in the diff/);
  assert.match(validateFinding({ ...good({ line: 0 }), analyst: 'sec' }, ctx()).reason, /line/);
});

test('Evidenz darf nicht ueber eine Zeilengrenze hinweg matchen', () => {
  const c = ctx();
  c.haystacks.set('src/A.java', 'int x = 1;\nint y = 2;\n');
  const r = validateFinding({ ...good({ evidence: 'int x = 1; int y = 2;' }), analyst: 'sec' }, c);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'evidence not found in the bundle');
});

test('validateAll faellt bei fehlendem Titel auf einen Platzhalter zurueck', () => {
  const raw = new Map([['sec', [{ ...good({ evidence: 'nope' }), title: undefined }]]]);
  const { accepted, rejected } = validateAll(raw, ctx());
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].title, '(untitled)');
});

test('validateAll trennt Angenommene von Verworfenen', () => {
  const raw = new Map([
    ['sec', [good(), good({ evidence: 'nope', title: 'Weg' })]],
    ['cx', [good({ title: 'Zu komplex' })]],
  ]);
  const { accepted, rejected } = validateAll(raw, ctx());
  assert.equal(accepted.length, 2);
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0], { analyst: 'sec', title: 'Weg', reason: 'evidence not found in the bundle' });
});

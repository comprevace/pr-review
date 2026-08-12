import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchThreads, resolveThread, computeDelta } from '../lib/threads.mjs';
import { renderMarker, evidenceHash } from '../lib/comment.mjs';

function pageFactory(pages) {
  let i = 0;
  return async () => {
    const page = pages[i++];
    return { repository: { pullRequest: { reviewThreads: page } } };
  };
}

test('fetchThreads paginiert und liest den Marker des ersten Kommentars', async () => {
  const gql = pageFactory([
    {
      pageInfo: { hasNextPage: true, endCursor: 'c1' },
      nodes: [{ id: 'T1', isResolved: false, comments: { nodes: [{ body: `x\n${renderMarker({ id: 'aaaaaa', sev: 'major', analysts: ['gi'] })}` }] } }],
    },
    {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        { id: 'T2', isResolved: true, comments: { nodes: [{ body: renderMarker({ id: 'bbbbbb', sev: 'minor', analysts: ['sf'] }) }] } },
        { id: 'T3', isResolved: false, comments: { nodes: [{ body: 'ein menschlicher Kommentar' }] } },
      ],
    },
  ]);
  const threads = await fetchThreads({ repo: 'example/demo', number: 1, ghGraphql: gql });
  assert.equal(threads.length, 3);
  assert.equal(threads[0].marker.id, 'aaaaaa');
  assert.equal(threads[1].isResolved, true);
  assert.equal(threads[2].marker, null);
});

test('resolveThread schickt die Mutation mit der Thread-ID', async () => {
  const seen = [];
  await resolveThread({ threadId: 'T1', ghGraphql: async (q, v) => { seen.push({ q, v }); return { resolveReviewThread: { thread: { id: 'T1', isResolved: true } } }; } });
  assert.match(seen[0].q, /resolveReviewThread/);
  assert.equal(seen[0].v.threadId, 'T1');
});

const cluster = (id, evidence) => ({
  id, file: 'src/A.java', side: 'RIGHT', line: 10, start_line: null,
  severity: 'major', baseSeverity: 'major', escalated: false, tension: false,
  analysts: ['gi'],
  items: [{ analyst: 'gi', analystTitle: 'Gate', title: 't', problem: 'p', evidence, fix: 'f', confidence: 'hoch' }],
});
// evidence steht im Thread, weil der Zweitlauf das Zitat als TEXT braucht: die Frage
// ist "steht das noch woertlich in der Datei", und ein Hash laesst sich nicht auf
// Teilstring pruefen. fetchThreads liest es mit parseEvidence aus dem Kommentar.
const thread = (id, markerId, evidence, isResolved = false) => ({
  id, isResolved,
  marker: { id: markerId, sev: 'major', ev: evidence === null ? null : evidenceHash(evidence), analysts: ['gi'] },
  evidence,
});

test('erneut gemeldeter Befund bleibt offen und wird nicht doppelt gepostet', () => {
  const delta = computeDelta({
    clusters: [cluster('aaaaaa', 'still-da')],
    threads: [thread('T1', 'aaaaaa', 'still-da')],
    haystacks: new Map([['src/A.java', 'still-da\n']]),
  });
  assert.deepEqual(delta.fresh, []);
  assert.deepEqual(delta.stillOpen, ['aaaaaa']);
  assert.deepEqual(delta.resolvable, []);
});

test('Evidenz weg UND nicht erneut gemeldet gilt als behoben', () => {
  const delta = computeDelta({
    clusters: [],
    threads: [thread('T1', 'aaaaaa', 'war-mal-da')],
    haystacks: new Map([['src/A.java', 'alles neu\n']]),
  });
  assert.deepEqual(delta.resolvable, ['T1']);
  assert.equal(delta.counts.resolved, 1);
});

test('Evidenz noch da, aber nicht gemeldet: bleibt offen — Bedingung (2) fehlt', () => {
  const delta = computeDelta({
    clusters: [],
    threads: [thread('T1', 'aaaaaa', 'still-da')],
    haystacks: new Map([['src/A.java', 'still-da\n']]),
  });
  assert.deepEqual(delta.resolvable, []);
  assert.deepEqual(delta.stillOpen, ['aaaaaa']);
});

test('erneut gemeldet schlaegt "Evidenz weg" — Umformulieren behebt nichts', () => {
  const delta = computeDelta({
    clusters: [cluster('aaaaaa', 'neue-formulierung')],
    threads: [thread('T1', 'aaaaaa', 'alte-formulierung')],
    haystacks: new Map([['src/A.java', 'neue-formulierung\n']]),
  });
  assert.deepEqual(delta.resolvable, []);
  assert.deepEqual(delta.stillOpen, ['aaaaaa']);
});

test('Marker ohne ev-Feld bleibt offen statt still aufgeloest zu werden', () => {
  const delta = computeDelta({
    clusters: [],
    threads: [thread('T1', 'aaaaaa', null)],
    haystacks: new Map([['src/A.java', 'irgendwas\n']]),
  });
  assert.deepEqual(delta.resolvable, []);
  assert.deepEqual(delta.stillOpen, ['aaaaaa']);
});

test('Evidenz als Fragment einer unveraenderten Zeile gilt als vorhanden', () => {
  // Der wichtigste Fall dieser Datei: ein Analyst zitiert das schuldige Fragment,
  // nicht die ganze Zeile. Verglich die Pruefung ganze Zeilen, waere das Zitat immer
  // "verschwunden", Bedingung (2) unbedingt erfuellt und die Zwei-Bedingungen-Regel
  // faktisch eine Ein-Bedingungs-Regel -- ein ausgefallener Analyst wuerde dann
  // reichen, um einen echten Befund als behoben zu schliessen.
  const zeile = '    if (user.isAdmin) { grantAll(); }';
  const delta = computeDelta({
    clusters: [],
    threads: [thread('T1', 'aaaaaa', 'grantAll();')],
    haystacks: new Map([['a.java', zeile]]),
  });
  assert.deepEqual(delta.resolvable, []);
  assert.deepEqual(delta.stillOpen, ['aaaaaa']);
});

test('ein Kommentar ohne lesbares Zitat bleibt offen', () => {
  const t1 = { ...thread('T1', 'aaaaaa', 'weg'), evidence: null };
  const delta = computeDelta({ clusters: [], threads: [t1], haystacks: new Map([['a.java', 'irgendwas']]) });
  assert.deepEqual(delta.resolvable, []);
  assert.deepEqual(delta.stillOpen, ['aaaaaa']);
});

test('ein untergeschobenes Zitat wird am Marker-Hash erkannt', () => {
  // parseEvidence liest das erste Blockquote. Steht darueber etwas, das wie ein Zitat
  // aussieht, wuerde ohne Beglaubigung auf dem falschen Text entschieden -- und ein
  // Befund, der noch im Code steht, als behoben geschlossen.
  const t1 = { ...thread('T1', 'aaaaaa', 'echtes-zitat'), evidence: 'fremdes-zitat' };
  const delta = computeDelta({ clusters: [], threads: [t1], haystacks: new Map([['a.java', 'nichts davon']]) });
  assert.deepEqual(delta.resolvable, []);
  assert.deepEqual(delta.stillOpen, ['aaaaaa']);
});

test('neuer Befund ohne bestehenden Thread ist fresh', () => {
  const delta = computeDelta({
    clusters: [cluster('cccccc', 'neu')],
    threads: [],
    haystacks: new Map([['src/A.java', 'neu\n']]),
  });
  assert.equal(delta.fresh.length, 1);
  assert.equal(delta.counts.fresh, 1);
});

test('bereits aufgeloeste Threads werden nicht wieder angefasst', () => {
  const delta = computeDelta({
    clusters: [],
    threads: [thread('T2', 'bbbbbb', 'weg', true)],
    haystacks: new Map(),
  });
  assert.deepEqual(delta.resolvable, []);
  assert.equal(delta.counts.resolved, 0);
});

test('fremde Threads ohne Marker werden nie angefasst', () => {
  const delta = computeDelta({
    clusters: [],
    threads: [{ id: 'T3', isResolved: false, marker: null }],
    haystacks: new Map(),
  });
  assert.deepEqual(delta.resolvable, []);
});

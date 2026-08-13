import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundlePathFor, testCandidates, resolveSpecPath, buildBundle, loadBundle } from '../lib/bundle.mjs';

test('bundlePathFor liegt ausserhalb von ~/.claude und trennt Owner und Repo', () => {
  const p = bundlePathFor('example/demo', 55);
  // ~/.claude ist ein geschuetzter Pfad: dort koennten die Analysten ihre Befunde
  // nicht ablegen. Diese Zusicherung haelt die Wurzel dauerhaft draussen.
  assert.ok(p.endsWith('/.cache/pr-review/example__demo__55'), p);
  assert.doesNotMatch(p, /\.claude/);
});

test('testCandidates deckt Java- und Frontend-Muster ab', () => {
  assert.deepEqual(testCandidates('src/main/java/a/Foo.java'), [
    'src/test/java/a/FooTest.java',
    'src/test/java/a/FooTests.java',
    'src/test/java/a/FooIT.java',
  ]);
  assert.deepEqual(testCandidates('src/components/Foo.vue'), [
    'src/components/Foo.spec.ts',
    'src/components/Foo.test.ts',
    'src/components/__tests__/Foo.spec.ts',
    'src/components/__tests__/Foo.test.ts',
  ]);
  assert.deepEqual(testCandidates('src/util/Foo.ts'), [
    'src/util/Foo.spec.ts',
    'src/util/Foo.test.ts',
    'src/util/__tests__/Foo.spec.ts',
    'src/util/__tests__/Foo.test.ts',
  ]);
});

test('testCandidates erkennt Testdateien selbst und schlaegt nichts vor', () => {
  assert.deepEqual(testCandidates('src/test/java/a/FooTest.java'), []);
  assert.deepEqual(testCandidates('src/components/Foo.spec.ts'), []);
});

test('resolveSpecPath bevorzugt Body-Link, dann Titel, dann Branch', () => {
  assert.equal(resolveSpecPath({ body: 'siehe specs/DEMO-123.md hier', title: 'x', headRef: 'y' }), 'specs/DEMO-123.md');
  assert.equal(resolveSpecPath({ body: 'ohne', title: 'DEMO-77: Session', headRef: 'y' }), 'specs/DEMO-77.md');
  assert.equal(resolveSpecPath({ body: 'ohne', title: 'ohne', headRef: 'feature/DEMO-9-session' }), 'specs/DEMO-9.md');
  assert.equal(resolveSpecPath({ body: 'ohne', title: 'ohne', headRef: 'chore/cleanup' }), null);
});

test('buildBundle schreibt meta, Dateien und commentable-Map', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-')), 'bundle');
  const calls = [];
  const fakeApi = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === '/repos/example/demo/pulls/1') {
      return {
        number: 1, title: 'DEMO-5: x', body: 'siehe specs/DEMO-5.md',
        user: { login: 'alice' }, labels: [{ name: 'agent' }],
        base: { sha: 'base1' }, head: { sha: 'head1', ref: 'feature/DEMO-5-x' },
      };
    }
    if (endpoint === '/repos/example/demo/pulls/1/files') {
      return [
        { filename: 'src/A.java', status: 'modified', additions: 2, deletions: 1,
          patch: '@@ -1,2 +1,3 @@\n ctx\n-alt\n+neu\n+mehr' },
        { filename: 'img/logo.png', status: 'added', additions: 0, deletions: 0 },
      ];
    }
    if (endpoint === '/repos/example/demo/pulls/1/comments') return [];
    if (endpoint.startsWith('/repos/example/demo/contents/src/A.java')) {
      return { content: Buffer.from('ctx\nneu\nmehr\n').toString('base64'), encoding: 'base64' };
    }
    const err = new Error('Not Found');
    err.status = 404;
    throw err;
  };

  const summary = await buildBundle({ repo: 'example/demo', number: 1, ghApi: fakeApi, bundleDir: dir });

  assert.equal(summary.files, 2);
  assert.equal(summary.changedLines, 3);
  assert.equal(summary.specLink, 'specs/DEMO-5.md');
  assert.deepEqual(summary.patchMissing, ['img/logo.png']);
  assert.deepEqual(summary.missingTests, ['src/A.java']);

  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.head_sha, 'head1');
  assert.deepEqual(meta.files[0].commentable.RIGHT, [[1, 3]]);
  assert.equal(meta.files[1].patch_missing, true);
  assert.ok(existsSync(join(dir, 'files/src/A.java')));
  assert.ok(existsSync(join(dir, 'diff.patch')));
});

function bundle2Api() {
  return async (endpoint) => {
    if (endpoint === '/repos/example/demo/pulls/2') {
      return { number: 2, title: 't', body: '', user: { login: 'a' }, labels: [],
        base: { sha: 'b' }, head: { sha: 'h', ref: 'x' } };
    }
    if (endpoint === '/repos/example/demo/pulls/2/files') {
      return [{ filename: 'a.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n keep\n+add' }];
    }
    if (endpoint === '/repos/example/demo/pulls/2/comments') return [];
    if (endpoint.startsWith('/repos/example/demo/contents/a.txt')) {
      return { content: Buffer.from('keep\nadd\n').toString('base64'), encoding: 'base64' };
    }
    const err = new Error('Not Found'); err.status = 404; throw err;
  };
}

test('loadBundle liest das geschriebene Bundle zurueck', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 2, ghApi: bundle2Api(), bundleDir: dir });

  const b = loadBundle(dir);
  assert.equal(b.meta.number, 2);
  assert.equal(b.fileText.get('a.txt'), 'keep\nadd\n');
  assert.ok(b.patchText.get('a.txt').includes('+add'));
  assert.deepEqual(b.previous, []);
});

test('ein zweites fetch leert findings/ und laesst keine Datei des Vorlaufs stehen', async () => {
  // Der Zweitlauf holt in DASSELBE Verzeichnis. Blieb die JSON-Datei des ersten Laufs
  // liegen, erschien ein diesmal abgestuerzter Analyst mit ihr als "gelaufen", und seine
  // veralteten Befunde erfuellten Bedingung (1): der Thread blieb offen, obwohl der
  // Befund behoben war -- der Ausfall waere unsichtbar UND wirksam gewesen.
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-refetch-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 2, ghApi: bundle2Api(), bundleDir: dir });
  writeFileSync(join(dir, 'findings/gate-integrity.json'), '[{"stale": true}]');

  await buildBundle({ repo: 'example/demo', number: 2, ghApi: bundle2Api(), bundleDir: dir });
  assert.ok(existsSync(join(dir, 'findings')), 'findings/ muss danach existieren');
  assert.deepEqual(readdirSync(join(dir, 'findings')), []);
});

// Runde 2 desselben PR: a.txt ist inzwischen geloescht. Fuer eine geloeschte Datei holt
// buildBundle bewusst keinen Volltext -- am head_sha existiert sie nicht mehr.
function removedApi() {
  return async (endpoint) => {
    if (endpoint === '/repos/example/demo/pulls/2') {
      return { number: 2, title: 't', body: '', user: { login: 'a' }, labels: [],
        base: { sha: 'b' }, head: { sha: 'h2', ref: 'x' } };
    }
    if (endpoint === '/repos/example/demo/pulls/2/files') {
      return [{ filename: 'a.txt', status: 'removed', additions: 0, deletions: 2, patch: '@@ -1,2 +0,0 @@\n-keep\n-add' }];
    }
    if (endpoint === '/repos/example/demo/pulls/2/comments') return [];
    const err = new Error('Not Found'); err.status = 404; throw err;
  };
}

test('ein zweites fetch laesst keinen veralteten Dateistand in files/ stehen', async () => {
  // Der Kern von Bedingung (2): "steht das Zitat noch im Bundle". Ueberlebt der
  // Dateistand aus Runde 1, bleibt jedes Zitat auffindbar -- ein wirklich behobener
  // Befund loest dann NIE auf, und der Zweitlauf verliert genau die Eigenschaft, fuer
  // die er gebaut wurde. Die Datei steht weiterhin in meta.files, ihr veralteter Text
  // landet also im Haystack, statt nur nutzlos auf der Platte zu liegen.
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-stale-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 2, ghApi: bundle2Api(), bundleDir: dir });
  assert.ok(existsSync(join(dir, 'files/a.txt')), 'Vorbedingung: Runde 1 legt die Datei an');

  await buildBundle({ repo: 'example/demo', number: 2, ghApi: removedApi(), bundleDir: dir });

  assert.equal(existsSync(join(dir, 'files/a.txt')), false, 'geloeschte Datei darf nicht als Volltext ueberleben');
  assert.equal(loadBundle(dir).fileText.get('a.txt'), undefined);
});

// Runde 2: a.txt ist noch im PR, kommt aber ohne patch (binaer oder zu gross).
function patchlessApi() {
  return async (endpoint) => {
    if (endpoint === '/repos/example/demo/pulls/2') {
      return { number: 2, title: 't', body: '', user: { login: 'a' }, labels: [],
        base: { sha: 'b' }, head: { sha: 'h2', ref: 'x' } };
    }
    if (endpoint === '/repos/example/demo/pulls/2/files') {
      return [{ filename: 'a.txt', status: 'modified', additions: 1, deletions: 0 }];
    }
    if (endpoint === '/repos/example/demo/pulls/2/comments') return [];
    const err = new Error('Not Found'); err.status = 404; throw err;
  };
}

test('ein zweites fetch laesst keinen veralteten Patch in patches/ stehen', async () => {
  // Der Haystack ist Dateistand PLUS Patch. Ein ueberlebender Patch aus Runde 1 haelt
  // die entfernten Zeilen am Leben und damit jedes LEFT-Zitat auffindbar -- dieselbe
  // Wirkung wie ein veralteter Dateistand, nur auf der anderen Seite des Diffs.
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-stalepatch-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 2, ghApi: bundle2Api(), bundleDir: dir });
  assert.ok(existsSync(join(dir, 'patches/a.txt.patch')), 'Vorbedingung: Runde 1 legt den Patch an');

  await buildBundle({ repo: 'example/demo', number: 2, ghApi: patchlessApi(), bundleDir: dir });

  assert.equal(existsSync(join(dir, 'patches/a.txt.patch')), false);
  assert.equal(loadBundle(dir).patchText.get('a.txt'), undefined);
});

// Runde 1 findet zu src/a.ts den Test src/a.spec.ts, Runde 2 nicht mehr (geloescht).
function tsApi(withTest) {
  return async (endpoint) => {
    if (endpoint === '/repos/example/demo/pulls/3') {
      return { number: 3, title: 't', body: '', user: { login: 'a' }, labels: [],
        base: { sha: 'b' }, head: { sha: 'h', ref: 'x' } };
    }
    if (endpoint === '/repos/example/demo/pulls/3/files') {
      return [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n keep\n+add' }];
    }
    if (endpoint === '/repos/example/demo/pulls/3/comments') return [];
    if (endpoint.startsWith('/repos/example/demo/contents/src/a.ts')) {
      return { content: Buffer.from('keep\nadd\n').toString('base64'), encoding: 'base64' };
    }
    if (withTest && endpoint.startsWith('/repos/example/demo/contents/src/a.spec.ts')) {
      return { content: Buffer.from('it("x", () => expect(1).toBe(1));\n').toString('base64'), encoding: 'base64' };
    }
    const err = new Error('Not Found'); err.status = 404; throw err;
  };
}

test('ein zweites fetch laesst keine veraltete Testdatei in tests/ stehen', async () => {
  // tests/ steht nicht im Haystack, kann also kein falsches "noch vorhanden" erzeugen --
  // aber die Analysten lesen das Verzeichnis. Eine Testdatei, die im PR inzwischen
  // geloescht wurde, laesst einen Analysten ueber eine Absicherung urteilen, die es nicht
  // mehr gibt. Zugleich meldete meta.json die Datei korrekt als testlos: das Bundle
  // widerspraeche sich selbst.
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-staletest-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 3, ghApi: tsApi(true), bundleDir: dir });
  assert.ok(existsSync(join(dir, 'tests/src/a.spec.ts')), 'Vorbedingung: Runde 1 legt den Test an');

  const summary = await buildBundle({ repo: 'example/demo', number: 3, ghApi: tsApi(false), bundleDir: dir });

  assert.deepEqual(summary.missingTests, ['src/a.ts']);
  assert.equal(existsSync(join(dir, 'tests/src/a.spec.ts')), false);
});

test('ein abgebrochenes fetch laesst das alte Bundle unangetastet', async () => {
  // Die Gegenprobe zu den beiden Tests darueber: wer veraltete Staende beseitigt, darf
  // sie nicht schon beseitigt haben, wenn das Holen danach scheitert. Ein halb
  // ausgeraeumtes Bundle waere schlimmer als ein veraltetes -- es sieht vollstaendig
  // aus und ist es nicht.
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-abort-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 2, ghApi: bundle2Api(), bundleDir: dir });

  const brokenApi = async (endpoint) => {
    if (endpoint === '/repos/example/demo/pulls/2') {
      return { number: 2, title: 't', body: '', user: { login: 'a' }, labels: [],
        base: { sha: 'b' }, head: { sha: 'h2', ref: 'x' } };
    }
    if (endpoint === '/repos/example/demo/pulls/2/files') {
      return [{ filename: 'a.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n keep\n+neu' }];
    }
    const err = new Error('Server Error'); err.status = 500; throw err;
  };

  await assert.rejects(() => buildBundle({ repo: 'example/demo', number: 2, ghApi: brokenApi, bundleDir: dir }));

  const b = loadBundle(dir);
  assert.equal(b.fileText.get('a.txt'), 'keep\nadd\n');
  assert.ok(b.patchText.get('a.txt').includes('+add'));
});

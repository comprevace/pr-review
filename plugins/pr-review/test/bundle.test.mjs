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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundlePathFor, testCandidates, resolveSpecPath, buildBundle, loadBundle, isGenerated, parseGitHubRepo, fetchTextAcrossSubmodules } from '../lib/bundle.mjs';
import { validateAll } from '../lib/findings.mjs';

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

test('ein expliziter Body-Link darf auf jede .md-Datei zeigen, auch ausserhalb von specs/', () => {
  // Gemessen an echten Repos: Spezifikationen liegen nicht zwingend unter specs/<ID>.md
  // im PR-Repo -- sie koennen ueber ein Submodule referenziert sein, und ihr Pfad folgt
  // dann der Struktur des Dokumentations-Repos. Der explizite Link ist die einzige Form, die ohne
  // Raten auskommt; er verlangt einen repo-relativen Pfad MIT Verzeichnisanteil.
  assert.equal(
    resolveSpecPath({ body: 'Abnahme: docs-sub/specs/DEMO-7.md', title: 'x', headRef: 'y' }),
    'docs-sub/specs/DEMO-7.md',
  );
  // Markdown-Linkform.
  assert.equal(
    resolveSpecPath({ body: 'siehe [Spec](docs-sub/specs/DEMO-7.md).', title: 'x', headRef: 'y' }),
    'docs-sub/specs/DEMO-7.md',
  );
  // Der explizite Pfad schlaegt die Ticket-ID im Titel.
  assert.equal(
    resolveSpecPath({ body: 'docs-sub/a/b.md', title: 'DEMO-77: Session', headRef: 'y' }),
    'docs-sub/a/b.md',
  );
  // Eine URL ist KEIN repo-relativer Pfad: aus einem GitHub-Link soll nicht
  // stillschweigend ein Pfad geraten werden -- dann greift die naechste Stufe.
  assert.equal(
    resolveSpecPath({ body: 'https://github.com/x/y/blob/main/docs/a.md', title: 'DEMO-77: Session', headRef: 'y' }),
    'specs/DEMO-77.md',
  );
  // Ein blosser Dateiname ohne Verzeichnisanteil ist eine Erwaehnung, kein Link.
  assert.equal(
    resolveSpecPath({ body: 'siehe README.md', title: 'ohne', headRef: 'chore/x' }),
    null,
  );
});

test('die ID-Heuristiken kennen Buchstaben-Suffixe und kleingeschriebene Branches', () => {
  // Betreiber-Messung 14.08., gemessen an einem echten PR: die ID US-01a
  // scheiterte in allen drei Zweigen aus drei verschiedenen Gruenden -- der direct-Zweig
  // verlangte .md direkt nach den Ziffern, der Titel-Zweig ein \b zwischen Ziffer und
  // Suffix (dort ist keins), der Branch-Zweig einen Grossbuchstaben am Anfang. Eine ID
  // mit Buchstabensuffix kam damit NIRGENDS an, egal wann die Spec-Datei entstand.
  assert.equal(resolveSpecPath({ body: 'ohne', title: 'Auth-Schicht (US-01a)', headRef: 'y' }), 'specs/US-01a.md');
  assert.equal(resolveSpecPath({ body: 'ohne', title: 'ohne', headRef: 'feat/us-01a-login-ui' }), 'specs/US-01a.md');
  // Bestand: IDs ohne Suffix unveraendert, Titel gewinnt vor Branch.
  assert.equal(resolveSpecPath({ body: 'ohne', title: 'Seed je Rolle (TE-08, TE-05)', headRef: 'y' }), 'specs/TE-08.md');
});

test('parseGitHubRepo liest owner/name aus den ueblichen Submodule-URLs', () => {
  assert.equal(parseGitHubRepo('git@github.com:acme/handbook.git'), 'acme/handbook');
  assert.equal(parseGitHubRepo('https://github.com/acme/handbook.git'), 'acme/handbook');
  assert.equal(parseGitHubRepo('https://github.com/acme/handbook'), 'acme/handbook');
  assert.equal(parseGitHubRepo('ssh://git@github.com/acme/handbook.git'), 'acme/handbook');
  // Fremde Hosts kann gh nicht holen -- das ist "nicht aufloesbar", kein Absturz.
  assert.equal(parseGitHubRepo('git@gitlab.example.com:acme/handbook.git'), null);
  assert.equal(parseGitHubRepo('../relative/path'), null);
});

test('fetchTextAcrossSubmodules folgt dem Gitlink und pinnt auf dessen SHA', async () => {
  // Die Contents-API des PR-Repos endet am Gitlink: ein Pfad dahinter ist 404, der
  // Gitlink selbst antwortet mit type "submodule", SHA und Quell-URL. Der SHA ist der
  // Stand des Submodules im Head-Commit des PR -- also exakt die Spec-Fassung, die der
  // PR meint. Wuerde stattdessen der Default-Branch des Spec-Repos geholt, laese der
  // Reviewer eine Spec, die weitergelaufen ist: das Bundle waere nicht mehr eingefroren.
  const calls = [];
  const api = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === '/repos/example/demo/contents/docs-sub?ref=head1') {
      return { type: 'submodule', sha: 'gitlink1', submodule_git_url: 'git@github.com:acme/handbook.git' };
    }
    if (endpoint === '/repos/acme/handbook/contents/specs/DEMO-7.md?ref=gitlink1') {
      return { content: Buffer.from('# DEMO-7\n1. Kriterium\n').toString('base64'), encoding: 'base64' };
    }
    const err = new Error('Not Found'); err.status = 404; throw err;
  };

  const text = await fetchTextAcrossSubmodules(api, 'example/demo', 'docs-sub/specs/DEMO-7.md', 'head1');
  assert.equal(text, '# DEMO-7\n1. Kriterium\n');
  assert.ok(
    calls.includes('/repos/acme/handbook/contents/specs/DEMO-7.md?ref=gitlink1'),
    'der Abruf im Spec-Repo muss auf den Gitlink-SHA gepinnt sein',
  );

  // Kein Submodule auf dem Weg: null, kein Wurf.
  const miss = async (endpoint) => { const e = new Error('nf'); e.status = 404; throw e; };
  assert.equal(await fetchTextAcrossSubmodules(miss, 'example/demo', 'docs-sub/specs/DEMO-7.md', 'head1'), null);

  // Nicht aufloesbare Quelle (fremder Host): null -- meta.spec_missing sagt es dann.
  const foreign = async (endpoint) => {
    if (endpoint === '/repos/example/demo/contents/docs-sub?ref=head1') {
      return { type: 'submodule', sha: 'gitlink1', submodule_git_url: 'git@gitlab.example.com:acme/handbook.git' };
    }
    const err = new Error('Not Found'); err.status = 404; throw err;
  };
  assert.equal(await fetchTextAcrossSubmodules(foreign, 'example/demo', 'docs-sub/specs/DEMO-7.md', 'head1'), null);
});

test('buildBundle holt eine explizit verlinkte Spec durch das Submodule', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-subspec-')), 'bundle');
  const api = async (endpoint) => {
    if (endpoint === '/repos/example/demo/pulls/6') {
      return { number: 6, title: 'Session-Warnung', body: 'Abnahme: docs-sub/specs/DEMO-7.md',
        user: { login: 'a' }, labels: [], base: { sha: 'b' }, head: { sha: 'head1', ref: 'feat/session' } };
    }
    if (endpoint === '/repos/example/demo/pulls/6/files') {
      return [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n keep\n+add' }];
    }
    if (endpoint === '/repos/example/demo/pulls/6/comments') return [];
    if (endpoint.startsWith('/repos/example/demo/contents/src/a.ts')) {
      return { content: Buffer.from('keep\nadd\n').toString('base64'), encoding: 'base64' };
    }
    if (endpoint === '/repos/example/demo/contents/docs-sub?ref=head1') {
      return { type: 'submodule', sha: 'gitlink1', submodule_git_url: 'https://github.com/acme/handbook.git' };
    }
    if (endpoint === '/repos/acme/handbook/contents/specs/DEMO-7.md?ref=gitlink1') {
      return { content: Buffer.from('# DEMO-7\n1. Kriterium\n').toString('base64'), encoding: 'base64' };
    }
    const err = new Error('Not Found'); err.status = 404; throw err;
  };

  const summary = await buildBundle({ repo: 'example/demo', number: 6, ghApi: api, bundleDir: dir });

  assert.equal(summary.specLink, 'docs-sub/specs/DEMO-7.md');
  assert.equal(readFileSync(join(dir, 'spec.md'), 'utf8'), '# DEMO-7\n1. Kriterium\n');
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.spec_missing, false);
  assert.equal(meta.spec_link, 'docs-sub/specs/DEMO-7.md');
});

test('isGenerated erkennt Lockfiles und Buendel, nicht aber echten Code', () => {
  for (const p of [
    'package-lock.json', 'web/package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
    'gradle.lockfile', 'uv.lock', 'Gemfile.lock', 'assets/app.min.js', 'dist/index.html',
  ]) {
    assert.equal(isGenerated(p), true, p);
  }
  // Gegenprobe: eine Ausnahme, die zu viel ausnimmt, versteckt echten Code.
  for (const p of [
    'package.json', 'src/lock.ts', 'src/distance.ts', 'src/main.ts',
    'src/components/Lockfile.vue', 'build.gradle.kts', 'docs/dist-strategie.md',
  ]) {
    assert.equal(isGenerated(p), false, p);
  }
});

test('reviewableLines zaehlt generierte Dateien nicht mit', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-gen-')), 'bundle');
  const fakeApi = async (endpoint) => {
    if (endpoint === '/repos/example/demo/pulls/2') {
      return {
        number: 2, title: 'ohne Spec', body: '', user: { login: 'alice' }, labels: [],
        base: { sha: 'base1' }, head: { sha: 'head1', ref: 'chore/scaffold' },
      };
    }
    if (endpoint === '/repos/example/demo/pulls/2/files') {
      return [
        // Der reale Fall: 5312 Zeilen Lockfile neben 20 Zeilen Code.
        { filename: 'package-lock.json', status: 'added', additions: 5300, deletions: 12,
          patch: '@@ -0,0 +1 @@\n+{"lockfileVersion":3}' },
        { filename: 'src/main.ts', status: 'added', additions: 18, deletions: 2,
          patch: '@@ -0,0 +1 @@\n+import { createApp } from "vue"' },
      ];
    }
    if (endpoint === '/repos/example/demo/pulls/2/comments') return [];
    const err = new Error('Not Found');
    err.status = 404;
    throw err;
  };

  const summary = await buildBundle({ repo: 'example/demo', number: 2, ghApi: fakeApi, bundleDir: dir });

  // changedLines bleibt die Gesamtzahl -- das Feld wird nicht umdefiniert.
  assert.equal(summary.changedLines, 5332);
  assert.equal(summary.reviewableLines, 20);

  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.changed_lines, 5332);
  assert.equal(meta.reviewable_lines, 20);
  const byPath = new Map(meta.files.map((f) => [f.path, f]));
  assert.equal(byPath.get('package-lock.json').generated, true);
  assert.equal(byPath.get('src/main.ts').generated, undefined);
  // Generierte Dateien bleiben im Bundle und damit zitierbar -- geaendert wurde
  // nur die Zaehlung.
  assert.ok(existsSync(join(dir, 'patches/package-lock.json.patch')));
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

// PR 4: eine geaenderte Datei in src/, daneben Geschwister. Der Verzeichnis-Endpunkt
// liefert ein Array, nicht ein Objekt mit content -- deshalb ein eigener Zweig.
function siblingApi() {
  return async (endpoint) => {
    if (endpoint === '/repos/example/demo/pulls/4') {
      return { number: 4, title: 't', body: '', user: { login: 'a' }, labels: [],
        base: { sha: 'b' }, head: { sha: 'h', ref: 'x' } };
    }
    if (endpoint === '/repos/example/demo/pulls/4/files') {
      return [{ filename: 'src/one.java', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n keep\n+neu' }];
    }
    if (endpoint === '/repos/example/demo/pulls/4/comments') return [];
    if (endpoint.startsWith('/repos/example/demo/contents/src?')) {
      return [
        { name: 'one.java', path: 'src/one.java', type: 'file', size: 100 },
        { name: 'two.java', path: 'src/two.java', type: 'file', size: 100 },
        { name: 'three.java', path: 'src/three.java', type: 'file', size: 100 },
        { name: 'notes.md', path: 'src/notes.md', type: 'file', size: 100 },
        { name: 'sub', path: 'src/sub', type: 'dir', size: 0 },
      ];
    }
    if (endpoint.startsWith('/repos/example/demo/contents/src/one.java')) {
      return { content: Buffer.from('keep\nneu\n').toString('base64'), encoding: 'base64' };
    }
    if (endpoint.startsWith('/repos/example/demo/contents/src/two.java')) {
      return { content: Buffer.from('class Two { void handle() {} }\n').toString('base64'), encoding: 'base64' };
    }
    if (endpoint.startsWith('/repos/example/demo/contents/src/three.java')) {
      return { content: Buffer.from('class Three { void handle() {} }\n').toString('base64'), encoding: 'base64' };
    }
    const err = new Error('Not Found'); err.status = 404; throw err;
  };
}

test('buildBundle sammelt Geschwister gleicher Endung, aber nicht die geaenderte Datei selbst', async () => {
  // consistency braucht die Nachbarschaft, um "drei Muster fuer dasselbe Problem" zu
  // sehen -- ein Agent, der Story 7 baut, kennt Stories 1-6 nicht. Gleiche Endung, weil
  // eine .md neben einer .java nichts ueber Muster im Code sagt und nur Kontext kostet.
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-sib-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 4, ghApi: siblingApi(), bundleDir: dir });

  assert.ok(existsSync(join(dir, 'siblings/src/two.java')), 'Geschwister gleicher Endung fehlt');
  assert.ok(existsSync(join(dir, 'siblings/src/three.java')));
  assert.equal(existsSync(join(dir, 'siblings/src/notes.md')), false, 'andere Endung gehoert nicht ins Bundle');
  assert.equal(existsSync(join(dir, 'siblings/src/one.java')), false, 'die geaenderte Datei liegt schon in files/');
  assert.ok(existsSync(join(dir, 'files/src/one.java')));
});

test('Geschwister landen NICHT im Haystack — die Evidenzpflicht bleibt unangetastet', async () => {
  // Die wichtigste Zusicherung dieser Erweiterung. Kaeme der Text der Geschwister in den
  // Haystack, waere plötzlich Evidenz aus UNVERAENDERTEN Dateien auffindbar -- und die
  // Regel, an der das ganze Konstrukt haengt ("kein Befund ohne Zitat aus einer
  // geaenderten Datei"), waere fuer JEDEN Analysten aufgeweicht, nicht nur fuer
  // consistency. Der Nachbarschaftskontext ist zum Verstehen da, nicht zum Zitieren.
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-sibhay-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 4, ghApi: siblingApi(), bundleDir: dir });

  const b = loadBundle(dir);
  assert.equal(b.fileText.get('src/two.java'), undefined, 'Geschwister darf nicht in fileText stehen');
  assert.deepEqual(b.meta.files.map((f) => f.path), ['src/one.java'], 'Geschwister darf nicht in meta.files stehen');

  // Und die Gegenprobe an der echten Maschinerie statt nur an der Datenstruktur.
  const haystacks = new Map(b.meta.files.map((f) => [f.path,
    `${b.fileText.get(f.path) ?? ''}\n${b.patchText.get(f.path) ?? ''}`]));
  const analysts = new Map([['consistency', { name: 'consistency', severity_max: 'major' }]]);
  const { accepted, rejected } = validateAll(new Map([['consistency', [{
    file: 'src/two.java', line: 1, side: 'RIGHT', severity: 'major',
    title: 'Zitat aus einem Geschwister', problem: 'p',
    evidence: 'class Two { void handle() {} }', fix: 'f', confidence: 'hoch',
  }]]]), { analysts, haystacks, knownFiles: new Set(b.meta.files.map((f) => f.path)) });
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /nicht im Diff/);
});

test('ein zweites fetch laesst kein veraltetes Geschwister stehen', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-sibstale-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 4, ghApi: siblingApi(), bundleDir: dir });
  assert.ok(existsSync(join(dir, 'siblings/src/two.java')));

  // Runde 2: two.java gibt es nicht mehr, three.java schon.
  const api2 = async (endpoint) => {
    if (endpoint.startsWith('/repos/example/demo/contents/src?')) {
      return [
        { name: 'one.java', path: 'src/one.java', type: 'file', size: 100 },
        { name: 'three.java', path: 'src/three.java', type: 'file', size: 100 },
      ];
    }
    return siblingApi()(endpoint);
  };
  await buildBundle({ repo: 'example/demo', number: 4, ghApi: api2, bundleDir: dir });

  assert.equal(existsSync(join(dir, 'siblings/src/two.java')), false, 'verschwundenes Geschwister muss weg sein');
  assert.ok(existsSync(join(dir, 'siblings/src/three.java')));
});

test('die Geschwister-Kappung wird gemeldet, nicht stillschweigend angewandt', async () => {
  // Nichts scheitert still: wer nicht weiss, dass die Nachbarschaft abgeschnitten wurde,
  // haelt "kein Musterbruch gefunden" fuer eine Aussage ueber das Verzeichnis.
  const viele = Array.from({ length: 20 }, (_, i) => ({
    name: `f${i}.java`, path: `src/f${i}.java`, type: 'file', size: 10,
  }));
  const api = async (endpoint) => {
    if (endpoint.startsWith('/repos/example/demo/contents/src?')) {
      return [{ name: 'one.java', path: 'src/one.java', type: 'file', size: 10 }, ...viele];
    }
    if (/\/contents\/src\/f\d+\.java/.test(endpoint)) {
      return { content: Buffer.from('class X {}\n').toString('base64'), encoding: 'base64' };
    }
    return siblingApi()(endpoint);
  };
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-sibcap-')), 'bundle');
  const summary = await buildBundle({ repo: 'example/demo', number: 4, ghApi: api, bundleDir: dir });

  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.ok(meta.siblings.length > 0, 'gesammelte Geschwister gehoeren in meta.json');
  assert.ok(meta.siblings.length < 20, 'die Kappung muss greifen');
  assert.deepEqual(meta.siblings_truncated, ['src'], 'das gekappte Verzeichnis muss benannt sein');
  assert.equal(summary.siblings, meta.siblings.length);
});

// PR 5: eine Java-Datei, dazu ein Gradle-Manifest in der Wurzel. pom.xml und
// package.json existieren nicht -- der 404 darf nicht stoeren.
function manifestApi() {
  return async (endpoint) => {
    if (endpoint === '/repos/example/demo/pulls/5') {
      return { number: 5, title: 't', body: '', user: { login: 'a' }, labels: [],
        base: { sha: 'b' }, head: { sha: 'h', ref: 'x' } };
    }
    if (endpoint === '/repos/example/demo/pulls/5/files') {
      return [{ filename: 'src/main/java/app/Foo.java', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n keep\n+neu' }];
    }
    if (endpoint === '/repos/example/demo/pulls/5/comments') return [];
    if (endpoint.startsWith('/repos/example/demo/contents/build.gradle.kts')) {
      return { content: Buffer.from('dependencies { implementation("org.springframework.boot:spring-boot-starter-web") }\n').toString('base64'), encoding: 'base64' };
    }
    if (endpoint.startsWith('/repos/example/demo/contents/src/main/java/app/Foo.java')) {
      return { content: Buffer.from('keep\nneu\n').toString('base64'), encoding: 'base64' };
    }
    const err = new Error('Not Found'); err.status = 404; throw err;
  };
}

test('buildBundle holt vorhandene Manifestdateien und vermerkt sie', async () => {
  // Ohne Manifest weiss ein Stack-Analyst nicht, was auf dem Classpath liegt, und
  // empfiehlt Framework-Mittel, die es im Projekt gar nicht gibt.
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-man-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 5, ghApi: manifestApi(), bundleDir: dir });

  assert.ok(existsSync(join(dir, 'manifests/build.gradle.kts')));
  assert.equal(existsSync(join(dir, 'manifests/pom.xml')), false, 'nicht vorhandene Manifeste duerfen nicht erfunden werden');
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual(meta.manifests, ['build.gradle.kts']);
});

test('Manifeste landen NICHT im Haystack', async () => {
  // Dieselbe Zusicherung wie bei siblings/: die Evidenzpflicht darf sich nicht dadurch
  // lockern, dass wir Kontext dazunehmen. Ein Manifest ist unveraendert, also nicht
  // zitierbar -- sonst waere jede Abhaengigkeitszeile plötzlich gueltige Evidenz.
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-manhay-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 5, ghApi: manifestApi(), bundleDir: dir });

  const b = loadBundle(dir);
  assert.equal(b.fileText.get('build.gradle.kts'), undefined);
  assert.deepEqual(b.meta.files.map((f) => f.path), ['src/main/java/app/Foo.java']);
});

test('ein zweites fetch laesst kein veraltetes Manifest stehen', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'prr-manstale-')), 'bundle');
  await buildBundle({ repo: 'example/demo', number: 5, ghApi: manifestApi(), bundleDir: dir });
  assert.ok(existsSync(join(dir, 'manifests/build.gradle.kts')));

  // Runde 2: das Projekt ist auf Maven umgestellt.
  const api2 = async (endpoint) => {
    if (endpoint.startsWith('/repos/example/demo/contents/build.gradle.kts')) {
      const err = new Error('Not Found'); err.status = 404; throw err;
    }
    if (endpoint.startsWith('/repos/example/demo/contents/pom.xml')) {
      return { content: Buffer.from('<project/>\n').toString('base64'), encoding: 'base64' };
    }
    return manifestApi()(endpoint);
  };
  await buildBundle({ repo: 'example/demo', number: 5, ghApi: api2, bundleDir: dir });

  assert.equal(existsSync(join(dir, 'manifests/build.gradle.kts')), false);
  assert.ok(existsSync(join(dir, 'manifests/pom.xml')));
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

#!/usr/bin/env node
import { ghApi, currentRepo } from './gh.mjs';
import { buildBundle, bundlePathFor } from './bundle.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function cmdFetch(positional, flags) {
  const number = Number(String(positional[0] ?? '').replace(/^#/, ''));
  if (!Number.isInteger(number) || number <= 0) fail('Bitte eine PR-Nummer angeben, z. B. pr-review fetch 55');
  let repo = flags.repo;
  if (!repo) {
    try { repo = await currentRepo(); } catch {
      fail('Repo nicht ermittelbar. Aus einem Repo-Verzeichnis starten oder --repo owner/name angeben.');
    }
  }
  const summary = await buildBundle({ repo, number, ghApi });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional.shift();

try {
  if (command === 'fetch') await cmdFetch(positional, flags);
  else if (command === 'path') {
    const repo = flags.repo ?? (await currentRepo());
    process.stdout.write(`${bundlePathFor(repo, Number(positional[0]))}\n`);
  } else {
    fail('Unbekanntes Kommando. Verfuegbar: fetch, path');
  }
} catch (err) {
  fail(err.message);
}

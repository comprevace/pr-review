import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHunks, toRanges, commentableRanges, isCommentable } from '../lib/diff.mjs';

const PATCH = [
  '@@ -10,6 +10,7 @@ class Session {',
  ' public void a() {',
  '-  int old = 1;',
  '+  int neu = 2;',
  '+  int extra = 3;',
  ' }',
  ' // tail',
  '@@ -40 +41,2 @@',
  '+added',
  '+more',
].join('\n');

test('parseHunks liest Start-Zeilen beider Seiten, auch ohne Count', () => {
  const hunks = parseHunks(PATCH);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].oldStart, 10);
  assert.equal(hunks[0].newStart, 10);
  assert.equal(hunks[1].oldStart, 40);
  assert.equal(hunks[1].newStart, 41);
});

test('toRanges fasst zusammenhaengende Zeilen zusammen und dedupliziert', () => {
  assert.deepEqual(toRanges([3, 1, 2, 7, 8, 2]), [[1, 3], [7, 8]]);
  assert.deepEqual(toRanges([]), []);
});

test('commentableRanges zaehlt Kontext- und Plus-Zeilen auf RIGHT', () => {
  const map = commentableRanges(PATCH);
  // Hunk 1 neu: 10 Kontext, 11 plus, 12 plus, 13 Kontext, 14 Kontext
  // Hunk 2 neu: 41 plus, 42 plus
  assert.deepEqual(map.RIGHT, [[10, 14], [41, 42]]);
});

test('commentableRanges zaehlt Kontext- und Minus-Zeilen auf LEFT', () => {
  const map = commentableRanges(PATCH);
  // Hunk 1 alt: 10 Kontext, 11 minus, 12 Kontext, 13 Kontext
  assert.deepEqual(map.LEFT, [[10, 13]]);
});

test('No-newline-Marker verschiebt keine Zeilennummern', () => {
  const p = ['@@ -1,2 +1,2 @@', '-alt', '\\ No newline at end of file', '+neu'].join('\n');
  const map = commentableRanges(p);
  assert.deepEqual(map.RIGHT, [[1, 1]]);
  assert.deepEqual(map.LEFT, [[1, 1]]);
});

test('fehlender Patch ergibt leere Map statt Absturz', () => {
  assert.deepEqual(commentableRanges(null), { RIGHT: [], LEFT: [] });
  assert.deepEqual(parseHunks(null), []);
});

test('isCommentable prueft Bereichsgrenzen einschliesslich', () => {
  const map = { RIGHT: [[10, 14]], LEFT: [] };
  assert.equal(isCommentable(map, 'RIGHT', 10), true);
  assert.equal(isCommentable(map, 'RIGHT', 14), true);
  assert.equal(isCommentable(map, 'RIGHT', 15), false);
  assert.equal(isCommentable(map, 'LEFT', 10), false);
  assert.equal(isCommentable(null, 'RIGHT', 10), false);
});

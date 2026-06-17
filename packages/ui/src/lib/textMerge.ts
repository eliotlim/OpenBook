/**
 * Three-way plain-text merge (a word-level diff3), used when accepting a
 * suggestion whose target text has changed since the suggestion was made —
 * e.g. two suggestions edit the SAME block and both are accepted. Replaying the
 * second as a full-text replacement would clobber the first; merging it against
 * the common ancestor keeps both edits when they touch different regions.
 *
 * Granularity is the token (a whitespace run, a word, or a single punctuation
 * char), so disjoint word edits merge cleanly. When both sides changed the same
 * region differently it is a true conflict, resolved in favour of `theirs` (the
 * change being accepted) — the closest match to the prior "last write wins"
 * behaviour, but now confined to the genuinely-overlapping span.
 */

/** Split into merge tokens. Concatenating the result reproduces the input
 *  exactly, so a merge can never invent or drop characters. */
function tokenize(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

/** Keep the O(n·m) LCS bounded; above this we fall back to "theirs". */
const MAX_MERGE_TOKENS = 2000;

/** A longest common subsequence of `a` and `b` as matched `[aIndex, bIndex]`
 *  pairs (both indices strictly increasing). */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  // dp[i*w + j] = LCS length of a[i:] and b[j:].
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + (j + 1)] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

const seqEqual = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Merge `theirs` into `ours` relative to their common ancestor `base`. Edits the
 * two sides make in different regions are both kept; a region both sides changed
 * differently resolves to `theirs`.
 */
export function merge3(base: string, ours: string, theirs: string): string {
  if (ours === base) return theirs; // no local change → take theirs wholesale
  if (theirs === base || ours === theirs) return ours; // theirs is a no-op / already applied

  const O = tokenize(base);
  const A = tokenize(ours);
  const B = tokenize(theirs);
  if (O.length > MAX_MERGE_TOKENS || A.length > MAX_MERGE_TOKENS || B.length > MAX_MERGE_TOKENS) return theirs;

  const aOf = new Map<number, number>(lcsPairs(O, A));
  const bOf = new Map<number, number>(lcsPairs(O, B));

  // Anchors: base tokens preserved in BOTH sides (so monotonic in all three).
  // Sentinels at each end bracket the leading/trailing regions.
  const anchors: Array<{o: number; a: number; b: number}> = [{o: -1, a: -1, b: -1}];
  for (let o = 0; o < O.length; o += 1) {
    const a = aOf.get(o);
    const b = bOf.get(o);
    if (a !== undefined && b !== undefined) anchors.push({o, a, b});
  }
  anchors.push({o: O.length, a: A.length, b: B.length});

  const out: string[] = [];
  for (let k = 0; k < anchors.length - 1; k += 1) {
    const cur = anchors[k];
    const nxt = anchors[k + 1];
    const baseSeg = O.slice(cur.o + 1, nxt.o);
    const aSeg = A.slice(cur.a + 1, nxt.a);
    const bSeg = B.slice(cur.b + 1, nxt.b);
    if (seqEqual(aSeg, bSeg)) out.push(...aSeg);
    else if (seqEqual(aSeg, baseSeg)) out.push(...bSeg); // only theirs changed this region
    else if (seqEqual(bSeg, baseSeg)) out.push(...aSeg); // only ours changed this region
    else out.push(...bSeg); // both changed it → theirs wins
    if (nxt.o < O.length) out.push(O[nxt.o]); // the shared anchor token itself
  }
  return out.join('');
}

// Wake-word keyword lines for the sherpa-onnx KWS model (zipformer,
// gigaspeech, SentencePiece *unigram* vocabulary of 500 pieces).
//
// The keyword line must use the same segmentation the model was trained on.
// The model's bpe.model is a unigram LM, so tokenization is Viterbi: the split
// of "▁WORD" into known pieces with the highest total log-probability. The
// piece scores are shipped as resources/models/kws/scores.json (extracted from
// the model's bpe.model, Apache-2.0). Checked against sherpa's own examples:
// HELLO → "▁HE LL O", ALEXA → "▁A LE X A", HEY SIRI → "▁HE Y ▁S I RI", and
// Cadabra's original line "▁CA D A B RA".

/** piece → log-probability score */
export type Scores = Record<string, number>;

/** Unigram (Viterbi) pieces for one word. Null if it can't be spelled with the vocabulary. */
export function tokenizeWord(word: string, scores: Scores): string[] | null {
  const w = '▁' + word.toUpperCase().replace(/[^A-Z']/g, '');
  if (w.length < 2) return null;
  const n = w.length;
  const best = new Array<number>(n + 1).fill(-Infinity);
  const back = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let end = 1; end <= n; end++) {
    for (let start = Math.max(0, end - 12); start < end; start++) {
      if (best[start] === -Infinity) continue;
      const sc = scores[w.slice(start, end)];
      if (sc == null) continue;
      const v = best[start] + sc;
      if (v > best[end]) {
        best[end] = v;
        back[end] = start;
      }
    }
  }
  if (best[n] === -Infinity) return null;
  const out: string[] = [];
  for (let end = n; end > 0; end = back[end]) out.unshift(w.slice(back[end], end));
  return out;
}

/**
 * The k best segmentations of one word (best first). The acoustic model does
 * not always emit the single Viterbi path for a rare word, so a keyword with a
 * few alternative paths is spotted far more reliably (KWS matrix, round 5).
 */
export function tokenizeWordNBest(word: string, scores: Scores, k = 3): string[][] {
  const w = '▁' + word.toUpperCase().replace(/[^A-Z']/g, '');
  if (w.length < 2) return [];
  const n = w.length;
  // best[i] = up to k (score, pieces) for the prefix w[0..i)
  const best: { s: number; p: string[] }[][] = Array.from({ length: n + 1 }, () => []);
  best[0] = [{ s: 0, p: [] }];
  for (let end = 1; end <= n; end++) {
    const cands: { s: number; p: string[] }[] = [];
    for (let start = Math.max(0, end - 12); start < end; start++) {
      const sc = scores[w.slice(start, end)];
      if (sc == null) continue;
      for (const b of best[start]) cands.push({ s: b.s + sc, p: [...b.p, w.slice(start, end)] });
    }
    cands.sort((a, b) => b.s - a.s);
    best[end] = cands.slice(0, k);
  }
  return best[n].map((b) => b.p);
}

/** Tokens for a phrase ("Hey Juniper" → each word tokenized, joined). */
export function tokenizePhrase(phrase: string, scores: Scores): string[] | null {
  const out: string[] = [];
  for (const word of phrase.trim().split(/\s+/)) {
    const p = tokenizeWord(word, scores);
    if (!p) return null;
    out.push(...p);
  }
  return out;
}

/** 0 (strict) .. 1 (sensitive) → KWS threshold 0.40 .. 0.15 (as before). */
export function kwsThreshold(sensitivity: number): number {
  const s = Math.min(1, Math.max(0, sensitivity));
  return Math.round((0.4 - s * 0.25) * 100) / 100;
}

export function keywordLabel(name: string): string {
  return name.toUpperCase().replace(/[^A-Z]/g, '');
}

export interface KeywordTuning {
  /** Boost score for the name's lines (default 2.0). */
  boost?: number;
  /** Added to the sensitivity-derived threshold (negative = easier; default -0.1). */
  thresholdOffset?: number;
  /** Other spellings of how the name is SAID ("Marlo" for Marlowe): extra lines, same label. */
  variants?: string[];
  /** How many alternative segmentations per spelling (default 3). */
  paths?: number;
}

/**
 * The keywords file: the name (plus how it is said, if spelled differently)
 * and decoys: near-words that should NOT wake (they win the match and are ignored).
 */
export function keywordsFileFor(name: string, sensitivity: number, scores: Scores, decoys: string[] = [], tune: KeywordTuning = {}): string {
  const toks = tokenizePhrase(name, scores);
  if (!toks) throw new Error(`Can't build a wake word for “${name}”.`);
  // Tuning env vars only in test modes (a stray env var must not change wake behaviour).
  const env = (k: string) => (typeof process !== 'undefined' && process.env?.CADABRA_TEST_MODE === '1' ? process.env[k] : undefined);
  const boost = Number(env('CADABRA_KWS_BOOST')) || tune.boost || 2.0;
  // Defaults from the round-5 KWS matrix: 3 alternative paths and a threshold
  // 0.1 below the sensitivity mapping roughly doubled recall for most names with
  // no false wakes on everyday speech.
  const offset = env('CADABRA_KWS_TH_OFFSET') != null ? Number(env('CADABRA_KWS_TH_OFFSET')) : (tune.thresholdOffset ?? -0.1);
  const th = Math.min(0.6, Math.max(0.05, kwsThreshold(sensitivity) + offset));
  const label = keywordLabel(name);
  const lines: string[] = [];
  const seen = new Set<string>();
  const paths = Number(env('CADABRA_KWS_PATHS')) || tune.paths || 3;
  for (const spelling of [name, ...(tune.variants ?? [])]) {
    // Single-word names get alternative segmentations; phrases use the best path.
    const segs = /\s/.test(spelling.trim()) ? [tokenizePhrase(spelling, scores) ?? []] : tokenizeWordNBest(spelling, scores, paths);
    for (const t of segs) {
      if (!t.length || seen.has(t.join(' '))) continue;
      seen.add(t.join(' '));
      lines.push(`${t.join(' ')} :${boost.toFixed(1)} #${th.toFixed(2)} @${label}`);
    }
  }
  for (const d of decoys) {
    const t = tokenizePhrase(d, scores);
    if (t && keywordLabel(d) !== keywordLabel(name)) lines.push(`${t.join(' ')} :2.5 #0.20 @${keywordLabel(d)}`);
  }
  return lines.join('\n') + '\n';
}

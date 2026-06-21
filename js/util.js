// Small pure helpers shared across modules.
export const $ = (id) => document.getElementById(id);

export function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function chance(p) { return Math.random() < p; }

// Canonical comparison key for a song title (or a typed answer). Lets a player's
// answer match regardless of punctuation, & vs "and", the $ stylisation, bracket
// tags, or numerals-vs-words. Display titles stay canonical — this only feeds the
// match. Verified to produce zero collisions across the catalog. NOTE: the order
// matters (twenty-two before the single-word folds).
export function normalizeTitle(s) {
  return s
    .toLowerCase()
    .replace(/’/g, "'")                 // curly apostrophe -> straight
    .replace(/\$/g, "s")                     // Wi$h Li$t -> wish list
    .replace(/[&+]/g, "and")                 // & / + -> and
    .replace(/[().!?,:;"'…]/g, "")       // drop punctuation + bracket chars (keep content)
    .replace(/[-–—/]/g, " ")        // dashes & slashes -> space
    .replace(/\btwenty[\s-]?two\b/g, "22")
    .replace(/\bten\b/g, "10")
    .replace(/\bone\b/g, "1")
    .replace(/\s+/g, " ")
    .trim();
}

// Comparison key for a typed lyric line vs stored lyrics. Like normalizeTitle for
// casing / apostrophes / & / $ / punctuation / dashes / whitespace, but WITHOUT the
// title-only numeral folds (those would corrupt ordinary lyric text, e.g. "the ONE
// that got away"). Adds one lyric-specific transform: fold word-final "ing" -> "in"
// so "dancing" and "dancin'" match either way (g-dropping is common in TS lyrics).
// Collapses all whitespace (incl. newlines) to single spaces, so a per-song blob is
// one flat string ideal for substring search.
export function normalizeLyric(s) {
  return s
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/\$/g, "s")
    .replace(/[&+]/g, "and")
    .replace(/[().!?,:;"'…]/g, "")
    .replace(/[-–—/]/g, " ")
    .replace(/ing\b/g, "in")        // g-dropping: dancing / dancin' -> dancin
    .replace(/\s+/g, " ")
    .trim();
}

// Standard Levenshtein edit distance (two-row DP).
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// Approximate SUBSTRING match: how well `pattern` matches its best-aligned window of
// `text`, in [0,1] (1 = a clean substring; less for typos / partial). The DP's first
// row stays 0 so the pattern may start anywhere in `text`, and leftover `text` past
// the match is free — the score is 1 - min(last row) / pattern.length.
export function fuzzySubstringRatio(pattern, text) {
  if (!pattern.length) return 0;
  if (!text.length) return 0;
  let prev = new Array(text.length + 1).fill(0);
  let curr = new Array(text.length + 1);
  for (let i = 1; i <= pattern.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= text.length; j++) {
      const cost = pattern[i - 1] === text[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  let best = Infinity;
  for (let j = 0; j <= text.length; j++) if (prev[j] < best) best = prev[j];
  return Math.max(0, 1 - best / pattern.length);
}

// Mulberry32 — a fast, small seeded PRNG. Returns a factory that produces
// float values in [0, 1) each call, exactly like Math.random().
export function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Hash a "YYYY-MM-DD" date string to a uint32 seed (djb2-style).
export function dailySeed(dateStr) {
  let h = 5381;
  for (let i = 0; i < dateStr.length; i++)
    h = (Math.imul(h, 33) ^ dateStr.charCodeAt(i)) >>> 0;
  return h;
}

/* ---------- Profanity / slur masking ---------- */
// Mask explicit words wherever lyrics or titles are SHOWN to the player (the stored
// data is untouched — matching still runs on the real words). Two tiers:
//   • SLUR_RE  — the racial slur in one featured song; ALWAYS masked, no opt-out.
//   • SWEAR_RE — general profanity; masked only when the player opts in (the
//                "censor explicit words" setting).
// Mild words ("damn", "hell") are deliberately left alone — "damn" is also a valid
// prompt word, and masking either would over-censor common, non-explicit lines.
const SLUR_RE  = /\bnigg(?:a|er)s?\b/gi;
// Each stem is bounded so we don't bleed into innocent words (e.g. "country" never
// matches "cunt", "Dickinson" never matches "dick"). \w* tails catch inflections
// (fucking, shitty, bitches) without enumerating every form.
const SWEAR_RE = /\b(?:(?:mother)?fuck\w*|shit\w*|bitch\w*|slut\w*|piss\w*|dick(?:s|head|heads)?|whore\w*|cunt\w*|asshole\w*|prick(?:s)?|bastard\w*|pussy\w*|goddamn\w*)\b/gi;

// Keep the first and last letter, star the middle: fuck → f**k, shit → s**t,
// nigga → n***a. Trailing non-letters (an apostrophe in "fuckin'") aren't matched
// by the \w* stems, so they fall outside the mask and read cleanly.
function maskWord(w) {
  if (w.length <= 1) return "*";
  if (w.length === 2) return w[0] + "*";
  return w[0] + "*".repeat(w.length - 2) + w[w.length - 1];
}

// Mask a string for display. Slurs are masked unconditionally; general profanity
// only when `profanity` is true. Pure — returns a new string, leaves data as-is.
export function censorText(text, profanity) {
  if (text == null) return text;
  let out = String(text).replace(SLUR_RE, maskWord);
  if (profanity) out = out.replace(SWEAR_RE, maskWord);
  return out;
}

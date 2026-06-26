"use strict";
// Shared lyric-matching core. Pure, state-free, and reused by BOTH the game
// (js/app.js) and the lyrics searcher (/search) so they always agree on what a word
// "matches". Nothing here reads game state: every function takes an explicit `strict`
// boolean and does no censoring. The game's defaulting + censoring wrappers live in
// app.js (they resolve effectiveStrict()/censor() and then delegate here).
import { escapeRegExp, escapeHtml } from "./util.js";

// Prefix-stem match: the word as the start of a token, plus any trailing letters,
// so "gold" matches "golden", "dream" matches "dreamer". The leading \b keeps it
// safe (e.g. "love" won't match "glove"/"clover"; "rain" won't match "train").
// The plain [a-z']* tail only catches forms that ADD letters (love→lover/loved/loves,
// gold→golden). These are the common inflections that CHANGE the stem first and so
// slip past it: silent-e drop (love→loving), consonant+y→i (city→cities), and
// final-consonant doubling (run→running). Each mutated stem is followed by a BOUNDED
// inflectional suffix set (not [a-z']*), so time→timing matches but "timber" never does.
// Bare "in" (not "in'") so it still matches before a trailing apostrophe — \bin'\b
// can't (the apostrophe is non-word, killing the closing boundary), but \bin\b
// backtracks onto the "n" inside "lovin'". Covers g-dropped forms either way.
export const INFLECT = "(?:ing|in|ings|ed|er|ers|es|y|ies|ied|ier|iest|able)";
export function wordVariants(word) {
  const w = word.toLowerCase();
  const alts = [escapeRegExp(w) + "[a-z']*"];   // base: word + any added tail (unchanged behaviour)
  if (w.length >= 4 && w.endsWith("e")) alts.push(escapeRegExp(w.slice(0, -1)) + INFLECT);
  if (w.length >= 3 && /[^aeiou]y$/.test(w)) alts.push(escapeRegExp(w.slice(0, -1) + "i") + INFLECT);
  if (w.length >= 3 && /[^aeiou][aeiou][^aeiouwxy]$/.test(w)) alts.push(escapeRegExp(w + w.slice(-1)) + INFLECT);
  return alts;
}

// Lenient (strict falsy) also matches the inflected forms above (cheat→cheats);
// strict requires the exact word. `strict` is an explicit boolean here — the game
// wrapper resolves its default from effectiveStrict() before calling.
export function wordRegex(word, strict) {
  if (strict) return new RegExp("\\b" + escapeRegExp(word) + "\\b", "i");
  return new RegExp("\\b(?:" + wordVariants(word).join("|") + ")\\b", "i");
}

// The first lyric line bearing the word (trimmed). Prioritise a line with the *exact*
// prompt word over a looser stem variant (e.g. "babe" shouldn't surface a line whose
// only match is "baby"). Only the lenient path falls back; a strict caller already
// wants exact-only. Falls back to the first line if nothing matches.
export function extractLineWithWord(lyrics, word, strict) {
  const lines = lyrics.split("\n");
  if (!strict) {
    const exactRx = new RegExp("\\b" + escapeRegExp(word) + "\\b", "i");
    const exactLine = lines.find((l) => exactRx.test(l));
    if (exactLine) return exactLine.trim();
  }
  const rx = wordRegex(word, strict);
  const line = lines.find((l) => rx.test(l)) || lines[0] || "";
  return line.trim();
}

// Wrap the matched word in <mark> for display. The line must already be censored by
// the caller (censoring is a game concern, not a matching one). Mark the real word
// when the line actually contains it; only fall back to the looser stem variants when
// it doesn't, so "babe" never highlights "baby".
export function highlightWord(line, word, strict) {
  let body;
  if (strict) body = escapeRegExp(word);
  else {
    const exactRx = new RegExp("\\b" + escapeRegExp(word) + "\\b", "i");
    body = exactRx.test(line) ? escapeRegExp(word) : wordVariants(word).join("|");
  }
  const rx = new RegExp("\\b(" + body + ")\\b", "ig");
  return escapeHtml(line).replace(rx, "<mark>$1</mark>");
}

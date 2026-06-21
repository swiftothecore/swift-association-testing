// localStorage persistence: high scores, stats, achievements, difficulty.
// All functions are pure of app state — the active mode and the earned-
// achievements map are passed in explicitly rather than closed over.
import {
  HS_KEY, RECORDS_KEY, HISTORY_KEY, STATS_KEY, ACH_KEY, DIFF_KEY,
  DAILY_KEY, DAILY_BOARD_KEY, DAILY_STREAK_KEY, TYPES_KEY, TALLY_KEY,
  SETTINGS_KEY, METRICS_KEY, APP_PREFIX, DEFAULT_SETTINGS,
  MODES, MODE_ORDER, TOTAL_ROUNDS,
} from "./config.js";

const HISTORY_CAP = 1000;   // keep the most recent N runs; older ones drop off

const STREAK_THRESHOLD = 7; // score >= this counts toward a streak

/* ---------- Stats (separate per mode) ---------- */
// Medium keeps the legacy key for back-compat; other modes get a suffix.
export function statsKey(mode) { return mode === "medium" ? STATS_KEY : STATS_KEY + "." + mode; }

export function loadStats(mode) {
  try {
    const raw = localStorage.getItem(statsKey(mode));
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.played === "number") return s;
    }
  } catch (e) { /* ignore */ }
  return { played: 0, best: 0, totalScore: 0, scoreCounts: Array(14).fill(0), lastPlayed: null, currentStreak: 0, maxStreak: 0, bestInRow: 0 };
}

export function saveStats(s, mode) {
  try { localStorage.setItem(statsKey(mode), JSON.stringify(s)); } catch (e) { /* ignore */ }
}

// Total games across every mode — for the global "play N games" achievements.
export function totalPlayed() { return MODE_ORDER.reduce((n, m) => n + loadStats(m).played, 0); }

// bestRun = the game's longest correct-in-a-row (gameMaxStreak); we keep the
// lifetime max per mode for the "Best in a row" stat.
// `countBest` (default true) — when false (a hint was used this run), the play still
// counts toward played/average/distribution, but it can't set any "best" (best score,
// best-in-a-row, or the non-zero-game streak). Keeps hinted runs out of the records.
export function updateStats(gameScore, mode, bestRun, countBest = true) {
  const s = loadStats(mode);
  s.played += 1;
  s.totalScore += gameScore;
  s.scoreCounts[gameScore] = (s.scoreCounts[gameScore] || 0) + 1;
  s.lastPlayed = new Date().toISOString().slice(0, 10);
  if (countBest) {
    s.best = Math.max(s.best, gameScore);
    s.bestInRow = Math.max(s.bestInRow || 0, bestRun || 0);
    if (gameScore >= STREAK_THRESHOLD) {
      s.currentStreak += 1;
      s.maxStreak = Math.max(s.maxStreak, s.currentStreak);
    } else {
      s.currentStreak = 0;
    }
  }
  saveStats(s, mode);
  return s;
}

/* ---------- Achievements ---------- */
export function loadAchievements() {
  try {
    const raw = localStorage.getItem(ACH_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && typeof o === "object") return o; }
  } catch (e) { /* ignore */ }
  return {};
}
export function saveAchievements(earned) {
  try { localStorage.setItem(ACH_KEY, JSON.stringify(earned)); } catch (e) { /* ignore */ }
}

/* ---------- Game types ever played (for "Hits Different") ---------- */
// Value: { classic?: true, infinite?: true, daily?: true }
export function loadTypesPlayed() {
  try {
    const raw = localStorage.getItem(TYPES_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && typeof o === "object") return o; }
  } catch (e) { /* ignore */ }
  return {};
}
// Mark a game type as played; returns the updated record.
export function markTypePlayed(type) {
  const o = loadTypesPlayed();
  if (o[type]) return o;
  o[type] = true;
  try { localStorage.setItem(TYPES_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
  return o;
}

/* ---------- Lifetime per-song / per-word tally ---------- */
// One record across every game type & difficulty. Powers Favourite Song,
// Songs Discovered, Favourite Album, Nemesis Word — and later "I Hate It Here".
// Key: swiftSongAssociation.songTally
//   songs:  { [title]:  correctCount }  — times this song was a correct answer
//   albums: { [album]:  correctCount }  — times a correct answer came from this album
//   words:  { [word]:   correctCount }  — times this prompt word was answered correctly
//   misses: { [word]:   missCount }     — times this prompt word was missed (wrong/timeout)
export function loadSongTally() {
  try {
    const raw = localStorage.getItem(TALLY_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") {
        return { songs: o.songs || {}, albums: o.albums || {}, words: o.words || {}, misses: o.misses || {} };
      }
    }
  } catch (e) { /* ignore */ }
  return { songs: {}, albums: {}, words: {}, misses: {} };
}
export function saveSongTally(t) {
  try { localStorage.setItem(TALLY_KEY, JSON.stringify(t)); } catch (e) { /* ignore */ }
}
// Fold one finished game into the lifetime tally. `rounds` is an array of
// { correct, title, album, word } — one entry per played round. A correct round
// credits its song + album + prompt word; a missed round blames its prompt word.
// Returns the updated tally.
export function recordGameTally(rounds) {
  const t = loadSongTally();
  for (const r of rounds) {
    if (!r) continue;
    if (r.correct) {
      if (r.title) t.songs[r.title] = (t.songs[r.title] || 0) + 1;
      if (r.album) t.albums[r.album] = (t.albums[r.album] || 0) + 1;
      if (r.word) t.words[r.word] = (t.words[r.word] || 0) + 1;
    } else if (r.word) {
      t.misses[r.word] = (t.misses[r.word] || 0) + 1;
    }
  }
  saveSongTally(t);
  return t;
}

/* ---------- Lifetime metrics (cross-game, cross-mode counters) ---------- */
// One record across every game type & difficulty, folded once per finished game.
// Backs the Stats "by the numbers" block: fastest/avg answer, accuracy, lyric lines,
// daily totals. Kept separate from per-mode stats so it spans classic/infinite/daily.
//   fastestMs   — fastest single correct answer in a timed mode (null = none yet)
//   answerSumMs — total time spent on timed rounds (for the average)
//   answerN     — count of timed rounds counted (for the average)
//   lyricLines  — lifetime lyric lines recalled
//   versePerfect — lifetime word-perfect-or-better lines (the verse-bonus prestige metric)
//   wholeVerses  — lifetime whole-verse (WHOLE_VERSE_LINES-line) recalls
//   bestVerseBonus — most verse-bonus points earned in a single game
//   roundsTotal / roundsCorrect — lifetime rounds played / answered right (accuracy)
//   dailyPlayed / dailyPerfect  — lifetime daily challenges finished / perfected
export function loadMetrics() {
  const d = { fastestMs: null, answerSumMs: 0, answerN: 0, lyricLines: 0, versePerfect: 0, wholeVerses: 0, bestVerseBonus: 0, roundsTotal: 0, roundsCorrect: 0, dailyPlayed: 0, dailyPerfect: 0, noTimeoutStreak: 0 };
  try {
    const raw = localStorage.getItem(METRICS_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && typeof o === "object") return { ...d, ...o }; }
  } catch (e) { /* ignore */ }
  return d;
}
export function saveMetrics(m) {
  try { localStorage.setItem(METRICS_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
}
// Fold one finished game into the lifetime metrics. `g` carries the per-game totals
// gathered during play (see app.js submitAnswer / endGame). Returns the updated record.
export function recordGameMetrics(g) {
  const m = loadMetrics();
  m.roundsTotal += g.rounds || 0;
  m.roundsCorrect += g.correct || 0;
  m.lyricLines += g.lyricLines || 0;
  m.versePerfect += g.versePerfect || 0;
  m.wholeVerses += g.wholeVerses || 0;
  if ((g.verseBonus || 0) > (m.bestVerseBonus || 0)) m.bestVerseBonus = g.verseBonus;
  m.answerSumMs += g.timeSumMs || 0;
  m.answerN += g.timedRounds || 0;
  if (g.fastestMs != null && (m.fastestMs == null || g.fastestMs < m.fastestMs)) m.fastestMs = g.fastestMs;
  if (g.isDaily) { m.dailyPlayed += 1; if (g.dailyPerfect) m.dailyPerfect += 1; }
  // Consecutive non-infinite games finished with zero timeouts (backs "Fearless (Taylor's
  // Version)"). Infinite games are ignored entirely — they neither extend nor break it.
  if (!g.isInfinite) m.noTimeoutStreak = (g.timeouts === 0) ? (m.noTimeoutStreak || 0) + 1 : 0;
  saveMetrics(m);
  return m;
}

// The old fake-celebrity "Hall of Fame" (HS_KEY) is fully retired — no reader or
// writer remains. Any stale highscores.* keys from older versions are swept by
// resetRecords() and still round-trip through export/import (they're under APP_PREFIX).

/* ---------- Personal records (your own best runs, per mode) ---------- */
// Same mode-token scheme as stats/high-scores: medium = unsuffixed legacy-style key,
// every other mode (incl. infinite "inf-<variant>-<mode>" tokens) gets a suffix.
// Entry shape: { score, date } where date is a "YYYY-MM-DD" string (or null for the
// migrated "best so far" seed). For infinite, score holds rounds survived.
export function recordsKey(mode) { return mode === "medium" ? RECORDS_KEY : RECORDS_KEY + "." + mode; }
export function loadRecords(mode) {
  try {
    const raw = localStorage.getItem(recordsKey(mode));
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return a; }
  } catch (e) { /* ignore */ }
  return [];
}
// One-time migration: seed each mode's records from the player's *pre-existing* best
// (their stats), so returning players keep their real achievement as a dateless "best
// so far" entry — no fake celebrity names. Run once at startup, BEFORE any game folds a
// new score into stats, so the seed reflects history rather than the run in progress.
// Idempotent: only seeds a mode that has a best but no records yet.
export function migrateRecordsFromStats() {
  const tokens = MODE_ORDER.slice();
  for (const v of ["3lives", "sudden"]) for (const m of MODE_ORDER) tokens.push("inf-" + v + "-" + m);
  for (const mode of tokens) {
    if (localStorage.getItem(recordsKey(mode)) != null) continue;   // already has records
    const best = loadStats(mode).best;
    if (best > 0) saveRecords([{ score: best, date: null }], mode);
  }
}
export function saveRecords(list, mode) {
  try { localStorage.setItem(recordsKey(mode), JSON.stringify(list)); } catch (e) { /* ignore */ }
}
// Ranking for a mode's records: higher score first, then — at an equal score — the
// FASTER completion time (a run with a recorded time outranks one without, so a real
// timed run supersedes the dateless migration seed), then — when score AND time are
// identical — the bigger verse bonus (a second-order prestige tie-break), then earliest
// date first. `verse` is optional/back-compat (a missing value counts as 0).
function cmpRecords(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const at = a.time, bt = b.time;
  if (at != null && bt != null && at !== bt) return at - bt;   // faster wins
  if (at != null && bt == null) return -1;
  if (at == null && bt != null) return 1;
  const av = a.verse || 0, bv = b.verse || 0;
  if (av !== bv) return bv - av;                                // more verse bonus wins
  const ad = a.date || "", bd = b.date || "";
  return ad < bd ? -1 : ad > bd ? 1 : 0;
}
// Insert a finished run; keep the top 5 per cmpRecords. `time` (completion seconds) is
// optional — only timed classic modes pass it; relaxed/infinite omit it (no speed tie-break).
// `verse` (verse-bonus points) is the second-order tie-break, only used at equal score+time.
// Returns { list, rank, isBest }; rank is the just-played run's 0-based index (-1 if off-board).
export function insertRecord(mode, score, date, time = null, verse = 0) {
  const entry = { score, date, __this: true };
  if (time != null) entry.time = time;
  if (verse) entry.verse = verse;
  const top = loadRecords(mode).concat([entry]).sort(cmpRecords).slice(0, 5);
  const rank = top.indexOf(entry);
  saveRecords(top.map((e) => {                                  // strip the transient __this
    const o = { score: e.score, date: e.date };
    if (e.time != null) o.time = e.time;
    if (e.verse) o.verse = e.verse;
    return o;
  }), mode);
  return { list: top, rank, isBest: rank === 0 };
}

/* ---------- Run history (chronological log of every finished run) ---------- */
// One flat, newest-first array across all modes/game types. Entry:
//   { s, c, n, m, t, d }  → score (headline number), correct, rounds played,
//   mode token, game type, ISO datetime. Capped to the most recent HISTORY_CAP.
export function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return a; }
  } catch (e) { /* ignore */ }
  return [];
}
export function appendHistory(entry) {
  const list = loadHistory();
  list.unshift(entry);                       // newest first
  if (list.length > HISTORY_CAP) list.length = HISTORY_CAP;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  return list;
}

/* ---------- Notebook signature (set once, reused on every record) ---------- */
export function getPlayerName() { return (loadSettings().playerName || "").trim(); }
export function setPlayerName(name) {
  const s = loadSettings();
  s.playerName = (name || "").trim().slice(0, 20);
  saveSettings(s);
  return s.playerName;
}

/* ---------- Profile polaroid (a center-cropped photo data-URL) ---------- */
// Lives in settings, so it's wiped by a settings-reset and untouched by a
// records-reset — and rides along in an export backup. "" means no photo.
export function getAvatar() { return loadSettings().avatar || ""; }
export function setAvatar(dataUrl) {
  const s = loadSettings();
  s.avatar = dataUrl || "";
  saveSettings(s);
  return s.avatar;
}

/* ---------- Difficulty ---------- */
export function loadMode() {
  try {
    const id = localStorage.getItem(DIFF_KEY);
    if (id && MODES[id]) return MODES[id];
  } catch (e) { /* ignore */ }
  return MODES.medium;
}

/* ---------- Daily challenge ---------- */
// Per-day played result. Key: swiftSongAssociation.daily.YYYY-MM-DD
// Value: { score, roundResults: boolean[], roundAlbums: (string|null)[] }
export function loadDailyResult(dateStr) {
  try {
    const raw = localStorage.getItem(DAILY_KEY + "." + dateStr);
    if (raw) { const o = JSON.parse(raw); if (o && typeof o.score === "number") return o; }
  } catch (e) { /* ignore */ }
  return null;
}
export function saveDailyResult(dateStr, data) {
  try { localStorage.setItem(DAILY_KEY + "." + dateStr, JSON.stringify(data)); } catch (e) { /* ignore */ }
}
// Drop just one day's saved daily result (dev helper) — lets a single day be
// replayed without nuking the streak the way resetDaily() does.
export function clearDailyResult(dateStr) {
  try { localStorage.removeItem(DAILY_KEY + "." + dateStr); } catch (e) { /* ignore */ }
}

// Lifetime daily totals derived from the per-day result keys (the authoritative
// record — saved on every daily completion). The `metrics` counters miss any
// dailies finished before that store existed; these keys don't, so the Stats
// "by the numbers" daily figures count from here instead.
//   played   — distinct days a daily was completed
//   perfect  — of those, days scored 13/13
export function dailyTotals() {
  let played = 0, perfect = 0;
  const prefix = DAILY_KEY + ".";
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      try {
        const o = JSON.parse(localStorage.getItem(k));
        if (o && typeof o.score === "number") {
          played += 1;
          if (o.score === TOTAL_ROUNDS) perfect += 1;
        }
      } catch (e) { /* skip malformed entry */ }
    }
  } catch (e) { /* ignore */ }
  return { played, perfect };
}

// The per-day daily fake board (DAILY_BOARD_KEY) is retired — daily now shows a
// personal result + streak + share. Stale dailyBoard.* keys are swept by resetDaily().

/* ---------- Daily streak (consecutive calendar days played) ---------- */
// Key: swiftSongAssociation.dailyStreak  Value: { current, best, lastPlayed }
const yesterdayOf = (dateStr) => {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
export function loadDailyStreak() {
  try {
    const raw = localStorage.getItem(DAILY_STREAK_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && typeof o.current === "number") return o; }
  } catch (e) { /* ignore */ }
  return { current: 0, best: 0, lastPlayed: null };
}
export function saveDailyStreak(d) {
  try { localStorage.setItem(DAILY_STREAK_KEY, JSON.stringify(d)); } catch (e) { /* ignore */ }
}
// Record a completed daily play on `dateStr`. Consecutive days extend the streak;
// a gap resets it to 1. Idempotent for the same day (the one-play gate already
// guarantees one call/day, but guard anyway). Returns the updated record.
export function bumpDailyStreak(dateStr) {
  const d = loadDailyStreak();
  if (d.lastPlayed === dateStr) return d;
  d.current = d.lastPlayed === yesterdayOf(dateStr) ? d.current + 1 : 1;
  d.best = Math.max(d.best, d.current);
  d.lastPlayed = dateStr;
  saveDailyStreak(d);
  return d;
}
// The streak as it stands *today*: alive only if the last play was today or
// yesterday, otherwise the run is broken (current shown as 0, best preserved).
export function effectiveDailyStreak(today) {
  const d = loadDailyStreak();
  if (!d.lastPlayed) return { current: 0, best: d.best, lastPlayed: null, playedToday: false };
  const alive = d.lastPlayed === today || d.lastPlayed === yesterdayOf(today);
  return { current: alive ? d.current : 0, best: d.best, lastPlayed: d.lastPlayed, playedToday: d.lastPlayed === today };
}

/* ---------- Settings ---------- */
// DEFAULT_SETTINGS is merged under the stored object, so a newly-added default
// key fills in for existing players without a migration step.
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && typeof o === "object") return { ...DEFAULT_SETTINGS, ...o }; }
  } catch (e) { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

/* ---------- Data management (export / import / reset) ---------- */
// Every key this app writes lives under APP_PREFIX; these helpers operate on that
// namespace only, so a backup never drags in unrelated localStorage.
function appKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(APP_PREFIX)) keys.push(k);
  }
  return keys;
}
// Remove a key family: the exact key plus any "<base>.<suffix>" variants
// (e.g. highscores + highscores.hard + highscores.inf-3lives-easy).
function removeByPrefix(base) {
  for (const k of appKeys()) if (k === base || k.startsWith(base + ".")) localStorage.removeItem(k);
}

// A plain { key: rawString } snapshot of every app key, for a JSON backup.
export function exportData() {
  const out = {};
  for (const k of appKeys()) out[k] = localStorage.getItem(k);
  return out;
}
// Restore from such a snapshot. Only keys in the app namespace are written.
// Returns the number of keys restored.
export function importData(obj) {
  if (!obj || typeof obj !== "object") return 0;
  let n = 0;
  for (const k in obj) {
    if (!k.startsWith(APP_PREFIX) || typeof obj[k] !== "string") continue;
    try { localStorage.setItem(k, obj[k]); n++; } catch (e) { /* ignore */ }
  }
  return n;
}

// Per-category resets (the danger zone). Each clears one family of keys.
// Sweeps the records, the run history, and the dormant legacy fake-celebrity board.
export function resetRecords() {
  removeByPrefix(RECORDS_KEY);
  try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* ignore */ }
  removeByPrefix(HS_KEY);
}
export function resetStatsAll()   { removeByPrefix(STATS_KEY); try { localStorage.removeItem(METRICS_KEY); } catch (e) { /* ignore */ } }
export function resetAchievements() { try { localStorage.removeItem(ACH_KEY); localStorage.removeItem(TYPES_KEY); } catch (e) { /* ignore */ } }
export function resetTally()      { try { localStorage.removeItem(TALLY_KEY); } catch (e) { /* ignore */ } }
export function resetDaily() {
  try { localStorage.removeItem(DAILY_STREAK_KEY); } catch (e) { /* ignore */ }
  removeByPrefix(DAILY_KEY);
  removeByPrefix(DAILY_BOARD_KEY);
}
// Wipe everything (settings included). Caller should reload afterward.
export function clearAllData() { for (const k of appKeys()) localStorage.removeItem(k); }

// localStorage persistence: high scores, stats, achievements, difficulty.
// All functions are pure of app state — the active mode and the earned-
// achievements map are passed in explicitly rather than closed over.
import {
  HS_KEY, RECORDS_KEY, STATS_KEY, ACH_KEY, DIFF_KEY,
  DAILY_KEY, DAILY_BOARD_KEY, DAILY_STREAK_KEY, TYPES_KEY, TALLY_KEY,
  SETTINGS_KEY, APP_PREFIX, DEFAULT_SETTINGS,
  MODES, MODE_ORDER,
} from "./config.js";

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
  return { played: 0, best: 0, totalScore: 0, scoreCounts: Array(14).fill(0), lastPlayed: null, currentStreak: 0, maxStreak: 0 };
}

export function saveStats(s, mode) {
  try { localStorage.setItem(statsKey(mode), JSON.stringify(s)); } catch (e) { /* ignore */ }
}

// Total games across every mode — for the global "play N games" achievements.
export function totalPlayed() { return MODE_ORDER.reduce((n, m) => n + loadStats(m).played, 0); }

export function updateStats(gameScore, mode) {
  const s = loadStats(mode);
  s.played += 1;
  s.best = Math.max(s.best, gameScore);
  s.totalScore += gameScore;
  s.scoreCounts[gameScore] = (s.scoreCounts[gameScore] || 0) + 1;
  s.lastPlayed = new Date().toISOString().slice(0, 10);
  if (gameScore >= STREAK_THRESHOLD) {
    s.currentStreak += 1;
    s.maxStreak = Math.max(s.maxStreak, s.currentStreak);
  } else {
    s.currentStreak = 0;
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
//   misses: { [word]:   missCount }     — times this prompt word was missed (wrong/timeout)
export function loadSongTally() {
  try {
    const raw = localStorage.getItem(TALLY_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") {
        return { songs: o.songs || {}, albums: o.albums || {}, misses: o.misses || {} };
      }
    }
  } catch (e) { /* ignore */ }
  return { songs: {}, albums: {}, misses: {} };
}
export function saveSongTally(t) {
  try { localStorage.setItem(TALLY_KEY, JSON.stringify(t)); } catch (e) { /* ignore */ }
}
// Fold one finished game into the lifetime tally. `rounds` is an array of
// { correct, title, album, word } — one entry per played round. A correct round
// credits its song + album; a missed round blames its prompt word. Returns the
// updated tally.
export function recordGameTally(rounds) {
  const t = loadSongTally();
  for (const r of rounds) {
    if (!r) continue;
    if (r.correct) {
      if (r.title) t.songs[r.title] = (t.songs[r.title] || 0) + 1;
      if (r.album) t.albums[r.album] = (t.albums[r.album] || 0) + 1;
    } else if (r.word) {
      t.misses[r.word] = (t.misses[r.word] || 0) + 1;
    }
  }
  saveSongTally(t);
  return t;
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
// Insert a finished run; keep the top 5 by score (tie-break: earliest date first, so the
// run that *first* reached a score outranks a later tie). Returns { list, rank, isBest }
// where rank is the just-played run's 0-based index (or -1 if it fell off the top 5).
export function insertRecord(mode, score, date) {
  const entry = { score, date, __this: true };
  const top = loadRecords(mode).concat([entry]).sort((a, b) =>
    b.score - a.score || ((a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0)
  ).slice(0, 5);
  const rank = top.indexOf(entry);
  saveRecords(top.map(({ score, date }) => ({ score, date })), mode);   // strip the transient __this
  return { list: top, rank, isBest: rank === 0 };
}

/* ---------- Notebook signature (set once, reused on every record) ---------- */
export function getPlayerName() { return (loadSettings().playerName || "").trim(); }
export function setPlayerName(name) {
  const s = loadSettings();
  s.playerName = (name || "").trim().slice(0, 20);
  saveSettings(s);
  return s.playerName;
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
// Sweeps both the live records and the dormant legacy fake-celebrity board.
export function resetRecords() { removeByPrefix(RECORDS_KEY); removeByPrefix(HS_KEY); }
export function resetStatsAll()   { removeByPrefix(STATS_KEY); }
export function resetAchievements() { try { localStorage.removeItem(ACH_KEY); localStorage.removeItem(TYPES_KEY); } catch (e) { /* ignore */ } }
export function resetTally()      { try { localStorage.removeItem(TALLY_KEY); } catch (e) { /* ignore */ } }
export function resetDaily() {
  try { localStorage.removeItem(DAILY_STREAK_KEY); } catch (e) { /* ignore */ }
  removeByPrefix(DAILY_KEY);
  removeByPrefix(DAILY_BOARD_KEY);
}
// Wipe everything (settings included). Caller should reload afterward.
export function clearAllData() { for (const k of appKeys()) localStorage.removeItem(k); }

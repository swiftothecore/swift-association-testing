// localStorage persistence: high scores, stats, achievements, difficulty.
// All functions are pure of app state — the active mode and the earned-
// achievements map are passed in explicitly rather than closed over.
import {
  HS_KEY, STATS_KEY, ACH_KEY, DIFF_KEY,
  DAILY_KEY, DAILY_BOARD_KEY, DAILY_STREAK_KEY, TYPES_KEY, TALLY_KEY,
  MODES, MODE_ORDER, DEFAULT_PODIUM, DAILY_DEFAULT_PODIUM,
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

/* ---------- High scores (separate board per mode) ---------- */
// Medium keeps the legacy key for back-compat; other modes get a suffix.
export function hsKey(mode) { return mode === "medium" ? HS_KEY : HS_KEY + "." + mode; }
export function loadHighScores(mode, fallback = DEFAULT_PODIUM) {
  try {
    const raw = localStorage.getItem(hsKey(mode));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (e) { /* ignore */ }
  return fallback.slice();
}
export function saveHighScores(list, mode) {
  try { localStorage.setItem(hsKey(mode), JSON.stringify(list)); } catch (e) { /* ignore */ }
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

// Per-day local leaderboard. Key: swiftSongAssociation.dailyBoard.YYYY-MM-DD
// Value: { name, score }[] sorted descending, max 5.
export function loadDailyBoard(dateStr) {
  try {
    const raw = localStorage.getItem(DAILY_BOARD_KEY + "." + dateStr);
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) return a; }
  } catch (e) { /* ignore */ }
  return DAILY_DEFAULT_PODIUM.slice();
}
export function saveDailyBoard(list, dateStr) {
  try { localStorage.setItem(DAILY_BOARD_KEY + "." + dateStr, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

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

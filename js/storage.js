// localStorage persistence: high scores, stats, achievements, difficulty.
// All functions are pure of app state — the active mode and the earned-
// achievements map are passed in explicitly rather than closed over.
import {
  HS_KEY, STATS_KEY, ACH_KEY, DIFF_KEY,
  MODES, MODE_ORDER, DEFAULT_PODIUM,
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

/* ---------- High scores (separate board per mode) ---------- */
// Medium keeps the legacy key for back-compat; other modes get a suffix.
export function hsKey(mode) { return mode === "medium" ? HS_KEY : HS_KEY + "." + mode; }
export function loadHighScores(mode) {
  try {
    const raw = localStorage.getItem(hsKey(mode));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (e) { /* ignore */ }
  return DEFAULT_PODIUM.slice();
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

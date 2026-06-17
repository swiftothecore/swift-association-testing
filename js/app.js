"use strict";
import { $, escapeRegExp, escapeHtml, prefersReducedMotion, shuffle, chance, normalizeTitle, normalizeLyric, fuzzySubstringRatio, levenshtein, mulberry32, dailySeed } from "./util.js";
import {
  TOTAL_ROUNDS, RECENT_WINDOW, DIFF_KEY,
  MODES, MODE_ORDER,
  ERAS, TENDER_ERAS, FINALE_ERAS,
  ALBUM_COLORS, CB_ALBUM_COLORS, STUDIO_ALBUMS, TITLE_ALIASES,
  ACHIEVEMENTS, ACH_ICONS, ACH_BY_ID,
  PEN_SVG, STAR_SVG, SPARKLE_SVG, DOODLE_SVG,
} from "./config.js";
import { buildBraceletSVG } from "./bracelet.js";
import {
  loadRecords, insertRecord, migrateRecordsFromStats, getPlayerName, setPlayerName,
  loadHistory, appendHistory,
  loadStats, updateStats, totalPlayed,
  loadAchievements, saveAchievements,
  loadMode,
  loadDailyResult, saveDailyResult,
  bumpDailyStreak, effectiveDailyStreak,
  markTypePlayed,
  loadSongTally, recordGameTally,
  loadSettings, saveSettings,
  exportData, importData,
  resetRecords, resetStatsAll, resetAchievements, resetTally, resetDaily, clearAllData,
} from "./storage.js";

/* ---------- Constants & state ---------- */
// Lyric-line answering: a typed line must be at least this many words (so a bare
// prompt-word echo — or a token three-word stub — can't pass), and must match a real
// word-bearing lyric line at or above this fuzzy similarity (1 = verbatim; lower
// tolerates typos / a partial line). The 4-word floor nudges players to recall more
// than a fragment; verse-bonus grading rewards fuller lines on top of that.
const MIN_LYRIC_WORDS = 4;
const FUZZY_THRESHOLD = 0.8;
// Recall grading: a typed line covering this fraction of the matched real line earns
// a verse bonus; at the "perfect" mark (or verbatim) it earns the full bonus.
const RECALL_GOOD = 0.5;
const RECALL_PERFECT = 0.9;

let currentMode = MODES.medium;
let wordBuckets = { easy: [], all: [], hard: [], ultra: [] };
let recentEras = [];

let allSongs = [];
let titleIndex = new Map();   // normalizeTitle(title|alias) -> song, built in loadData
let playableWords = [];
let score = 0;
let round = 0;
let usedWords = [];
let roundResults = [];   // per-round true/false for the bracelet
let roundAlbums = [];    // per-round album of the picked song (for the final bracelet)
let roundWords = [];     // per-round prompt word (for the lifetime tally / Nemesis Word)
let roundSongs = [];     // per-round answered song title, null on a miss (lifetime tally)
let gameType = "classic";       // "classic" (fixed 13) | "infinite" (until lives run out) | "daily"
let infiniteVariant = "3lives"; // "3lives" | "sudden"
let lives = 0;                  // remaining lives in infinite mode
let dailyRng = null;            // seeded PRNG, non-null only during a daily game
let currentWord = "";
let currentSongs = [];
let dropdownItems = [];
let activeIndex = -1;
let timerId = null;
let countdownId = null;
let timerStart = 0;
let roundLocked = false;
let debounceId = null;
let statsBackTarget = "start";
let settings = { ...{} };       // populated from loadSettings() in init
let pausedRemaining = null;     // timer seconds left when the settings modal paused play

/* ---------- Settings: effective getters & application ---------- */
// Reduced motion: the setting overrides the OS preference ("on"/"off"); "auto"
// follows the system. Used everywhere motion is gated in JS.
function motionReduced() {
  if (settings.reduceMotion === "on") return true;
  if (settings.reduceMotion === "off") return false;
  return prefersReducedMotion();
}
// "Instant" animation speed skips the JS-timed animations (page flip, pen circle).
function animInstant() { return settings.animSpeed === "instant"; }
// Scale factor for JS animation delays: instant→0, fast→0.5, normal→1.
function animScale() { return settings.animSpeed === "instant" ? 0 : settings.animSpeed === "fast" ? 0.5 : 1; }
// The active album→colour palette (colour-blind variant when that setting is on).
function albumPalette() { return settings.colorBlindAlbums ? CB_ALBUM_COLORS : ALBUM_COLORS; }
function albumColor(name) { return albumPalette()[name] || null; }

// Push the settings that are realised via CSS onto <body> data-attributes, and
// keep the easter-egg / motion code paths reading the live `settings` object.
function applySettings() {
  const body = document.body;
  const rm = settings.reduceMotion === "on" ? "on"
           : settings.reduceMotion === "off" ? "off"
           : (prefersReducedMotion() ? "on" : "off");
  body.setAttribute("data-reduce-motion", rm);
  body.setAttribute("data-anim-speed", settings.animSpeed || "normal");
  if (settings.highContrast) body.setAttribute("data-contrast", "high");
  else body.removeAttribute("data-contrast");
}
// Remember the last-played type so defaultGameType:"last" can restore it next launch.
function rememberGameType(t) {
  if (settings.lastGameType !== t) { settings.lastGameType = t; saveSettings(settings); }
}

/* ---------- DOM ---------- */
const screens = {
  start: $("screen-start"),
  game: $("screen-game"),
  results: $("screen-results"),
  stats: $("screen-stats"),
  records: $("screen-records"),
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

/* ---------- Era selection ---------- */
function pickEra() {
  let pool;
  // Round-5/round-13 biases apply to any fixed 13-round run (classic + daily).
  const fixedRun = gameType === "classic" || gameType === "daily";
  if (fixedRun && round === 5) pool = TENDER_ERAS;
  else if (fixedRun && round === TOTAL_ROUNDS) pool = FINALE_ERAS;
  else pool = ERAS.filter((e) => !recentEras.includes(e));
  if (!pool.length) pool = ERAS;
  const rng = dailyRng || Math.random;
  const era = pool[Math.floor(rng() * pool.length)];
  recentEras.push(era);
  if (recentEras.length > 3) recentEras.shift();
  return era;
}
function applyEra(era) { document.body.setAttribute("data-era", era); }

/* ---------- Matching helpers ---------- */
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
const INFLECT = "(?:ing|in|ings|ed|er|ers|es|y|ies|ied|ier|iest|able)";
function wordVariants(word) {
  const w = word.toLowerCase();
  const alts = [escapeRegExp(w) + "[a-z']*"];   // base: word + any added tail (unchanged behaviour)
  if (w.length >= 4 && w.endsWith("e")) alts.push(escapeRegExp(w.slice(0, -1)) + INFLECT);
  if (w.length >= 3 && /[^aeiou]y$/.test(w)) alts.push(escapeRegExp(w.slice(0, -1) + "i") + INFLECT);
  if (w.length >= 3 && /[^aeiou][aeiou][^aeiouwxy]$/.test(w)) alts.push(escapeRegExp(w + w.slice(-1)) + INFLECT);
  return alts;
}
// Lenient (default) also matches the inflected forms above; strict (Ultra) requires
// the exact word. Defaults to the active mode.
function wordRegex(word, strict) {
  if (strict === undefined) strict = currentMode.strict;
  if (strict) return new RegExp("\\b" + escapeRegExp(word) + "\\b", "i");
  return new RegExp("\\b(?:" + wordVariants(word).join("|") + ")\\b", "i");
}
function songsContainingWord(word, strict) {
  const rx = wordRegex(word, strict);
  return allSongs.filter((s) => rx.test(s.lyrics));
}
// Valid answers for a round: lyrics contain the word and — when noTitle (Hard/
// Ultra) — the title does NOT, so you can't just name the obvious title song.
function validSongs(word, strict, noTitle) {
  const rx = wordRegex(word, strict);
  return allSongs.filter((s) => rx.test(s.lyrics) && !(noTitle && rx.test(s.title)));
}
// Songs whose TITLE contains the prompt word — the ones the Hard/Ultra "not in
// the title" rule blocks, so we can warn the player before they waste the clock.
function titleSongsForWord(word, strict) {
  const rx = wordRegex(word, strict);
  return allSongs.filter((s) => rx.test(s.title));
}
// Marginalia warning: in dropdown-less noTitle modes (Hard/Ultra), list the songs
// whose title holds the word so the player knows e.g. "All Too Well" won't be
// accepted. Modes WITH a dropdown (Normal) skip this — there the off-limits titles
// are greyed out in the dropdown and a reject-flash explains a blocked pick.
function renderExcludedNote() {
  const el = $("excludedNote");
  if (!el) return;
  if (!currentMode.noTitle || currentMode.dropdown) { el.style.display = "none"; el.innerHTML = ""; return; }
  const titles = titleSongsForWord(currentWord, currentMode.strict).map((s) => s.title);
  if (!titles.length) { el.style.display = "none"; el.innerHTML = ""; return; }
  const SHOWN = 3;
  const shown = titles.slice(0, SHOWN)
    .map((t) => `<span class="ex-title">${escapeHtml(t)}</span>`);
  if (titles.length > SHOWN) shown.push(`<span class="ex-more">+${titles.length - SHOWN} more</span>`);
  const lead = titles.length === 1 ? "can’t be played — it’s in the title" : "can’t be played — they’re in the title";
  el.innerHTML = `<span class="ex-lead">${lead}</span>${shown.join("")}`;
  el.style.display = "";
}
function extractLineWithWord(lyrics, word, strict) {
  const rx = wordRegex(word, strict);
  const lines = lyrics.split("\n");
  const line = lines.find((l) => rx.test(l)) || lines[0] || "";
  return line.trim();
}
function highlightWord(line, word, strict) {
  if (strict === undefined) strict = currentMode.strict;
  const body = strict ? escapeRegExp(word) : wordVariants(word).join("|");
  const rx = new RegExp("\\b(" + body + ")\\b", "ig");
  return escapeHtml(line).replace(rx, "<mark>$1</mark>");
}

/* ---------- Stats ---------- */
// Collated view across every difficulty: summed plays / score distribution, the best
// score of any mode, and the best correct-in-a-row reached in any mode.
function aggregateStats() {
  const agg = { played: 0, totalScore: 0, best: 0, bestInRow: 0, scoreCounts: [] };
  for (const m of MODE_ORDER) {
    const s = loadStats(m);
    agg.played += s.played;
    agg.totalScore += s.totalScore;
    agg.best = Math.max(agg.best, s.best);
    agg.bestInRow = Math.max(agg.bestInRow, s.bestInRow || 0);
    s.scoreCounts.forEach((c, i) => { agg.scoreCounts[i] = (agg.scoreCounts[i] || 0) + c; });
  }
  return agg;
}
// Resolve the Stats tab to open first from the saved preference: "all", "last"
// (the active difficulty), or a specific mode id.
function defaultStatsView() {
  const d = settings.defaultStatsTab;
  if (d === "all") return "all";
  if (d && d !== "last" && MODES[d]) return d;
  return currentMode.id;
}
function renderStats(lastScore, viewMode = defaultStatsView()) {
  const el = $("statsBody");
  const isAll = viewMode === "all";
  // mode tabs — an "All" collated tab plus each difficulty's separate stats
  const tabDefs = [{ m: "all", label: "All" }].concat(MODE_ORDER.map((m) => ({ m, label: MODES[m].label })));
  const tabs = `<div class="mode-tabs stats-tabs">` + tabDefs.map((t) =>
    `<button type="button" class="mode-tab${t.m === viewMode ? " active" : ""}" data-statmode="${t.m}">${t.label}</button>`
  ).join("") + `</div>`;

  const s = isAll ? aggregateStats() : loadStats(viewMode);
  let body;
  if (s.played === 0) {
    body = isAll
      ? `<p class="stats-empty">no games yet — start writing!</p>`
      : `<p class="stats-empty">no games yet in ${MODES[viewMode].label} — start writing!</p>`;
  } else {
    const avg = (s.totalScore / s.played).toFixed(1);
    const maxCount = Math.max(...s.scoreCounts, 1);
    // highlight the just-played bar on the mode that was played (and always in the All view)
    const youScore = (isAll || viewMode === currentMode.id) ? lastScore : null;
    const bars = s.scoreCounts.map((count, score) => {
      const h = Math.round((count / maxCount) * 56);
      const isYou = (score === youScore);
      return `<div class="histogram-col">
        <div class="histogram-bar${isYou ? " has-you" : ""}" style="height:${Math.max(h, count > 0 ? 4 : 2)}px"></div>
        <div class="histogram-score">${score}</div>
      </div>`;
    }).join("");
    // Best correct-in-a-row (lifetime, per mode; max across modes in the All view) +
    // perfect-game count. Same two cells for every tab.
    const streakRow = `<div class="streak-row">
        <div class="streak-cell"><span class="stat-val">${s.bestInRow || 0}</span><span class="stat-lbl">Best in a row</span></div>
        <div class="streak-cell"><span class="stat-val">${s.scoreCounts[TOTAL_ROUNDS] || 0}</span><span class="stat-lbl">Perfect games</span></div>
      </div>`;
    body = `
      <div class="stats-grid">
        <div class="stat-cell"><span class="stat-val">${s.played}</span><span class="stat-lbl">Played</span></div>
        <div class="stat-cell"><span class="stat-val">${s.best}</span><span class="stat-lbl">Best</span></div>
        <div class="stat-cell"><span class="stat-val">${avg}</span><span class="stat-lbl">Average</span></div>
      </div>
      ${streakRow}
      <p class="histogram-label">score distribution</p>
      <div class="histogram">${bars}</div>`;
  }

  el.innerHTML = tabs + body + lifetimeStatsHTML() + dailyStatsHTML() + infiniteStatsHTML() + achievementsGridHTML();
  el.querySelectorAll("[data-statmode]").forEach((b) =>
    b.addEventListener("click", () => renderStats(lastScore, b.dataset.statmode)));
}

// Highest-count entry of a {key: count} map (first one wins ties), or null if empty.
function topTallyEntry(obj) {
  let bestK = null, bestV = 0;
  for (const k in obj) if (obj[k] > bestV) { bestV = obj[k]; bestK = k; }
  return bestK === null ? null : { key: bestK, count: bestV };
}
// Exact-title → album lookup for the lifetime tally (tally keys are song.title).
function albumOfTitle(title) {
  const s = allSongs.find((x) => x.title === title);
  return s ? (s.album || null) : null;
}

// Lifetime catalogue stats — global (not per-mode), drawn from the per-song/per-word
// tally written in endGame. Shows under every Stats tab, like the daily streak.
// Three zones: a hero "songs discovered" meter (filled portion split into album-colour
// segments), two album-tinted keepsake cards, and a red-pen-circled nemesis word.
function lifetimeStatsHTML() {
  const t = loadSongTally();
  const discoveredTitles = Object.keys(t.songs);
  const discovered = discoveredTitles.length;
  const total = allSongs.length || 1;
  const favSong = topTallyEntry(t.songs);
  const favAlbum = topTallyEntry(t.albums);
  const nemesis = topTallyEntry(t.misses);
  const header = `<p class="histogram-label" style="margin-top:24px;">your catalogue</p>`;
  if (!discovered && !nemesis) {
    return header + `<p class="stats-empty">no answers logged yet — play a game to start your catalogue!</p>`;
  }
  const pct = Math.round((discovered / total) * 100);

  // Distinct discovered songs per album → album-rainbow meter segments, drawn in the
  // chronological album order songs appear in allSongs (covers any pseudo-albums too).
  const byAlbum = {};
  for (const title of discoveredTitles) {
    const a = albumOfTitle(title);
    if (a) byAlbum[a] = (byAlbum[a] || 0) + 1;
  }
  const albumOrder = [];
  for (const s of allSongs) if (s.album && !albumOrder.includes(s.album)) albumOrder.push(s.album);
  const segs = albumOrder.filter((a) => byAlbum[a]).map((a) =>
    `<div class="cat-seg" style="width:${(byAlbum[a] / total) * 100}%;background:${albumColor(a) || "var(--ink-soft)"}" title="${escapeHtml(a)}: ${byAlbum[a]}"></div>`
  ).join("");

  const songColor = favSong ? (albumColor(albumOfTitle(favSong.key)) || "var(--bead)") : "var(--bead)";
  const songAlbum = favSong ? albumOfTitle(favSong.key) : null;
  const albColor = favAlbum ? (albumColor(favAlbum.key) || "var(--ink-soft)") : "var(--ink-soft)";

  const meter = `
    <div class="cat-meter">
      <div class="cat-meter-head"><span>songs discovered</span><span>${pct}%</span></div>
      <div class="cat-meter-num"><b>${discovered}</b> / ${total} songs</div>
      <div class="cat-bar">${segs}</div>
    </div>`;

  // Words discovered — distinct prompt words answered correctly, out of the playable set.
  const wordsFound = Object.keys(t.words || {}).length;
  const wordTotal = playableWords.length || 1;
  const wordPct = Math.round((wordsFound / wordTotal) * 100);
  const wordMeter = `
    <div class="cat-meter">
      <div class="cat-meter-head"><span>words discovered</span><span>${wordPct}%</span></div>
      <div class="cat-meter-num"><b>${wordsFound}</b> / ${wordTotal} words</div>
      <div class="cat-bar"><div class="cat-seg" style="width:${(wordsFound / wordTotal) * 100}%;background:var(--ink-accent)"></div></div>
    </div>`;

  const songCard = `
    <div class="cat-card" style="border-left-color:${songColor}">
      <div class="cat-card-head"><span class="cat-star">${STAR_SVG}</span>favourite song</div>
      <div class="cat-card-val">${favSong ? escapeHtml(favSong.key) : "—"}</div>
      <div class="cat-card-sub" style="color:${songColor}">${favSong ? (songAlbum ? escapeHtml(songAlbum) + " · " : "") + "sung ×" + favSong.count : "play a game"}</div>
    </div>`;
  const albumCard = `
    <div class="cat-card" style="border-left-color:${albColor}">
      <div class="cat-card-head"><span class="cat-dot" style="background:${albColor}"></span>favourite album</div>
      <div class="cat-card-val">${favAlbum ? escapeHtml(favAlbum.key) : "—"}</div>
      <div class="cat-card-sub" style="color:${albColor}">${favAlbum ? "×" + favAlbum.count + " correct" : "play a game"}</div>
    </div>`;

  const nemesisBlock = `
    <div class="cat-nemesis">
      <div>
        <div class="cat-card-head">nemesis word</div>
        <div class="cat-nemesis-sub">${nemesis ? "missed ×" + nemesis.count : "no misses yet"}</div>
      </div>
      <div class="cat-nemesis-word">
        <span>${nemesis ? escapeHtml(nemesis.key) : "—"}</span>
        <svg viewBox="0 0 160 60" preserveAspectRatio="none" aria-hidden="true">
          <path d="M18 30 C18 12, 60 8, 90 10 C130 13, 152 22, 150 34 C148 48, 100 54, 64 52 C28 50, 12 42, 16 28" fill="none" stroke="rgba(178,58,58,0.7)" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      </div>
    </div>`;

  return header + `<div class="cat-wrap">${meter}${wordMeter}<div class="cat-cards">${songCard}${albumCard}</div>${nemesisBlock}</div>`;
}

// Daily-challenge streak — global (not per-mode), so it shows under every tab.
function dailyStatsHTML() {
  const d = effectiveDailyStreak(todayKey());
  if (!d.lastPlayed) {
    return `<p class="histogram-label" style="margin-top:24px;">daily challenge</p>` +
      `<p class="stats-empty">no daily runs yet — try today's Daily Challenge!</p>`;
  }
  const note = d.playedToday
    ? `<p class="daily-streak-note">✓ played today's challenge</p>`
    : `<p class="daily-streak-note">today's challenge awaits</p>`;
  return `<p class="histogram-label" style="margin-top:24px;">daily challenge</p>` +
    `<div class="streak-row">` +
    `<div class="streak-cell"><span class="stat-val">🔥 ${d.current}</span><span class="stat-lbl">day streak</span></div>` +
    `<div class="streak-cell"><span class="stat-val">${d.best}</span><span class="stat-lbl">best streak</span></div>` +
    `</div>` + note;
}

// Infinite runs aren't comparable to the 13-round game (scores can exceed 13 and
// the 0–13 histogram is meaningless), so they get their own compact summary:
// best rounds survived + games played per variant × difficulty.
// Each played variant×difficulty is a keepsake card (matching the catalogue's
// vocabulary): a bead motif for the lives mode, the best run as a hero number over a
// relative-to-the-leader strand meter, and the games-played count. Colour-coded by
// variant — gold for the forgiving 3-lives, danger-red for sudden death.
const INF_VARIANT_STYLE = {
  "3lives": { color: "#c08a2e", beads: 3 },
  sudden:   { color: "#b23a3a", beads: 1 },
};
function infiniteStatsHTML() {
  const entries = [];
  for (const variant of ["3lives", "sudden"]) {
    for (const m of MODE_ORDER) {
      const st = loadStats("inf-" + variant + "-" + m);
      if (st.played > 0) entries.push({ variant, mode: m, best: st.best, played: st.played });
    }
  }
  if (!entries.length) {
    return `<p class="histogram-label" style="margin-top:24px;">infinite</p>` +
      `<p class="stats-empty">no infinite runs yet — try Infinite mode!</p>`;
  }
  const maxBest = Math.max(...entries.map((e) => e.best), 1);
  const cards = entries.map((e) => {
    const sty = INF_VARIANT_STYLE[e.variant];
    const beads = Array.from({ length: sty.beads }, () => `<i></i>`).join("");
    const pct = Math.round((e.best / maxBest) * 100);
    return `
      <div class="inf-card" style="--spine:${sty.color}">
        <div class="inf-card-head"><span class="inf-beads">${beads}</span>${VARIANT_LABELS[e.variant]} · ${MODES[e.mode].label}</div>
        <div class="inf-card-main"><b>${e.best}</b><span>rounds survived</span></div>
        <div class="inf-card-meter"><div style="width:${pct}%"></div></div>
        <div class="inf-card-foot">${e.played} game${e.played === 1 ? "" : "s"} played</div>
      </div>`;
  }).join("");
  return `<p class="histogram-label" style="margin-top:24px;">infinite · best rounds survived</p>` +
    `<div class="inf-grid">${cards}</div>`;
}

/* ---------- Achievements ---------- */
let earnedAchievements = {};   // persisted: { id: "YYYY-MM-DD" }
let newlyUnlocked = [];        // ids unlocked this game (for the results recap)

function charmMarkup(icon) { return `<span class="charm" aria-hidden="true">${ACH_ICONS[icon]}</span>`; }

// Every unlock pops a toast. Already-earned ids no-op above, so a charm earned
// mid-game (toasted during play) never re-toasts at end-of-game. When several
// unlock at once (typically at endGame), the toasts stack in the corner.
// Longest run of consecutive CORRECT rounds that share one album (Time To Branch Out?).
function longestAlbumRun(results, albums) {
  let best = 0, run = 0, prev = null;
  for (let i = 0; i < results.length; i++) {
    if (results[i] && albums[i] && albums[i] === prev) run++;
    else if (results[i] && albums[i]) { run = 1; prev = albums[i]; }
    else { run = 0; prev = null; }
    best = Math.max(best, run);
  }
  return best;
}

// Distinct studio albums that produced a correct answer this game (The Eras Tour).
function distinctStudioAlbumsHit(results, albums) {
  const set = new Set();
  for (let i = 0; i < results.length; i++) {
    if (results[i] && albums[i] && STUDIO_ALBUMS.includes(albums[i])) set.add(albums[i]);
  }
  return set.size;
}

// Misses followed immediately by a correct answer — a "bounce back" (Shake It Off).
function recoveryCount(results) {
  let n = 0;
  for (let i = 1; i < results.length; i++) if (results[i] && !results[i - 1]) n++;
  return n;
}

// All three "Folklore love triangle" songs answered correctly this game (The Triangle).
function hasTriangle(songs) {
  return ["cardigan", "betty", "august"].every((t) => songs.includes(t));
}

// Longest run of consecutive correct answers whose titles start with B (My Mind Is Alive).
function longestBTitleRun(results, songs) {
  let best = 0, run = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i] && songs[i] && /^b/i.test(songs[i])) { run++; best = Math.max(best, run); }
    else run = 0;
  }
  return best;
}

// Lifetime missed rounds across the whole catalog tally (Death By A Thousand Cuts).
function totalLifetimeMisses() {
  const misses = loadSongTally().misses || {};
  return Object.values(misses).reduce((a, b) => a + b, 0);
}

function unlock(id) {
  if (!ACH_BY_ID[id] || earnedAchievements[id]) return;
  earnedAchievements[id] = new Date().toISOString().slice(0, 10);
  saveAchievements(earnedAchievements);
  newlyUnlocked.push(id);
  showToast(ACH_BY_ID[id]);
  // Karma: earning your 13th achievement is itself one (fires retroactively, any path).
  if (id !== "karma" && Object.keys(earnedAchievements).length >= 13) unlock("karma");
}

function showToast(a) {
  const layer = $("toastLayer");
  if (!layer) return;
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = charmMarkup(a.icon) +
    `<div><div class="t-label">achievement unlocked</div><div class="t-name">${escapeHtml(a.name)}</div></div>`;
  layer.appendChild(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 420);
  }, 3500);
}

function renderResultRecap() {
  const el = $("resultAchievements");
  if (!el) return;
  if (!newlyUnlocked.length) { el.style.display = "none"; el.innerHTML = ""; return; }
  const chips = newlyUnlocked.map((id) => {
    const a = ACH_BY_ID[id];
    return `<div class="ach-chip">${charmMarkup(a.icon)}<span class="nm">${escapeHtml(a.name)}</span></div>`;
  }).join("");
  el.innerHTML = `<div class="ach-recap-title">newly unlocked</div><div class="ach-recap-row">${chips}</div>`;
  el.style.display = "";
}

function achievementsGridHTML() {
  const items = ACHIEVEMENTS.map((a) => {
    if (earnedAchievements[a.id]) {
      return `<div class="ach">${charmMarkup(a.icon)}<div class="ach-text"><div class="ach-nm">${escapeHtml(a.name)}</div><div class="ach-dc">${escapeHtml(a.desc)}</div></div></div>`;
    }
    if (a.secret) {
      return `<div class="ach locked secret"><span class="charm-q" aria-hidden="true">?</span><div class="ach-text"><div class="ach-nm">???</div><div class="ach-dc">a secret charm</div></div></div>`;
    }
    return `<div class="ach locked">${charmMarkup(a.icon)}<div class="ach-text"><div class="ach-nm">${escapeHtml(a.name)}</div><div class="ach-dc">${escapeHtml(a.desc)}</div></div></div>`;
  }).join("");
  const earnedCount = ACHIEVEMENTS.filter((a) => earnedAchievements[a.id]).length;
  return `<p class="histogram-label" style="margin-top:24px;">achievements · ${earnedCount}/${ACHIEVEMENTS.length}</p><div class="ach-grid">${items}</div>`;
}

/* ---------- Personal records (your own best runs, per mode) ---------- */
function recordDateLabel(date) {
  return date
    ? new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : "—";
}
// Completion time (seconds) → "m:ss". null when the mode has no clock.
function fmtTime(sec) {
  if (sec == null) return null;
  const s = Math.round(sec);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
// Human label for a board-mode token: "medium" → "Normal", "inf-3lives-easy" →
// "3 lives · Easy", "daily" → "Daily".
function modeLabel(token) {
  if (token === "daily") return "Daily";
  if (token && token.startsWith("inf-")) {
    const parts = token.split("-");   // ["inf", variant, mode]
    return (VARIANT_LABELS[parts[1]] || parts[1]) + " · " + (MODES[parts[2]] ? MODES[parts[2]].label : parts[2]);
  }
  return MODES[token] ? MODES[token].label : (token || "—");
}
const isInfiniteToken = (token) => !!token && token.startsWith("inf-");
// Compact "your best" line for a single mode (start screen + results). Shows the
// mode's top personal record, or a target line if you've never finished a run in it.
function renderBestLine(el, mode) {
  const rec = loadRecords(mode)[0];
  if (!rec) {
    el.innerHTML = `<div class="best-empty">no runs yet — set your first record ★</div>`;
    return;
  }
  const unit = isInfiniteToken(mode) ? " rounds" : " / " + TOTAL_ROUNDS;
  const timePart = rec.time != null ? " · " + fmtTime(rec.time) : "";
  el.innerHTML =
    `<div class="best-line"><span class="best-num">${rec.score}<span class="best-unit">${unit}</span></span>` +
    `<span class="best-meta">★ best · ${escapeHtml(modeLabel(mode))}${timePart}${rec.date ? " · " + recordDateLabel(rec.date) : ""}</span></div>`;
}

/* ---------- Records page (personal-best tiles + run history) ---------- */
const HISTORY_PAGE = 20;          // history rows revealed per "load more"
let historyShown = 0;             // rows currently rendered
let recordsBackTarget = "start";  // where ← back returns to
let _pbByMode = {};               // per-mode best, for crowning history rows

// Best daily score ever (daily runs don't live in the per-mode records store).
function dailyBest() {
  let best = 0;
  for (const h of loadHistory()) if (h.t === "daily" && h.s > best) best = h.s;
  return best;
}
function pbTile(mode, opts = {}) {
  const rec = opts.score != null ? { score: opts.score, date: null } : loadRecords(mode)[0];
  const empty = !rec || rec.score == null;
  const unit = isInfiniteToken(mode) ? "" : "/" + TOTAL_ROUNDS;
  let sub = opts.sub;
  if (!sub) {
    if (!rec) sub = "no runs yet";
    else {
      const parts = [];
      if (rec.time != null) parts.push(fmtTime(rec.time));
      if (rec.date) parts.push(recordDateLabel(rec.date));
      sub = parts.length ? parts.join(" · ") : "—";
    }
  }
  return `<div class="pb-tile${empty ? " pb-empty" : ""}">` +
    `<span class="pb-mode">${escapeHtml(opts.label || modeLabel(mode))}</span>` +
    `<span class="pb-score">${empty ? "—" : rec.score + (unit ? `<span class="pb-unit">${unit}</span>` : "")}</span>` +
    `<span class="pb-sub">${escapeHtml(sub)}</span></div>`;
}
function accLabel(h) { return h.n ? Math.round((h.c / h.n) * 100) + "%" : "—"; }
function histDateLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" }) + " · " +
         d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function appendHistoryRows(hist) {
  const rowsEl = $("histRows");
  if (!rowsEl) return;
  const next = hist.slice(historyShown, historyShown + HISTORY_PAGE);
  rowsEl.insertAdjacentHTML("beforeend", next.map((h) => {
    const unit = isInfiniteToken(h.m) ? "" : "/" + TOTAL_ROUNDS;
    const isPB = h.s > 0 && h.s === _pbByMode[h.m];
    return `<div class="hist-row${isPB ? " hist-pb" : ""}">` +
      `<span class="hist-score">${isPB ? "♛ " : ""}${h.s}${unit ? `<span class="hist-unit">${unit}</span>` : ""}</span>` +
      `<span class="hist-acc">${accLabel(h)}</span>` +
      `<span class="hist-time">${h.tm != null ? fmtTime(h.tm) : "—"}</span>` +
      `<span class="hist-mode">${escapeHtml(modeLabel(h.m))}</span>` +
      `<span class="hist-date">${histDateLabel(h.d)}</span></div>`;
  }).join(""));
  historyShown += next.length;
  const more = $("histMore");
  if (more && historyShown >= hist.length) more.style.display = "none";
}
function renderRecordsPage() {
  const name = getPlayerName();
  const sig = name
    ? `<span class="rec-sig-name">${escapeHtml(name)}’s notebook</span><span class="rec-sig-sub">best scores &amp; history</span>`
    : `<div class="rec-sign-row"><input id="recSignInput" class="set-text" maxlength="20" placeholder="sign your notebook" /><button id="recSignSave" class="btn-ghost">sign</button></div>`;

  // Personal bests — classic difficulties always shown; infinite/daily only if played.
  const classicTiles = MODE_ORDER.map((m) => pbTile(m)).join("");
  const infTokens = [];
  for (const v of ["3lives", "sudden"]) for (const m of MODE_ORDER) {
    const tok = "inf-" + v + "-" + m;
    if (loadRecords(tok).length) infTokens.push(tok);
  }
  const infBlock = infTokens.length
    ? `<p class="rec-group-label">infinite — rounds survived</p><div class="pb-grid">${infTokens.map((t) => pbTile(t)).join("")}</div>`
    : "";
  const db = dailyBest();
  const streak = effectiveDailyStreak(todayKey());
  const dailyBlock = (db > 0 || streak.best > 0)
    ? `<p class="rec-group-label">daily</p><div class="pb-grid">` +
        pbTile("daily", { label: "Daily best", score: db, sub: `🔥 ${streak.current} day streak · best ${streak.best}` }) +
      `</div>`
    : "";

  const hist = loadHistory();
  _pbByMode = {};
  for (const h of hist) if (!(h.m in _pbByMode)) _pbByMode[h.m] = h.m === "daily" ? db : (loadRecords(h.m)[0] ? loadRecords(h.m)[0].score : -1);
  const histBlock = hist.length
    ? `<p class="rec-group-label">history — ${hist.length} run${hist.length === 1 ? "" : "s"}</p>` +
      `<div class="hist-head"><span>score</span><span>acc.</span><span>time</span><span>mode</span><span>date</span></div>` +
      `<div id="histRows" class="hist-rows"></div>` +
      (hist.length > HISTORY_PAGE ? `<button id="histMore" class="btn-ghost">load more</button>` : "")
    : `<p class="rec-group-label">history</p><p class="stats-empty">no runs yet — finish a game to start your log.</p>`;

  $("recordsBody").innerHTML =
    `<div class="rec-sig">${sig}</div>` +
    `<p class="rec-group-label">personal bests</p><div class="pb-grid">${classicTiles}</div>` +
    infBlock + dailyBlock + histBlock;

  const saveBtn = $("recSignSave");
  if (saveBtn) saveBtn.addEventListener("click", () => {
    const v = ($("recSignInput").value || "").trim().slice(0, 20);
    if (v) { settings.playerName = setPlayerName(v); refreshStartBoard(); renderRecordsPage(); }
  });
  const signInput = $("recSignInput");
  if (signInput) signInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveBtn.click(); });

  historyShown = 0;
  if (hist.length) appendHistoryRows(hist);
  const more = $("histMore");
  if (more) more.addEventListener("click", () => appendHistoryRows(hist));
}
function openRecords(from) {
  recordsBackTarget = from;
  renderRecordsPage();
  showScreen("records");
}

/* ---------- Bracelet (hand-strung SVG) ---------- */
let justEarnedIndex = -1; // bead that just became a charm, for the swing-in

function renderBracelet() {
  const opts = gameType === "infinite"
    ? { total: Math.max(round, 1), letterBead: false, colors: albumPalette() }
    : { colors: albumPalette() };
  $("bracelet").innerHTML = buildBraceletSVG(roundResults, round, justEarnedIndex, roundAlbums, opts);
  $("charmCount").textContent = roundResults.filter(Boolean).length;
  $("pageNum").textContent = gameType === "infinite"
    ? Math.max(round, 1)
    : Math.min(Math.max(round, 1), TOTAL_ROUNDS);
}

// Pencil tally in the margin: one mark per starting life, spent ones struck out.
// Only shown in infinite mode; classic hides the element.
function startingLives() { return infiniteVariant === "sudden" ? 1 : 3; }
function renderLives() {
  const el = $("livesTally");
  if (!el) return;
  if (gameType !== "infinite") { el.classList.remove("show"); el.innerHTML = ""; return; }
  const total = startingLives();
  let marks = "";
  for (let i = 0; i < total; i++) {
    const spent = i >= lives;
    marks += `<span class="life-mark${spent ? " spent" : ""}" aria-hidden="true"></span>`;
  }
  el.innerHTML = marks;
  el.classList.add("show");
}

/* ---------- Data load ---------- */
async function loadData() {
  const [wordsRes, songsRes] = await Promise.all([
    fetch("words.json"),
    fetch("songs.json"),
  ]);
  if (!wordsRes.ok || !songsRes.ok) throw new Error("Failed to fetch data files");
  const words = await wordsRes.json();
  const grouped = await songsRes.json();
  allSongs = grouped.flatMap(({ album, songs }) =>
    songs.map((s) => ({ ...s, album }))
  );
  // Precompute a normalized comparison key per song and index by it, so a typed
  // answer matches regardless of punctuation / & / $ / numerals. Then fold in the
  // irregular aliases, never letting one shadow a genuine title.
  titleIndex = new Map();
  for (const s of allSongs) {
    s._norm = normalizeTitle(s.title);
    s._normLyrics = normalizeLyric(s.lyrics);   // flat blob for lyric-line matching
    titleIndex.set(s._norm, s);
  }
  for (const [canonical, aliases] of Object.entries(TITLE_ALIASES)) {
    const song = allSongs.find((s) => s.title === canonical);
    if (!song) { console.warn(`TITLE_ALIASES: no song titled "${canonical}"`); continue; }
    for (const alias of aliases) {
      const key = normalizeTitle(alias);
      const existing = titleIndex.get(key);
      if (existing && existing !== song) {
        console.warn(`TITLE_ALIASES: "${alias}" collides with "${existing.title}"; skipped`);
        continue;
      }
      titleIndex.set(key, song);
    }
  }
  // Lenient playability (Easy/Medium/Hard use derived forms).
  playableWords = words.filter((w) => songsContainingWord(w, false).length >= 1);
  if (!playableWords.length) throw new Error("No playable words found in data");
  buildWordBuckets();
}

// Bucket words by how many songs contain them, so each mode draws from an
// appropriate-rarity pool. Thresholds are tunable; each bucket falls back to
// the full list if it ends up too thin to sustain a 13-round, no-repeat game.
function buildWordBuckets() {
  const MIN = RECENT_WINDOW + 8;
  // Easy counts plain lyric matches (title songs are allowed in Easy/Medium).
  const easy = playableWords.filter((w) => songsContainingWord(w, false).length >= 18);
  // Hard/Ultra count only *valid* answers (word in lyrics but NOT the title), so
  // every bucketed word still has at least one answerable, non-giveaway song.
  const hard = playableWords.filter((w) => {
    const n = validSongs(w, false, true).length;
    return n >= 3 && n <= 9;
  });
  const ultra = playableWords.filter((w) => {
    const n = validSongs(w, true, true).length;   // strict word, no title, rarest
    return n >= 1 && n <= 3;
  });
  const safe = (arr) => (arr.length >= MIN ? arr : playableWords);
  wordBuckets = { easy: safe(easy), all: playableWords, hard: safe(hard), ultra: safe(ultra) };
}

/* ---------- Difficulty ---------- */
function setMode(id) {
  if (!MODES[id]) return;
  currentMode = MODES[id];
  try { localStorage.setItem(DIFF_KEY, id); } catch (e) { /* ignore */ }
  renderModePicker();
  refreshStartBoard();
}
const GAMETYPE_LABELS = { classic: "Classic", infinite: "Infinite" };
const VARIANT_LABELS = { "3lives": "3 lives", sudden: "Sudden death" };

// The start-screen "your best" line follows the selected mode (+ infinite variant).
function refreshStartBoard() {
  const t = $("startPodiumTitle");
  if (t) t.textContent = "Your best";
  renderBestLine($("startBest"), boardMode());
}
function updateBlurb() {
  const b = $("modeBlurb");
  if (b) {
    if (gameType === "infinite") {
      const v = infiniteVariant === "sudden" ? "one miss ends it" : "three lives";
      b.textContent = v + " · " + currentMode.blurb;
    } else {
      b.textContent = currentMode.blurb;
    }
  }
  updateTagline();
}
// Masthead tagline reflects the active/selected game config.
function updateTagline() {
  const el = $("tagline");
  if (!el) return;
  const clock = currentMode.seconds > 0 ? `${currentMode.seconds} seconds each` : "no timer";
  el.textContent = gameType === "infinite"
    ? `endless pages · ${clock}`
    : `${TOTAL_ROUNDS} pages · ${clock}`;
}
function renderModePicker() {
  const tabs = $("modeTabs");
  if (!tabs) return;
  tabs.innerHTML = MODE_ORDER.map((m) =>
    `<button type="button" class="mode-tab${m === currentMode.id ? " active" : ""}" data-mode="${m}">${MODES[m].label}</button>`
  ).join("");
  tabs.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));
  updateBlurb();
}
function renderTypePicker() {
  const tabs = $("typeTabs");
  if (!tabs) return;
  tabs.innerHTML = ["classic", "infinite"].map((g) =>
    `<button type="button" class="mode-tab${g === gameType ? " active" : ""}" data-type="${g}">${GAMETYPE_LABELS[g]}</button>`
  ).join("");
  tabs.querySelectorAll("[data-type]").forEach((b) =>
    b.addEventListener("click", () => setGameType(b.dataset.type)));
}
function renderVariantPicker() {
  const tabs = $("variantTabs");
  if (!tabs) return;
  tabs.innerHTML = ["3lives", "sudden"].map((v) =>
    `<button type="button" class="mode-tab${v === infiniteVariant ? " active" : ""}" data-variant="${v}">${VARIANT_LABELS[v]}</button>`
  ).join("");
  tabs.querySelectorAll("[data-variant]").forEach((b) =>
    b.addEventListener("click", () => setVariant(b.dataset.variant)));
}
// Render all three start-screen pickers + the board for the current selection.
function renderStartPickers() {
  gameType = gameType === "infinite" ? "infinite" : "classic";
  // A daily game forces currentMode to Normal without persisting; restore the
  // player's preference (a fixed default-difficulty setting, else their last pick).
  currentMode = (settings.defaultDifficulty !== "last" && MODES[settings.defaultDifficulty])
    ? MODES[settings.defaultDifficulty]
    : loadMode();
  renderTypePicker();
  renderVariantPicker();
  $("variantRow").style.display = gameType === "infinite" ? "" : "none";
  renderModePicker();
  refreshStartBoard();
}
function setGameType(g) {
  gameType = g === "infinite" ? "infinite" : "classic";
  $("variantRow").style.display = gameType === "infinite" ? "" : "none";
  renderTypePicker();
  updateBlurb();
  refreshStartBoard();
}
function setVariant(v) {
  infiniteVariant = v === "sudden" ? "sudden" : "3lives";
  renderVariantPicker();
  updateBlurb();
  refreshStartBoard();
}

/* ---------- Game flow ---------- */
// Today's date key, "YYYY-MM-DD" in UTC (same day-rollover tradeoff as Wordle).
function todayKey() { return new Date().toISOString().slice(0, 10); }

// The run is over when the fixed 13 pages are filled (classic + daily), or
// (infinite) lives run out.
function isGameOver() {
  if (gameType === "infinite") return lives <= 0;
  return round >= TOTAL_ROUNDS;
}

// Storage token for the active board/stats: classic uses the bare difficulty id
// (medium stays the legacy unsuffixed key); infinite tags variant + difficulty;
// daily has its own date-keyed board, so it returns null here.
function boardMode() {
  if (gameType === "infinite") return "inf-" + infiniteVariant + "-" + currentMode.id;
  if (gameType === "daily") return null;
  return currentMode.id;
}

function resetRunState() {
  score = 0;
  round = 0;
  correctStreak = 0;
  gameTimeouts = 0;
  gameMaxStreak = 0;
  lyricLineAnswers = 0;
  verseBonus = 0;
  gameTimeSum = 0;
  gameHitRedZone = false;
  newlyUnlocked = [];
  usedWords = [];
  recentEras = [];
  roundResults = [];
  roundAlbums = [];
  roundWords = [];
  roundSongs = [];
  dailyRng = null;
}
function applyInputHints() {
  const input = $("songInput");
  const hint = $("gameHint");
  if (currentMode.lyricOnly) {
    input.placeholder = "type the lyric line…";
    hint.textContent = "type a few words around the word — Enter to answer";
    return;
  }
  input.placeholder = currentMode.dropdown ? "a title… or sing me a line" : "the full title… or a lyric line";
  hint.textContent = currentMode.dropdown ? "Enter accepts the top match — or type a lyric line" : "no hints — type the full title or a real lyric line, then Enter";
}

function startGame() {
  gameType = "classic";
  rememberGameType("classic");
  resetRunState();
  applyInputHints();
  updateTagline();
  $("pageTotalWrap").style.display = "";
  $("pageTotal").textContent = TOTAL_ROUNDS;
  showScreen("game");
  nextRound();
}

// Infinite mode: endless rounds until lives run out. `opts.carry` keeps the
// current run's score/streak/round (used by "keep going" from a finished game).
function startInfinite(variant, opts) {
  infiniteVariant = variant === "sudden" ? "sudden" : "3lives";
  gameType = "infinite";
  rememberGameType("infinite");
  lives = startingLives();
  const carry = !!(opts && opts.carry);
  if (!carry) resetRunState();
  applyInputHints();
  updateTagline();
  $("pageTotalWrap").style.display = "none";
  showScreen("game");
  // Fresh runs use nextRound's round-0 instant path; a carried run is mid-game,
  // so advance straight into the next page without the results→game page flip.
  if (carry) { advanceRound(); startTimer(); }
  else nextRound();
}

// Daily challenge: the same seeded 13 words + eras for everyone on a given date,
// one play per day. Always Normal settings. If you've already played today, jump
// straight to your saved result instead of replaying.
function startDaily() {
  const dateStr = todayKey();
  const existing = loadDailyResult(dateStr);
  if (existing) { showDailyResult(existing, dateStr); return; }
  gameType = "daily";
  currentMode = MODES.medium;   // daily is always Normal — override without persisting via DIFF_KEY
  resetRunState();
  dailyRng = mulberry32(dailySeed(dateStr));   // set AFTER resetRunState (which clears it)
  applyInputHints();
  updateTagline();
  $("pageTotalWrap").style.display = "";
  $("pageTotal").textContent = TOTAL_ROUNDS;
  showScreen("game");
  nextRound();
}

// Re-render the results screen from a previously saved daily result (the
// already-played path). Reuses the regular results layout + daily board + share.
function showDailyResult(data, dateStr) {
  gameType = "daily";
  currentMode = MODES.medium;
  roundResults = data.roundResults;
  roundAlbums = data.roundAlbums;
  score = data.score;
  showScreen("results");
  $("resultBracelet").innerHTML = buildBraceletSVG(roundResults, 0, -1, roundAlbums, { colors: albumPalette() });
  $("finalScore").textContent = settings.hideDailyScore ? "?" : score;
  $("finalSub").textContent = "out of " + TOTAL_ROUNDS;
  $("keepGoingBtn").style.display = "none";
  $("resultAchievements").style.display = "none";
  $("namePrompt").style.display = "none";
  hideNewBestBanner();
  document.querySelector("#screen-results .podium-title").textContent = "Today's Result";
  renderDailyResultPanel();
  renderShareButton(dateStr, settings.hideDailyScore);
}

// The daily results panel: streak summary in place of a leaderboard (daily is one
// play per day, so there's nothing to rank — your streak is the throughline).
function renderDailyResultPanel() {
  const d = effectiveDailyStreak(todayKey());
  const note = d.playedToday
    ? `<p class="daily-streak-note">✓ played today's challenge</p>`
    : `<p class="daily-streak-note">come back tomorrow to keep the streak</p>`;
  $("resultPodium").innerHTML =
    `<div class="streak-row">` +
    `<div class="streak-cell"><span class="stat-val">🔥 ${d.current}</span><span class="stat-lbl">day streak</span></div>` +
    `<div class="streak-cell"><span class="stat-val">${d.best}</span><span class="stat-lbl">best streak</span></div>` +
    `</div>` + note;
}

// Wordle-style copyable summary built from the per-round results.
function buildShareString(dateStr) {
  const dateObj = new Date(dateStr + "T00:00:00Z");
  const label = dateObj.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const emoji = roundResults.map((r) => (r ? "⭐" : "⬜")).join("");
  return `Swift Song Association 🎵\nDaily Challenge · ${label}\n${emoji}\n${score}/${TOTAL_ROUNDS}`;
}

function renderShareButton(dateStr, hidden) {
  const existing = $("shareBtn");
  if (existing) existing.remove();
  const btn = document.createElement("button");
  btn.id = "shareBtn";
  btn.className = "btn-ghost daily-share-btn";
  const label = hidden ? "Reveal & copy" : "Copy result";
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    if (hidden) $("finalScore").textContent = score;   // reveal the held-back score
    const text = buildShareString(dateStr);
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e2) { /* ignore */ }
      ta.remove();
    }
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copied ✓"; }, 2000);
  });
  const braceletEl = $("resultBracelet");
  braceletEl.parentNode.insertBefore(btn, braceletEl.nextSibling);
}

function pickWord() {
  const bucket = wordBuckets[currentMode.pool] || playableWords;
  // No-repeat within a game: exclude every word already used this run. Buckets
  // are guaranteed ≥ TOTAL_ROUNDS words (see buildWordBuckets' MIN), so the pool
  // only empties on a degenerate list — fall back to the full bucket if so.
  const pool = bucket.filter((w) => !usedWords.includes(w));
  const choices = pool.length ? pool : bucket;
  const rng = dailyRng || Math.random;
  const word = choices[Math.floor(rng() * choices.length)];
  usedWords.push(word);
  return word;
}

function nextRound() {
  if (isGameOver()) { endGame(); return; }
  // First round (from the start screen) advances instantly; so do reduced motion,
  // "instant" animation speed, and the page-turn setting being off.
  if (round === 0 || motionReduced() || animInstant() || !settings.pageTurn) {
    advanceRound();
    startTimer();
    return;
  }
  // Clone the answered page as a sheet, swap the real page to the next round
  // beneath it, then flip the sheet away to reveal it. The timer for the new
  // round only starts once the flip has finished, so none of the 10s is lost.
  const card = $("screen-game");
  card.style.transform = "";
  const flip = card.cloneNode(true);
  flip.removeAttribute("id");
  flip.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
  flip.classList.remove("screen", "active");
  flip.classList.add("page-flip-sheet");
  flip.style.top = card.offsetTop + "px";
  flip.style.left = card.offsetLeft + "px";
  flip.style.width = card.offsetWidth + "px";
  const shade = document.createElement("div");
  shade.className = "flip-shade";
  flip.appendChild(shade);
  card.parentNode.appendChild(flip);

  advanceRound();             // the next page is now in place under the flipping sheet

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    flip.remove();
    startTimer();             // start the clock only after the page has turned
  };
  // Primary trigger is a timeout matched to the 0.5s flip (CSS .page-flip-sheet),
  // with animationend as a fast-path; whichever lands first wins.
  flip.addEventListener("animationend", (e) => { if (e.target === flip) finish(); });
  setTimeout(finish, 500 * animScale() || 250);
}

// How rare the round's word is, from its number of valid answers. Returns a
// name (for data-rarity) and t in 0..1 (common→scarce) used to scale the
// highlighter swipe's weight, so rarer words *feel* rarer without touching the
// era engine's hue.
function rarityTier(n) {
  if (n >= 12) return { name: "common",   t: 0,    stamp: "" };
  if (n >= 6)  return { name: "uncommon", t: 0.4,  stamp: "uncommon" };
  if (n >= 3)  return { name: "rare",     t: 0.75, stamp: "rare find" };
  return { name: "scarce", t: 1, stamp: "scarce" };
}

function advanceRound() {
  round++;
  roundLocked = false;
  justEarnedIndex = -1;
  currentWord = pickWord();
  currentSongs = validSongs(currentWord, currentMode.strict, currentMode.noTitle);
  applyEra(pickEra());

  const rar = rarityTier(currentSongs.length);
  const wrap = $("wordDisplay").parentNode;   // .word-wrap
  wrap.dataset.rarity = rar.name;
  wrap.style.setProperty("--rarity", rar.t);
  const stamp = $("rarityStamp");
  stamp.classList.remove("show");
  stamp.textContent = rar.stamp;
  if (rar.stamp) { void stamp.offsetWidth; stamp.classList.add("show"); } // reflow re-fires the stamp-in

  $("wordDisplay").textContent = currentWord;
  renderExcludedNote();
  $("feedback").innerHTML = "";
  $("playArea").style.display = "";
  renderBracelet();
  renderLives();
  const input = $("songInput");
  input.value = "";
  input.disabled = false;
  input.classList.remove("reject-pulse");
  clearTimeout(rejectFlashTimer);
  $("rejectFlash").classList.remove("show");
  hideDropdown();
  input.focus();

  resetTension();
  runRoundEggs();
  // Note: the timer is started by the caller (nextRound) — for a page turn it
  // only starts once the flip finishes, so no time is lost during the animation.
}

// `resume` (seconds remaining) restarts a paused round mid-count instead of from
// the full clock — used when closing the settings modal during play.
function startTimer(resume) {
  clearTimer();
  const fill = $("timerFill");
  const label = $("timerLabel");
  const total = currentMode.seconds;
  const wrap = document.querySelector(".timer-wrap");
  // Relaxed mode (seconds <= 0): no clock at all — hide the bar and never time out.
  if (!(total > 0)) {
    if (wrap) wrap.style.display = "none";
    return;
  }
  if (wrap) wrap.style.display = "";
  const begin = (resume != null && resume > 0 && resume < total) ? resume : total;
  timerStart = performance.now() - (total - begin) * 1000;
  fill.style.width = (begin / total * 100) + "%";
  fill.classList.remove("low");
  label.textContent = begin.toFixed(1);

  timerId = setInterval(() => {
    const elapsed = (performance.now() - timerStart) / 1000;
    const remaining = Math.max(0, total - elapsed);
    const pct = (remaining / total) * 100;
    fill.style.width = pct + "%";
    label.textContent = remaining.toFixed(1);
    fill.classList.toggle("low", remaining <= 3);
    // the bridge build: ramp tension over the final 4 seconds
    setTension(remaining >= 4 ? 0 : (4 - remaining) / 4);
    updateTally(remaining);
    if (remaining <= 0) {
      label.textContent = "0.0";
      submitAnswer(null, true);
    }
  }, 100);
}
function clearTimer() {
  if (timerId) { clearInterval(timerId); timerId = null; }
}

/* ---------- Timer tension ---------- */
function setTension(t) {
  // Timer-tension setting off → keep the vignette/tremor at rest.
  document.body.style.setProperty("--tension", settings.timerTension ? String(t) : "0");
}
function updateTally(remaining) {
  if (!settings.timerTension) return;
  const el = $("marginTally");
  if (remaining > 0 && remaining <= 3) {
    const n = String(Math.ceil(remaining));
    if (el.dataset.n !== n) {
      el.dataset.n = n;
      el.textContent = n;
      el.classList.remove("show");
      void el.offsetWidth; // restart the scrawl animation
      el.classList.add("show");
    }
  } else if (el.dataset.n) {
    el.dataset.n = "";
    el.textContent = "";
    el.classList.remove("show");
  }
}
function resetTension() {
  setTension(0);
  const el = $("marginTally");
  el.dataset.n = "";
  el.textContent = "";
  el.classList.remove("show");
}

/* ---------- Dropdown (searches whole catalog) ---------- */
function rankMatches(query) {
  const q = normalizeTitle(query);
  if (!q) return [];
  const scored = [];
  for (const song of allSongs) {
    const t = song._norm;
    const idx = t.indexOf(q);
    if (idx === -1) continue;
    const rank = idx === 0 ? 0 : 1;
    scored.push({ song, rank, idx });
  }
  scored.sort((a, b) => a.rank - b.rank || a.idx - b.idx || a.song.title.localeCompare(b.song.title));
  return scored.slice(0, 6).map((s) => s.song);
}

function updateDropdown() {
  const q = $("songInput").value;
  dropdownItems = rankMatches(q);
  activeIndex = dropdownItems.length ? 0 : -1;
  renderDropdown();
}
function renderDropdown() {
  const dd = $("dropdown");
  if (!dropdownItems.length) { hideDropdown(); return; }
  dd.innerHTML = "";
  dropdownItems.forEach((song, i) => {
    const div = document.createElement("div");
    const off = isOffLimitsPick(song);
    div.className = "item" + (i === activeIndex ? " active" : "") + (off ? " off-limits" : "");
    div.innerHTML = `${escapeHtml(song.title)}` + (off ? `<span class="dd-tag">in the title</span>` : "");
    div.addEventListener("mousedown", (e) => {
      e.preventDefault();
      submitAnswer(song, false);   // off-limits picks route through the soft-reject in submitAnswer
    });
    dd.appendChild(div);
  });
  dd.classList.add("show");
}
function hideDropdown() { $("dropdown").classList.remove("show"); }

// A pick is off-limits when the active mode bars title songs and the word sits in
// this song's title — the exact condition validSongs() uses to exclude it.
function isOffLimitsPick(song) {
  return !!song && currentMode.noTitle && wordRegex(currentWord, currentMode.strict).test(song.title);
}
// Soft rejection: don't consume the round. Flash a red note, wipe the line, and
// keep the clock running so the player can answer the same word with a valid song.
let rejectFlashTimer = null;
function rejectOffLimits(song) {
  const input = $("songInput");
  input.value = "";
  dropdownItems = []; activeIndex = -1;
  hideDropdown();
  const el = $("rejectFlash");
  el.innerHTML = `<b>“${escapeHtml(song.title)}”</b> is in the title — try another`;
  el.classList.remove("show");
  void el.offsetWidth;                 // restart the pop-in animation
  el.classList.add("show");
  input.classList.remove("reject-pulse");
  void input.offsetWidth;
  input.classList.add("reject-pulse");
  clearTimeout(rejectFlashTimer);
  rejectFlashTimer = setTimeout(() => {
    el.classList.remove("show");
    input.classList.remove("reject-pulse");
  }, 1700);
  input.focus();
}

/* ---------- Lyric-line answering ---------- */
// A player can answer by typing a LYRIC LINE instead of the title. There is no lyric
// autocomplete (that would hand them the answer); the line is blind-typed and only
// JUDGED here. To pass it must (a) contain the prompt word, (b) be >= MIN_LYRIC_WORDS,
// and (c) closely match a real word-bearing lyric line of a valid song. Fuzzy so
// typos / a slightly-off line still count. Returns { song, line } or null.
function matchLyricLine(phrase) {
  const normPhrase = normalizeLyric(phrase);
  if (!normPhrase) return null;
  if (normPhrase.split(" ").length < MIN_LYRIC_WORDS) return null;
  // NOTE: we deliberately do NOT require the prompt word to appear in the typed phrase.
  // Matching is already restricted to currentSongs (every one of which contains the
  // word — they're the round's valid answers), so any real lyric chunk that matches is
  // a correct answer regardless of which specific lines the player recalled. This makes
  // multi-line recall "just work" when the word lives in a line they didn't type. The
  // bare-word / word+filler cheat is still blocked by MIN_LYRIC_WORDS + a real-line match.

  // Fast path: a verbatim contiguous run anywhere in the lyrics (incl. across lines).
  for (const s of currentSongs) {
    if (s._normLyrics.includes(normPhrase)) {
      const line = recoverLyricLine(s, normPhrase);
      return { song: s, line, ...gradeLyricRecall(normPhrase, line) };
    }
  }

  // Fuzzy path: best whole-song substring match. We match against the song's flat
  // _normLyrics blob (newlines folded to spaces), so a phrase that spans SEVERAL
  // lines is matched as one window — typos / line-break differences and all. This is
  // what lets a player type a multi-line chunk and have it "just work" even when it's
  // not verbatim. fuzzySubstringRatio aligns the typed phrase to its best window and
  // leaves trailing lyric free, so longer songs aren't penalised.
  let best = null;
  for (const s of currentSongs) {
    const ratio = fuzzySubstringRatio(normPhrase, s._normLyrics);
    if (ratio < FUZZY_THRESHOLD) continue;
    if (!best || ratio > best.ratio ||
        (ratio === best.ratio && (s.lyrics.length < best.song.lyrics.length ||
          (s.lyrics.length === best.song.lyrics.length && s.title < best.song.title)))) {
      best = { song: s, ratio };
    }
  }
  if (!best) return null;
  const line = recoverFuzzyLine(best.song, normPhrase);
  return { song: best.song, line, ...gradeLyricRecall(normPhrase, line) };
}

// Recover a display line for a FUZZY (non-verbatim) match: scan the song's contiguous
// line windows for the one whose normalized text best matches the typed phrase, and
// return that raw span. Mirrors recoverLyricLine's job for the inexact case, so the
// feedback card shows the actual lines the player was recalling (incl. cross-line).
function recoverFuzzyLine(song, normPhrase) {
  const rawLines = song.lyrics.split("\n").map((l) => l.trim()).filter(Boolean);
  let best = null;
  for (let i = 0; i < rawLines.length; i++) {
    const windowRaw = [];
    let windowNorm = "";
    for (let j = i; j < rawLines.length; j++) {
      const norm = normalizeLyric(rawLines[j]);
      if (!norm) continue;
      windowRaw.push(rawLines[j]);
      windowNorm = windowNorm ? windowNorm + " " + norm : norm;
      // Use a SYMMETRIC similarity (penalises the window being longer OR shorter than
      // the phrase) so we recover the span the player actually typed — not just any
      // window that happens to contain it (fuzzySubstringRatio leaves trailing lyric
      // free, which would let an over-long window tie and win).
      const sim = 1 - levenshtein(normPhrase, windowNorm) / Math.max(normPhrase.length, windowNorm.length);
      if (!best || sim > best.sim) best = { sim, text: windowRaw.join(" ") };
      if (windowNorm.length > normPhrase.length * 2) break;   // don't over-grow the window
    }
  }
  return best ? best.text : (rawLines[0] || "");
}

// Recover the original lyric text (for display) that holds the matched phrase.
// The phrase was found in the song's flat blob (_normLyrics, newlines folded to
// spaces), so it can straddle several lines. Map the blob hit back to the span of
// source lines it covers, rather than assuming one line holds the whole phrase
// (which would mis-fall-back to the song's first line for a cross-line phrase).
function recoverLyricLine(song, normPhrase) {
  const rawLines = song.lyrics.split("\n");
  // Single-line hit — the common case.
  const single = rawLines.find((l) => normalizeLyric(l).includes(normPhrase));
  if (single) return single.trim();
  // Cross-line phrase: rebuild each non-empty line's char span within the blob
  // (lines join with one space, matching how _normLyrics was normalized).
  const segs = [];
  let pos = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const norm = normalizeLyric(rawLines[i]);
    if (!norm) continue;
    segs.push({ i, start: pos, end: pos + norm.length });   // end exclusive
    pos += norm.length + 1;                                  // + joining space
  }
  const at = song._normLyrics.indexOf(normPhrase);
  if (at < 0) return (rawLines.find(Boolean) || "").trim();
  const endAt = at + normPhrase.length - 1;
  const startSeg = segs.find((s) => at >= s.start && at < s.end);
  const endSeg = segs.find((s) => endAt >= s.start && endAt < s.end);
  if (!startSeg || !endSeg) return (rawLines.find(Boolean) || "").trim();
  return rawLines.slice(startSeg.i, endSeg.i + 1)
    .map((l) => l.trim()).filter(Boolean).join(" ");
}

// Grade how much of the matched real line the player actually typed. Typing the
// minimum scrapes a pass with no bonus; recalling most / all of the line earns a
// "verse bonus" and a louder celebration. Returns { tier, bonus, coverage }.
function gradeLyricRecall(normPhrase, line) {
  const normLine = normalizeLyric(line);
  const total = normLine ? normLine.split(" ").length : 0;
  const typed = normPhrase ? normPhrase.split(" ").length : 0;
  const verbatim = normPhrase === normLine;
  const coverage = total ? Math.min(typed / total, 1) : 0;
  if (verbatim || coverage >= RECALL_PERFECT) return { tier: "perfect", bonus: 2, coverage };
  if (coverage >= RECALL_GOOD) return { tier: "good", bonus: 1, coverage };
  return { tier: "base", bonus: 0, coverage };
}

/* ---------- Submit & feedback ---------- */
function submitAnswer(song, isTimeout) {
  if (roundLocked) return;

  let lyricMatch = null;
  if (!song && !isTimeout) {
    if (currentMode.lyricOnly) {           // Lyricist mode: lyric line is the only path
      lyricMatch = matchLyricLine($("songInput").value);
      if (lyricMatch) song = lyricMatch.song;
    } else if (dropdownItems.length) {
      song = dropdownItems[activeIndex >= 0 ? activeIndex : 0];
    } else {
      const raw = $("songInput").value;
      const key = normalizeTitle(raw);
      song = key ? (titleIndex.get(key) || null) : null;
      if (!song) {                         // not a title — try it as a lyric line
        lyricMatch = matchLyricLine(raw);
        if (lyricMatch) song = lyricMatch.song;
      }
    }
    if (!song) return;
  }

  // Off-limits pick (covers every path: dropdown click, Enter, exact-title). In a
  // noTitle mode where the word is in this song's title, don't burn the round —
  // flash, wipe the line, and let them keep typing the same word. A timeout still
  // counts as a miss; lyric answers resolve only to valid songs, so they're exempt.
  if (song && !isTimeout && !lyricMatch && isOffLimitsPick(song)) { rejectOffLimits(song); return; }

  roundLocked = true;
  clearTimer();
  resetTension();
  hideDropdown();
  $("songInput").disabled = true;
  $("playArea").style.display = "none";

  const correct = !!song && currentSongs.some((s) => s.title === song.title);
  roundResults[round - 1] = correct;
  roundAlbums[round - 1] = song ? (song.album || null) : null;
  roundWords[round - 1] = currentWord;                 // prompt word — for Nemesis Word
  roundSongs[round - 1] = correct && song ? song.title : null;  // credited song — for the lifetime tally
  justEarnedIndex = correct ? round - 1 : -1;
  if (correct) score++;
  correctStreak = correct ? correctStreak + 1 : 0;
  if (gameType === "infinite" && !correct) { lives--; renderLives(); }
  renderBracelet();

  if (lyricMatch) {
    lyricLineAnswers++;                  // recalled a lyric line (for You Knew The Line)
    verseBonus += lyricMatch.bonus;      // reward fuller recall, separate from the 0–13 score
    if (lyricMatch.tier === "perfect") unlock("word-for-word");
  }

  // achievements: timing + streak signals (mid-game unlocks toast immediately).
  // Timing signals only apply to timed modes — Relaxed has no clock, so they're skipped.
  const timed = currentMode.seconds > 0;
  if (isTimeout) gameTimeouts++;
  if (timed) {
    const elapsed = (performance.now() - timerStart) / 1000;
    const remaining = currentMode.seconds - elapsed;
    gameTimeSum += Math.min(elapsed, currentMode.seconds);   // for Perfect Storm
    if (remaining <= 3) gameHitRedZone = true;               // for Peace (timeouts count too)
    if (correct) {
      if (elapsed < 2) unlock("speak-now");
      if (round === 1 && elapsed < 2) unlock("ready-for-it");
      if (remaining < 1) unlock("getaway-car");
      if (remaining < 0.5) unlock("i-did-something-bad");
    }
  }
  gameMaxStreak = Math.max(gameMaxStreak, correctStreak);
  if (correctStreak >= 5) unlock("bejeweled");
  if (correctStreak >= 10) unlock("sparks-fly");

  // Circle the player's pick before revealing the verdict (skipped on timeout / reduced
  // motion, and on a lyric answer — the circle re-draws a title the player never typed).
  const reveal = () => (correct ? showCorrectFeedback(song, lyricMatch) : showWrongFeedback(song, isTimeout));
  if (song && !isTimeout && !lyricMatch && settings.penCircle && !motionReduced() && !animInstant()) {
    showCircledChoice(song, reveal);
  } else {
    reveal();
  }
}


function showCircledChoice(song, done) {
  $("feedback").innerHTML =
    `<div class="circled-choice"><span class="cc-box"${activePen ? ` data-pen="${activePen}"` : ""}>` +
      `<span class="cc-text">${escapeHtml(song.title)}</span>` +
      `<svg viewBox="0 0 100 46" preserveAspectRatio="none" aria-hidden="true">` +
        `<path class="cc-ring" pathLength="1" d="M7,25 C5,12 31,5 53,6 C80,7 96,14 94,27 C92,40 63,43 43,42 C20,41 8,38 7,25"/>` +
      `</svg>` +
    `</span></div>`;
  setTimeout(done, 640 * animScale());
}

function lyricCard(song, word, isWrong, lineOverride) {
  const line = lineOverride != null ? lineOverride : extractLineWithWord(song.lyrics, word);
  const color = albumColor(song.album) || "var(--ink-soft)";
  const albumLabel = song.album ? `<span class="album-tag" style="--album-color:${color}">${escapeHtml(song.album)}</span>` : "";
  const cls = isWrong ? " wrong-card" : "";
  return `<div class="lyric-card${cls}" style="--album-color:${color}">
    <div class="song-title">${escapeHtml(song.title)}${albumLabel}</div>
    <div class="lyric-line">"${highlightWord(line, word)}"</div>
  </div>`;
}

const LYRIC_BANNERS = { base: "✓ you knew the line", good: "✓ nicely recalled", perfect: "✓ word-perfect" };

function showCorrectFeedback(song, lyricMatch) {
  const fb = $("feedback");
  // On a lyric answer, celebrate the recall and show the exact line they typed.
  // The banner escalates with how much of the line they recalled, and a chip calls
  // out any verse bonus earned (fuller line = more reward than the bare minimum).
  const banner = lyricMatch ? (LYRIC_BANNERS[lyricMatch.tier] || LYRIC_BANNERS.base) : "✓ that's the one";
  const bonusChip = lyricMatch && lyricMatch.bonus > 0
    ? `<div class="verse-bonus">+${lyricMatch.bonus} verse bonus</div>` : "";
  const card = lyricMatch
    ? lyricCard(song, currentWord, false, lyricMatch.line)
    : lyricCard(song, currentWord, false);
  // Auto-advance setting on → a countdown + skip; off → a plain "next page" button.
  const auto = settings.autoAdvance;
  const advanceUI = auto
    ? `<div class="countdown">next page in <b id="cd">${settings.countdownSecs}</b></div><button id="skipBtn" class="countdown-skip">skip →</button>`
    : `<button id="continueBtn" class="btn-ghost">next page →</button>`;
  fb.innerHTML = `
    <div class="banner good">${banner}</div>
    ${bonusChip}
    ${card}
    ${advanceUI}`;
  $(auto ? "skipBtn" : "continueBtn").addEventListener("click", advanceFromFeedback);
  celebrateCorrect(correctStreak, lyricMatch ? lyricMatch.bonus : 0);
  if (auto) runCountdown();
}

function showWrongFeedback(song, isTimeout) {
  const fb = $("feedback");
  const reason = isTimeout ? "the page ran out" : "not this verse";
  // Ultra offers no help (examples 0); the "show examples" setting can also force 0.
  const n = settings.showExamples ? currentMode.examples : 0;
  let help = "";
  if (n > 0) {
    const examples = shuffle(currentSongs.slice()).slice(0, n);
    const cards = examples.map((s) => lyricCard(s, currentWord, true)).join("");
    help = `<span class="red-note">songs that hold "<b>${escapeHtml(currentWord)}</b>"</span>${cards}`;
  }
  fb.innerHTML = `
    <div class="banner bad">✗ ${reason}</div>
    ${help}
    <button id="continueBtn" class="btn-ghost">next page →</button>`;
  $("continueBtn").addEventListener("click", advanceFromFeedback);
}

// Leave the verdict and turn the page — used by the skip button, the
// "next page" button, and the Enter key. Guarded so it only fires while a
// verdict is on screen (and clears any running countdown first).
function advanceFromFeedback() {
  if (!roundLocked) return;
  if (countdownId) { clearInterval(countdownId); countdownId = null; }
  nextRound();
}

function runCountdown() {
  let n = settings.countdownSecs;
  const el = $("cd");
  if (countdownId) clearInterval(countdownId);
  countdownId = setInterval(() => {
    if ($("settingsModal").classList.contains("open")) return;   // paused while settings is open
    n--;
    if (n <= 0) {
      clearInterval(countdownId);
      countdownId = null;
      nextRound();
    } else if (el) {
      el.textContent = n;
    }
  }, 1000);
}


/* ---------- End game ---------- */
function endGame() {
  clearTimer();
  resetTension();
  applyEra(FINALE_ERAS[Math.floor(Math.random() * FINALE_ERAS.length)]);

  const isInfinite = gameType === "infinite";
  const isDaily = gameType === "daily";
  const roundsSurvived = roundResults.length;
  const boardScore = isInfinite ? roundsSurvived : score;  // infinite ranks by how far you got
  const mode = boardMode();

  // Completion time (sum of per-round answer seconds, capped per round). Only meaningful
  // when there's a clock — Relaxed (seconds 0) has no time. Used as the records speed metric.
  const runTime = currentMode.seconds > 0 ? gameTimeSum : null;

  // Log every finished run to the chronological history (classic / infinite / daily).
  appendHistory({
    s: boardScore, c: score, n: roundsSurvived,
    m: isDaily ? "daily" : mode, t: gameType,
    d: new Date().toISOString(), tm: runTime,
  });

  // Daily plays don't touch any mode's stats board.
  if (!isDaily) updateStats(boardScore, mode, gameMaxStreak);

  // Lifetime per-song / per-word tally (every game type counts — it's a catalog
  // record, not a per-mode board). Powers Favourite Song, Songs Discovered,
  // Favourite Album, Nemesis Word.
  recordGameTally(roundResults.map((correct, i) => ({
    correct,
    title: roundSongs[i] || null,
    album: roundAlbums[i] || null,
    word: roundWords[i] || null,
  })));
  const played = totalPlayed();   // classic modes only — infinite/daily tracked separately

  // Record this game type; "Hits Different" needs all three (classic + infinite + daily).
  const typesPlayed = markTypePlayed(gameType);
  if (typesPlayed.classic && typesPlayed.infinite && typesPlayed.daily) unlock("hits-different");

  // end-of-game achievements (daily counts toward the game-quality ones; infinite deferred)
  const timedMode = currentMode.seconds > 0;   // Relaxed (no clock) skips timing achievements
  if (!isInfinite) {
    if (score === TOTAL_ROUNDS) unlock("mastermind");
    if (score === TOTAL_ROUNDS - 1) unlock("champagne-problems");
    if (score === 0) unlock("anti-hero");
    if (gameTimeouts === 0) unlock("fearless");
    if (currentMode.lyricOnly) unlock("all-too-well");
    if (played >= 1) unlock("enchanted");
    if (played >= 5) unlock("begin-again");
    if (played >= 15) unlock("fifteen");
    const trailingStreak = (() => { let n = 0; for (let i = roundResults.length - 1; i >= 0 && roundResults[i]; i--) n++; return n; })();
    if (roundResults.includes(false) && trailingStreak >= 5) unlock("long-story-short");
    if (currentMode.id === "ultra" && score >= 10) unlock("great-war");
    if (score === TOTAL_ROUNDS && (currentMode.id === "hard" || currentMode.id === "ultra")) unlock("long-live");
    if (longestAlbumRun(roundResults, roundAlbums) >= 3) unlock("branch-out");
    if (distinctStudioAlbumsHit(roundResults, roundAlbums) >= STUDIO_ALBUMS.length - 1) unlock("eras-tour");
    if (timedMode && !gameHitRedZone) unlock("peace");
    if (timedMode && gameTimeSum / TOTAL_ROUNDS < 3) unlock("perfect-storm");
    if (gameTimeouts === TOTAL_ROUNDS) unlock("i-cant-see-you");
  }
  if (isInfinite) {
    if (roundsSurvived >= 20) unlock("out-of-the-woods");
    if (roundsSurvived === 22) unlock("twenty-two");
    if (roundResults.length >= 13 && roundResults.slice(0, 13).every(Boolean)) unlock("holy-ground");
    if (infiniteVariant === "3lives" && lives <= 0 && roundsSurvived <= 4) unlock("cruel-summer");
  }
  // Game-type-agnostic signals (classic / infinite / daily all count).
  if (lyricLineAnswers >= 5) unlock("you-knew-the-line");
  if (recoveryCount(roundResults) >= 3) unlock("shake-it-off");
  if (hasTriangle(roundSongs)) unlock("the-triangle");
  if (roundSongs.includes("If This Was A Movie")) unlock("spicy-drama");
  if (longestBTitleRun(roundResults, roundSongs) >= 3) unlock("my-mind-is-alive");
  if (totalLifetimeMisses() >= 1000) unlock("thousand-cuts");
  if (new Date().getHours() === 0) unlock("midnights");   // played in the midnight hour
  // Safe & Sound — the three most recent finished runs were all classic Easy.
  const recent = loadHistory();
  if (recent.length >= 3 && recent.slice(0, 3).every((h) => h.m === "easy")) unlock("safe-and-sound");

  showScreen("results");
  const keepsakeOpts = isInfinite
    ? { total: Math.max(roundsSurvived, 1), letterBead: false, colors: albumPalette() }
    : { colors: albumPalette() };
  $("resultBracelet").innerHTML = buildBraceletSVG(roundResults, 0, -1, roundAlbums, keepsakeOpts);
  $("finalScore").textContent = boardScore;
  // Verse bonus (fuller lyric recall) rides alongside the score, never folded into it.
  // Hidden on a held-back daily score — it would leak how well the round went.
  const bonusSuffix = (verseBonus > 0 && !(isDaily && settings.hideDailyScore)) ? " · +" + verseBonus + " verse bonus" : "";
  const timeSuffix = (runTime != null && !(isDaily && settings.hideDailyScore)) ? " · " + fmtTime(runTime) : "";
  $("finalSub").textContent = (isInfinite ? "rounds · " + score + " correct" : "out of " + TOTAL_ROUNDS) + timeSuffix + bonusSuffix;
  $("keepGoingBtn").style.display = (isInfinite || isDaily) ? "none" : "";
  renderResultRecap();
  if (!isInfinite && score === TOTAL_ROUNDS) celebratePerfect();

  // Daily: persist the result, lock to one play/day, show streak + share (no board).
  if (isDaily) {
    const dateStr = todayKey();
    saveDailyResult(dateStr, { score, roundResults: roundResults.slice(), roundAlbums: roundAlbums.slice() });
    const streak = bumpDailyStreak(dateStr);   // extend (or reset) the consecutive-days streak
    unlock("today-was-a-fairytale");   // finished a Daily Challenge
    if (score === TOTAL_ROUNDS) unlock("daylight");
    if (streak.current >= 7) unlock("story-of-us");
    if (streak.current >= 30) unlock("evermore");
    dailyRng = null;   // back to Math.random() for any subsequent Classic game
    if (settings.hideDailyScore) $("finalScore").textContent = "?";
    $("namePrompt").style.display = "none";
    hideNewBestBanner();
    document.querySelector("#screen-results .podium-title").textContent = "Today's Result";
    renderDailyResultPanel();
    renderShareButton(dateStr, settings.hideDailyScore);
    return;
  }

  // Reset any daily-only chrome left over from a previous daily results view.
  document.querySelector("#screen-results .podium-title").textContent = "Your best";
  const staleShare = $("shareBtn");
  if (staleShare) staleShare.remove();
  $("namePrompt").style.display = "none";
  hideNewBestBanner();

  // Every positive run folds into your personal records (best-per-mode); a 0 doesn't
  // (it would never be a best). The full run is always in the history log either way.
  if (boardScore > 0) {
    const recTime = isInfinite ? null : runTime;   // infinite ranks by rounds, not speed
    const prevBest = loadRecords(mode)[0];
    const { isBest } = insertRecord(mode, boardScore, todayKey(), recTime);
    const draw = () => renderBestLine($("resultPodium"), mode);
    if (!getPlayerName()) promptSignOnce(draw);   // first record ever → sign once, reuse silently after
    else draw();
    if (isBest) {
      const improvedScore = !prevBest || boardScore > prevBest.score;
      showNewBestBanner((improvedScore ? "a new personal best ★" : "a new best time ★") +
        (recTime != null ? " · " + fmtTime(recTime) : ""));
      // R-E-V-E-N-G-E — actually beat a previous high score (not just shaved time).
      if (prevBest && improvedScore) unlock("revenge");
    }
  } else {
    renderBestLine($("resultPodium"), mode);
  }
}

// First personal record with no signature yet → ask for a name once, store it globally,
// and reuse it on every future record (no prompt thereafter). Reuses the #namePrompt markup.
function promptSignOnce(after) {
  const nameDiv = $("namePrompt");
  const p = nameDiv.querySelector("p");
  if (p) p.textContent = "sign your notebook — we'll remember it";
  nameDiv.style.display = "";
  const save = () => {
    const v = ($("nameInput").value || "").trim().slice(0, 20);
    if (v) settings.playerName = setPlayerName(v);   // keep the in-memory settings in sync (Settings panel reads it)
    nameDiv.style.display = "none";
    after();
  };
  $("saveNameBtn").onclick = save;
  $("nameInput").onkeydown = (e) => { if (e.key === "Enter") save(); };
  setTimeout(() => $("nameInput").focus(), 50);
}

// "New personal best" banner above the records — a brief pop, static under reduced motion.
function showNewBestBanner(text) {
  const el = $("newBestBanner");
  if (!el) return;
  el.textContent = text || "a new personal best ★";
  el.style.display = "";
  el.classList.remove("pop");
  if (!motionReduced()) { void el.offsetWidth; el.classList.add("pop"); }   // restart the animation
}
function hideNewBestBanner() {
  const el = $("newBestBanner");
  if (el) { el.style.display = "none"; el.classList.remove("pop"); }
}

/* ---------- Easter eggs (Phase 8) ---------- */
let titleTaps = 0;
let activePen = null;            // 'quill' | 'fountain' | 'glitter' | null
let blueUsedThisRound = false;
let correctStreak = 0;           // consecutive correct answers this game
let gameTimeouts = 0;            // timeouts this game (for Fearless)
let gameMaxStreak = 0;           // best streak reached this game
let lyricLineAnswers = 0;        // lyric-line answers this game (for You Knew The Line)
let verseBonus = 0;              // verse-bonus points this game (fuller lyric recall; separate from score)
let gameTimeSum = 0;             // total answer time this game, secs (for Perfect Storm)
let gameHitRedZone = false;      // any round answered with ≤3s left this game (for Peace)

const PEN_LABELS = { quill: "quill pen", fountain: "fountain pen", glitter: "glitter gel pen" };

function clearEggs() {
  stopSnake();
  const layer = $("doodleLayer");
  if (layer) layer.innerHTML = "";
}

function addDoodle(kind, posClass, w, h) {
  const layer = $("doodleLayer");
  if (!layer) return;
  const d = document.createElement("div");
  d.className = "doodle " + posClass + (kind === "snake" ? " snake" : "");
  d.style.width = w + "px"; d.style.height = h + "px";
  d.innerHTML = DOODLE_SVG[kind];
  layer.appendChild(d);
}

function addMarginNote(text) {
  const layer = $("doodleLayer");
  if (!layer) return;
  const n = document.createElement("div");
  n.className = "doodle-note";
  n.style.top = "42%";
  n.textContent = text;
  layer.appendChild(n);
}

function setPen(pen) {
  activePen = pen;
  const area = document.querySelector(".input-area");
  if (!area) return;
  area.querySelectorAll(".pen-glyph, .pen-label").forEach((e) => e.remove());
  if (!pen) { area.removeAttribute("data-pen"); return; }
  area.setAttribute("data-pen", pen);
  const g = document.createElement("span");
  g.className = "pen-glyph"; g.setAttribute("aria-hidden", "true");
  g.innerHTML = PEN_SVG[pen];
  const l = document.createElement("span");
  l.className = "pen-label"; l.textContent = PEN_LABELS[pen];
  area.appendChild(g); area.appendChild(l);
}

// Called from advanceRound once the new page is set up.
function runRoundEggs() {
  clearEggs();
  setPen(null);
  blueUsedThisRound = false;

  const era = document.body.getAttribute("data-era");
  const now = new Date();
  const midnightHour = now.getHours() === 0 && now.getMinutes() <= 13;

  // at most one margin doodle / note, by priority
  if (gameType === "classic" && round === 5) {
    addDoodle("fence", "corner-br", 76, 64);
  } else if (era === "graphite" && settings.snake && chance(0.5)) {
    slitherSnake();
  } else if (midnightHour) {
    addMarginNote("meet me at midnight");
  } else if (chance(0.14)) {
    const pool = ["scarf", "cat", "guitar"];
    addDoodle(pool[Math.floor(Math.random() * pool.length)], "corner-br", 56, 56);
  } else if (chance(0.05)) {
    addDoodle("thirteen", "corner-bl", 40, 40);
  }

  // rare pen swap, independent of the doodle
  if (chance(0.12)) {
    const pens = ["quill", "fountain", "glitter"];
    setPen(pens[Math.floor(Math.random() * pens.length)]);
  }
}

function handleTypingEggs(val) {
  const v = val.toLowerCase();
  if (!blueUsedThisRound && /\bblue\b/.test(v)) {
    blueUsedThisRound = true;
    triggerBlueWash();
  }
}

function triggerBlueWash() {
  const card = $("screen-game");
  if (!card) return;
  const w = document.createElement("div");
  w.className = "blue-wash"; w.setAttribute("aria-hidden", "true");
  card.appendChild(w);
  setTimeout(() => w.remove(), 1700);
}

// A detailed serpent that slithers right across the page during a reputation
// (graphite) round. The body follows the head along a travelling sine wave
// (follow-the-leader), tapers to a point at the tail, wears a scale pattern,
// and flicks a forked tongue. Built frame-by-frame so the undulation is real,
// not a sliding sticker. Reduced motion gets a quiet inked coil instead.
let snakeRaf = null;
function stopSnake() {
  if (snakeRaf) { cancelAnimationFrame(snakeRaf); snakeRaf = null; }
  const old = document.querySelector(".snake-overlay");
  if (old) old.remove();
}
function slitherSnake() {
  const card = $("screen-game");
  if (!card) return;
  unlock("look-what-you-made-me-do");
  if (motionReduced()) { addDoodle("snake", "corner-br", 84, 60); return; }
  stopSnake();

  const W = card.clientWidth || 520;
  const H = card.clientHeight || 800;
  const NS = "http://www.w3.org/2000/svg";

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "snake-overlay");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `
    <defs>
      <linearGradient id="snBody" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#173a1c"/>
        <stop offset="0.45" stop-color="#2f6b30"/>
        <stop offset="0.8" stop-color="#5aa03f"/>
        <stop offset="1" stop-color="#93c86a"/>
      </linearGradient>
      <pattern id="snScales" width="15" height="13" patternUnits="userSpaceOnUse">
        <path d="M7.5 1 L14 6.5 L7.5 12 L1 6.5 Z" fill="#0c2410" opacity="0.22"/>
        <path d="M0 6.5 L1 6.5 M14 6.5 L15 6.5" stroke="#0c2410" stroke-width="0.6" opacity="0.14"/>
      </pattern>
      <clipPath id="snClip"><path id="snClipPath" d="M0 0"/></clipPath>
    </defs>
    <path id="snFill" d="M0 0" fill="url(#snBody)" stroke="#0c2410" stroke-width="1.1" stroke-linejoin="round"/>
    <rect id="snScalesRect" x="-40" y="0" width="${W + 80}" height="${H}" fill="url(#snScales)" clip-path="url(#snClip)"/>
    <path id="snSheen" d="M0 0" fill="none" stroke="rgba(255,246,228,0.16)" stroke-width="2.6" stroke-linecap="round"/>
    <g id="snHead"></g>
  `;
  card.appendChild(svg);

  const fill = svg.querySelector("#snFill");
  const clip = svg.querySelector("#snClipPath");
  const sheen = svg.querySelector("#snSheen");
  const head = svg.querySelector("#snHead");
  const scalePat = svg.querySelector("#snScales");

  const M = 30;                                   // spine nodes (head .. tail)
  const seg = Math.max(9, (W * 0.6) / M);         // arc spacing between nodes
  const baseY = H * 0.52;
  const amp = Math.min(H * 0.07, 64);
  const k = (Math.PI * 2) / (W * 0.5);            // wave number (≈2 humps across)
  const bodyLen = M * seg;
  // head must travel its own length in, across W, then its length out again
  const speed = (W + 2 * bodyLen + 90) / 3500;    // px/ms → crosses in ~3.5s
  const yAtX = (x) => baseY + amp * Math.sin(k * x);

  let headX = -bodyLen - 30;                      // start fully off the left edge
  const trail = [];                               // index 0 = newest head point
  for (let x = headX; x > headX - bodyLen - seg * 6; x -= seg / 4) {
    trail.push({ x, y: yAtX(x) });
  }

  const widthAt = (j) => {
    const t = j / (M - 1);
    const headW = 12, tailW = 0.8;
    return tailW + (headW - tailW) * Math.pow(1 - t, 1.35);
  };

  let last = performance.now(), start = last;
  function frame(now) {
    const dt = Math.min(42, now - last); last = now;
    const t = now - start;
    headX += speed * dt;
    trail.unshift({ x: headX, y: yAtX(headX) });
    if (trail.length > 1200) trail.length = 1200;

    // resample the trail at even arc-length to get the spine nodes
    const nodes = [{ x: trail[0].x, y: trail[0].y }];
    let ti = 0, acc = 0;
    for (let j = 1; j < M; j++) {
      const target = j * seg;
      while (ti < trail.length - 1 && acc < target) {
        const a = trail[ti], b = trail[ti + 1];
        acc += Math.hypot(b.x - a.x, b.y - a.y);
        ti++;
      }
      nodes.push({ x: trail[ti].x, y: trail[ti].y });
    }

    // offset the spine by a tapering half-width to build the body outline
    const left = [], right = [];
    for (let j = 0; j < M; j++) {
      const p = nodes[j];
      const a = nodes[Math.max(0, j - 1)], b = nodes[Math.min(M - 1, j + 1)];
      let tx = b.x - a.x, ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
      const nx = -ty, ny = tx, w = widthAt(j);
      left.push([p.x + nx * w, p.y + ny * w]);
      right.push([p.x - nx * w, p.y - ny * w]);
    }
    let d = "M" + left[0][0].toFixed(1) + " " + left[0][1].toFixed(1);
    for (let j = 1; j < M; j++) d += "L" + left[j][0].toFixed(1) + " " + left[j][1].toFixed(1);
    d += "L" + nodes[M - 1].x.toFixed(1) + " " + nodes[M - 1].y.toFixed(1);
    for (let j = M - 1; j >= 0; j--) d += "L" + right[j][0].toFixed(1) + " " + right[j][1].toFixed(1);
    d += "Z";
    fill.setAttribute("d", d);
    clip.setAttribute("d", d);

    // a soft sheen running along the back, fading out before the tail
    let sd = "M" + nodes[0].x.toFixed(1) + " " + nodes[0].y.toFixed(1);
    const sheenN = Math.floor(M * 0.7);
    for (let j = 1; j < sheenN; j++) sd += "L" + nodes[j].x.toFixed(1) + " " + nodes[j].y.toFixed(1);
    sheen.setAttribute("d", sd);

    // scales travel with the body
    scalePat.setAttribute("patternTransform", `translate(${headX.toFixed(1)} 0)`);

    // head: oriented along the heading, with amber slit-eyes and a flicking tongue
    const hx = nodes[0].x, hy = nodes[0].y;
    let hdx = nodes[0].x - nodes[1].x, hdy = nodes[0].y - nodes[1].y;
    const hl = Math.hypot(hdx, hdy) || 1; hdx /= hl; hdy /= hl;
    const ang = Math.atan2(hdy, hdx) * 180 / Math.PI;
    const flick = Math.floor(t / 240) % 3 === 0;
    const tongue = flick
      ? `<path d="M13 0 L24 0 M24 0 L28 -3.4 M24 0 L28 3.4" stroke="#9b2226" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
      : `<path d="M13 0 L19 0 M19 0 L21.6 -1.6 M19 0 L21.6 1.6" stroke="#9b2226" stroke-width="1.5" fill="none" stroke-linecap="round" opacity="0.85"/>`;
    head.setAttribute("transform", `translate(${hx.toFixed(1)} ${hy.toFixed(1)}) rotate(${ang.toFixed(1)})`);
    head.innerHTML =
      `<ellipse cx="3" cy="0" rx="12.5" ry="9" fill="url(#snBody)" stroke="#0c2410" stroke-width="1.1"/>` +
      tongue +
      `<g><circle cx="3.5" cy="-5" r="2.7" fill="#c89b3c"/><circle cx="3.5" cy="-5" r="2.7" fill="none" stroke="#0c2410" stroke-width="0.7"/><rect x="2.8" y="-6.7" width="1.4" height="3.4" rx="0.6" fill="#0c2410"/></g>` +
      `<g><circle cx="3.5" cy="5" r="2.7" fill="#c89b3c"/><circle cx="3.5" cy="5" r="2.7" fill="none" stroke="#0c2410" stroke-width="0.7"/><rect x="2.8" y="3.3" width="1.4" height="3.4" rx="0.6" fill="#0c2410"/></g>` +
      `<circle cx="12" cy="-2" r="0.8" fill="#0c2410"/><circle cx="12" cy="2" r="0.8" fill="#0c2410"/>`;

    if (nodes[M - 1].x > W + 36) {           // tail has cleared the right edge
      svg.classList.add("leaving");
      snakeRaf = null;
      setTimeout(() => svg.remove(), 720);
      return;
    }
    snakeRaf = requestAnimationFrame(frame);
  }
  snakeRaf = requestAnimationFrame(frame);
}

// A burst of sparkles on a correct answer — the longer the streak, the
// bigger and more plentiful they get. A verse-bonus `boost` (fuller lyric recall)
// adds extra sparkles and size on top, so a word-perfect line pops the hardest.
function celebrateCorrect(streak, boost = 0) {
  if (motionReduced() || !settings.sparkles || settings.reducedFlashing) return;
  const card = $("screen-game");
  if (!card) return;
  const count = Math.min(5 + streak * 2 + boost * 4, 20);
  const sizeMin = Math.min(12 + (streak - 1) * 5 + boost * 6, 40);
  for (let i = 0; i < count; i++) {
    const s = document.createElement("span");
    s.className = "sparkle"; s.setAttribute("aria-hidden", "true");
    const size = Math.round(sizeMin + Math.random() * 14);
    s.style.width = s.style.height = size + "px";
    s.style.left = (12 + Math.random() * 72) + "%";
    s.style.top = (36 + Math.random() * 28) + "%";
    s.style.animationDelay = (Math.random() * 0.35).toFixed(2) + "s";
    s.style.animationDuration = (0.8 + Math.random() * 0.5).toFixed(2) + "s";
    s.innerHTML = SPARKLE_SVG;
    card.appendChild(s);
    setTimeout(() => s.remove(), 1600);
  }
}

function revealSecret13() {
  const h = document.querySelector("header.title");
  if (!h || h.querySelector(".secret-13")) return;
  const s = document.createElement("div");
  s.className = "secret-13"; s.setAttribute("aria-hidden", "true");
  s.textContent = "♡ 13 ♡";
  h.appendChild(s);
  setTimeout(() => s.remove(), 2600);
}

function celebratePerfect() {
  if (motionReduced() || settings.reducedFlashing) return;
  const card = $("screen-results");
  if (!card) return;
  const layer = document.createElement("div");
  layer.className = "star-shower"; layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 18; i++) {
    const st = document.createElement("span");
    st.className = "ss";
    st.style.left = (Math.random() * 100) + "%";
    st.style.width = st.style.height = (10 + Math.random() * 12) + "px";
    st.style.setProperty("--fall", (380 + Math.random() * 280) + "px");
    st.style.animationDuration = (1.6 + Math.random() * 1.4) + "s";
    st.style.animationDelay = (Math.random() * 0.8) + "s";
    st.innerHTML = STAR_SVG;
    layer.appendChild(st);
  }
  card.appendChild(layer);
  setTimeout(() => layer.remove(), 4200);
}

/* ---------- Input wiring ---------- */
function wireInput() {
  const input = $("songInput");
  input.addEventListener("input", () => {
    // Hard/Ultra have no autocomplete — you type the full title.
    if (currentMode.dropdown) {
      if (debounceId) clearTimeout(debounceId);
      debounceId = setTimeout(updateDropdown, 120);
    }
    handleTypingEggs(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if ($("settingsModal").classList.contains("open")) return;   // modal is captive
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();        // this keypress submits — don't let it also bubble to the page-advance handler
      // The dropdown refresh is debounced (120ms). If a keystroke is still
      // pending, flush it now so Enter accepts a match for what's *currently*
      // typed — not the previous query's stale top result. With the dropdown
      // off, dropdownItems stays empty and submitAnswer takes the exact-title path.
      if (currentMode.dropdown && debounceId) { clearTimeout(debounceId); debounceId = null; updateDropdown(); }
      submitAnswer(null, false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (dropdownItems.length) { activeIndex = (activeIndex + 1) % dropdownItems.length; renderDropdown(); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (dropdownItems.length) { activeIndex = (activeIndex - 1 + dropdownItems.length) % dropdownItems.length; renderDropdown(); }
    } else if (e.key === "Escape") {
      hideDropdown();
    }
  });
  // After a verdict the input is disabled, so a document-level Enter advances
  // the page: skips the correct-answer countdown, or fires "next page" on a miss.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (!screens.game.classList.contains("active") || !roundLocked) return;
    // Settings modal is captive — don't let Enter advance the page behind it.
    if ($("settingsModal").classList.contains("open")) return;
    // Only once a verdict is actually on the page — not during the pen-circle
    // animation between submitting and the feedback appearing.
    if (!$("cd") && !$("continueBtn")) return;
    // "Enter advances on a miss" off → require a click on the miss/answer screen.
    if (!settings.enterOnMiss && document.querySelector("#feedback .banner.bad")) return;
    e.preventDefault();
    advanceFromFeedback();
  });
}

/* ---------- Settings modal ---------- */
// Control builders — all keyed by a settings field; a change re-renders the body.
function setToggleHTML(key, name, desc) {
  return `<div class="set-row"><div class="set-label"><span class="set-name">${name}</span>` +
    (desc ? `<span class="set-desc">${desc}</span>` : "") + `</div>` +
    `<div class="set-control"><button type="button" class="set-toggle" data-toggle="${key}" aria-pressed="${!!settings[key]}" aria-label="${name}"></button></div></div>`;
}
function setChoiceHTML(key, name, desc, options) {
  const tabs = options.map((o) =>
    `<button type="button" class="mode-tab${o.val === settings[key] ? " active" : ""}" data-choice="${key}" data-val="${o.val}">${o.label}</button>`
  ).join("");
  return `<div class="set-row"><div class="set-label"><span class="set-name">${name}</span>` +
    (desc ? `<span class="set-desc">${desc}</span>` : "") + `</div>` +
    `<div class="set-control set-choice">${tabs}</div></div>`;
}
function setSliderHTML() {
  return `<div class="set-row"><div class="set-label"><span class="set-name">Countdown length</span>` +
    `<span class="set-desc">seconds before the next page auto-turns</span></div>` +
    `<div class="set-control set-slider-row"><input type="range" id="countdownSlider" class="set-slider" min="3" max="8" step="1" value="${settings.countdownSecs}">` +
    `<span class="set-slider-val" id="countdownVal">${settings.countdownSecs}s</span></div></div>`;
}
function setTextHTML(key, name, desc, placeholder) {
  return `<div class="set-row"><div class="set-label"><span class="set-name">${name}</span>` +
    (desc ? `<span class="set-desc">${desc}</span>` : "") + `</div>` +
    `<div class="set-control"><input type="text" class="set-text" id="set-${key}" maxlength="20" ` +
    `value="${escapeHtml(settings[key] || "")}" placeholder="${placeholder}"></div></div>`;
}
function setSection(title, inner) { return `<div class="set-section"><p class="set-section-title">${title}</p>${inner}</div>`; }

function renderSettingsBody() {
  const diffOpts = [{ val: "last", label: "Last" }].concat(MODE_ORDER.map((m) => ({ val: m, label: MODES[m].label })));
  const statsOpts = [{ val: "all", label: "All" }, { val: "last", label: "Last" }].concat(MODE_ORDER.map((m) => ({ val: m, label: MODES[m].label })));
  const body = $("settingsBody");
  body.innerHTML =
    setSection("Notebook",
      setTextHTML("playerName", "Your name", "signed on every personal record", "your name")
    ) +
    setSection("Motion &amp; animation",
      setChoiceHTML("reduceMotion", "Reduce motion", "Auto follows your system", [{ val: "auto", label: "Auto" }, { val: "on", label: "On" }, { val: "off", label: "Off" }]) +
      setChoiceHTML("animSpeed", "Animation speed", "", [{ val: "normal", label: "Normal" }, { val: "fast", label: "Fast" }, { val: "instant", label: "Instant" }]) +
      setToggleHTML("pageTurn", "Page-turn animation", "the paper flip between rounds") +
      setToggleHTML("penCircle", "Pen-circle confirm", "circles your pick before the verdict") +
      setToggleHTML("sparkles", "Sparkles", "a burst on a correct answer") +
      setToggleHTML("timerTension", "Timer tension", "vignette + tremor as the clock runs low") +
      setToggleHTML("snake", "Slithering snake", "the reputation-era easter egg") +
      setToggleHTML("reducedFlashing", "Reduced flashing", "also mutes the perfect-game star shower")
    ) +
    setSection("Gameplay",
      setToggleHTML("autoAdvance", "Auto-advance after a correct answer", "or wait and tap “next page”") +
      setSliderHTML() +
      setToggleHTML("enterOnMiss", "Enter advances on a miss", "press Enter to leave the answer screen") +
      setToggleHTML("showExamples", "Show example songs after a miss", "") +
      setChoiceHTML("defaultGameType", "Default game type", "on launch", [{ val: "last", label: "Last" }, { val: "classic", label: "Classic" }, { val: "infinite", label: "Infinite" }]) +
      setChoiceHTML("defaultDifficulty", "Default difficulty", "on launch", diffOpts) +
      setChoiceHTML("defaultStatsTab", "Default stats tab", "which tab opens first", statsOpts)
    ) +
    setSection("Display &amp; accessibility",
      setToggleHTML("highContrast", "High contrast", "darker ink, whiter paper") +
      setToggleHTML("colorBlindAlbums", "Colour-blind album colours", "a more distinguishable palette") +
      setToggleHTML("hideDailyScore", "Hide daily score until reveal", "")
    ) +
    setSection("Sound",
      setToggleHTML("sound", "Sound effects", "") +
      `<p class="set-note">no sounds yet — this just saves your preference.</p>`
    ) +
    setSection("Data",
      `<div class="set-actions"><button class="btn-ghost" data-action="export">Export backup</button>` +
      `<button class="btn-ghost" data-action="import">Import backup</button></div>`
    ) +
    `<div class="set-danger"><p class="set-section-title">danger zone — these can’t be undone</p>` +
      `<div class="set-danger-grid">` +
        `<button class="danger-btn" data-danger="hof">Reset records</button>` +
        `<button class="danger-btn" data-danger="stats">Reset stats &amp; streaks</button>` +
        `<button class="danger-btn" data-danger="ach">Reset achievements</button>` +
        `<button class="danger-btn" data-danger="tally">Reset catalogue</button>` +
        `<button class="danger-btn" data-danger="daily">Reset daily</button>` +
        `<button class="danger-btn wipe" data-danger="all">Clear everything</button>` +
      `</div></div>` +
    setSection("About",
      `<div class="set-about">` +
      `<p>Swift to the Song Association — a songwriter’s-notebook word game. Fan-made and unofficial; lyrics belong to their writers.</p>` +
      `<p><a href="https://github.com/swiftothecore/swift-association-testing" target="_blank" rel="noopener">View the project on GitHub →</a></p>` +
      `</div>`
    );
  wireSettingsBody();
}

let dangerTimer = null;
function wireSettingsBody() {
  const body = $("settingsBody");
  body.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.toggle;
    settings[k] = !settings[k];
    saveSettings(settings); applySettings(); renderSettingsBody();
  }));
  body.querySelectorAll("[data-choice]").forEach((b) => b.addEventListener("click", () => {
    settings[b.dataset.choice] = b.dataset.val;
    saveSettings(settings); applySettings(); renderSettingsBody();
  }));
  const slider = $("countdownSlider");
  if (slider) {
    slider.addEventListener("input", () => { $("countdownVal").textContent = slider.value + "s"; });
    slider.addEventListener("change", () => { settings.countdownSecs = parseInt(slider.value, 10) || 5; saveSettings(settings); });
  }
  const nameField = $("set-playerName");
  if (nameField) nameField.addEventListener("change", () => {
    settings.playerName = nameField.value.trim().slice(0, 20);
    saveSettings(settings);
    refreshStartBoard();   // re-sign the start-screen records live
    if (screens.records.classList.contains("active")) renderRecordsPage();
  });
  body.querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.action === "export") exportBackup();
    else if (b.dataset.action === "import") $("importFile").click();
  }));
  body.querySelectorAll("[data-danger]").forEach((b) => b.addEventListener("click", () => armDanger(b)));
}

// Each danger button needs a second confirming tap within 3s before it fires.
function armDanger(btn) {
  if (btn.classList.contains("armed")) { clearTimeout(dangerTimer); performDanger(btn.dataset.danger); return; }
  $("settingsBody").querySelectorAll(".danger-btn.armed").forEach((b) => { b.classList.remove("armed"); b.textContent = b.dataset.label || b.textContent; });
  btn.dataset.label = btn.textContent;
  btn.classList.add("armed");
  btn.textContent = "tap again to confirm";
  dangerTimer = setTimeout(() => { btn.classList.remove("armed"); btn.textContent = btn.dataset.label; }, 3000);
}
function performDanger(which) {
  if (which === "all") { clearAllData(); location.reload(); return; }
  if (which === "hof") resetRecords();
  else if (which === "stats") resetStatsAll();
  else if (which === "ach") { resetAchievements(); earnedAchievements = loadAchievements(); }
  else if (which === "tally") resetTally();
  else if (which === "daily") resetDaily();
  refreshStartBoard();
  renderSettingsBody();   // clears armed states and re-reads any reset data
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(exportData(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "swift-association-backup-" + todayKey() + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Pause the round timer while the modal is open; resume from where it left off.
function pauseForSettings() {
  pausedRemaining = null;
  if (timerId && screens.game.classList.contains("active") && !roundLocked && currentMode.seconds > 0) {
    const elapsed = (performance.now() - timerStart) / 1000;
    pausedRemaining = Math.max(0.1, currentMode.seconds - elapsed);
    clearTimer();
  }
}
function resumeFromSettings() {
  if (pausedRemaining == null) return;
  const r = pausedRemaining;
  pausedRemaining = null;
  if (screens.game.classList.contains("active") && !roundLocked && currentMode.seconds > 0) startTimer(r);
}
function openSettings() {
  unlock("i-look-in-windows");
  pauseForSettings();
  renderSettingsBody();
  const m = $("settingsModal");
  m.classList.add("open");
  m.setAttribute("aria-hidden", "false");
}
function closeSettings() {
  const m = $("settingsModal");
  if (!m.classList.contains("open")) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden", "true");
  resumeFromSettings();
}

/* ---------- Init ---------- */
async function init() {
  showScreen("start");
  applyEra("gold");
  earnedAchievements = loadAchievements();
  settings = loadSettings();
  applySettings();
  migrateRecordsFromStats();   // seed records from pre-existing stats once, before any game runs
  console.log("%c♡ written in the margins · 13 pages of you ♡", "font-size:14px;color:#a9791f;font-family:cursive;");
  currentMode = loadMode();
  // Default game type on launch (or restore the last one played).
  gameType = settings.defaultGameType === "infinite" ? "infinite"
           : settings.defaultGameType === "classic" ? "classic"
           : (settings.lastGameType === "infinite" ? "infinite" : "classic");
  renderStartPickers();
  const titleEl = document.querySelector("header.title h1");
  if (titleEl) titleEl.addEventListener("click", () => {
    if (++titleTaps >= 13) { titleTaps = 0; revealSecret13(); }
  });
  $("playBtn").addEventListener("click", () => {
    if (gameType === "infinite") startInfinite(infiniteVariant);
    else startGame();
  });
  $("dailyBtn").addEventListener("click", startDaily);
  $("statsBtn").addEventListener("click", () => { statsBackTarget = "start"; renderStats(null); showScreen("stats"); });
  $("resultsStatsBtn").addEventListener("click", () => { statsBackTarget = "results"; renderStats(score); showScreen("stats"); });
  $("statsBackBtn").addEventListener("click", () => {
    const prev = statsBackTarget;
    showScreen(prev);
    if (prev === "start") { $("startContent").style.display = ""; }
  });
  $("recordsBtn").addEventListener("click", () => openRecords("start"));
  $("viewRecordsBtn").addEventListener("click", () => openRecords("results"));
  $("recordsBackBtn").addEventListener("click", () => {
    const prev = recordsBackTarget;
    showScreen(prev);
    if (prev === "start") { $("startContent").style.display = ""; }
  });
  $("againBtn").addEventListener("click", () => {
    applyEra("gold");
    renderStartPickers();
    showScreen("start");
    $("startContent").style.display = "";
  });
  // Roll a finished classic run straight into endless play, carrying the score.
  $("keepGoingBtn").addEventListener("click", () => startInfinite("3lives", { carry: true }));

  // Settings modal — openable from any screen (gear), closed by ✕, scrim, or ESC.
  $("settingsGear").addEventListener("click", openSettings);
  $("settingsCloseBtn").addEventListener("click", closeSettings);
  $("settingsScrim").addEventListener("click", closeSettings);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("settingsModal").classList.contains("open")) closeSettings();
  });
  $("importFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";   // allow re-picking the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let n = 0;
      try { n = importData(JSON.parse(reader.result)); }
      catch (err) { alert("Couldn't read that backup file."); return; }
      if (n > 0) { alert("Restored " + n + " item(s). Reloading…"); location.reload(); }
      else alert("Nothing to restore from that file.");
    };
    reader.readAsText(file);
  });
  wireInput();

  try {
    await loadData();
    $("loading").style.display = "none";
    $("startContent").style.display = "";
    refreshStartBoard();
  } catch (err) {
    $("loading").outerHTML = `
      <div class="error">
        <p><b>Couldn't open the notebook.</b></p>
        <p>${escapeHtml(err.message)}</p>
        <p>Try refreshing the page.</p>
      </div>`;
  }
}

document.addEventListener("DOMContentLoaded", init);

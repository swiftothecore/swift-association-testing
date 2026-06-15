"use strict";
import { $, escapeRegExp, escapeHtml, prefersReducedMotion, shuffle, chance, normalizeTitle, normalizeLyric, fuzzySubstringRatio, mulberry32, dailySeed } from "./util.js";
import {
  TOTAL_ROUNDS, RECENT_WINDOW, DIFF_KEY,
  MODES, MODE_ORDER, INFINITE_DEFAULT_PODIUM,
  ERAS, TENDER_ERAS, FINALE_ERAS,
  ALBUM_COLORS, TITLE_ALIASES,
  ACHIEVEMENTS, ACH_ICONS, ACH_BY_ID,
  PEN_SVG, STAR_SVG, SPARKLE_SVG, DOODLE_SVG,
} from "./config.js";
import { buildBraceletSVG } from "./bracelet.js";
import {
  loadHighScores, saveHighScores,
  loadStats, updateStats, totalPlayed,
  loadAchievements, saveAchievements,
  loadMode,
  loadDailyResult, saveDailyResult, loadDailyBoard, saveDailyBoard,
  bumpDailyStreak, effectiveDailyStreak,
  markTypePlayed,
  loadSongTally, recordGameTally,
} from "./storage.js";

/* ---------- Constants & state ---------- */
// Lyric-line answering: a typed line must be at least this many words (so a bare
// prompt-word echo can't pass), and must match a real word-bearing lyric line at or
// above this fuzzy similarity (1 = verbatim; lower tolerates typos / a partial line).
const MIN_LYRIC_WORDS = 3;
const FUZZY_THRESHOLD = 0.8;

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

/* ---------- DOM ---------- */
const screens = {
  start: $("screen-start"),
  game: $("screen-game"),
  results: $("screen-results"),
  stats: $("screen-stats"),
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
// Lenient (default) matches derived forms via the [a-z']* tail (gold→golden);
// strict (Ultra) requires the exact word. Defaults to the active mode.
function wordRegex(word, strict) {
  if (strict === undefined) strict = currentMode.strict;
  const tail = strict ? "" : "[a-z']*";
  return new RegExp("\\b" + escapeRegExp(word) + tail + "\\b", "i");
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
function extractLineWithWord(lyrics, word, strict) {
  const rx = wordRegex(word, strict);
  const lines = lyrics.split("\n");
  const line = lines.find((l) => rx.test(l)) || lines[0] || "";
  return line.trim();
}
function highlightWord(line, word, strict) {
  if (strict === undefined) strict = currentMode.strict;
  const tail = strict ? "" : "[a-z']*";
  const rx = new RegExp("\\b(" + escapeRegExp(word) + tail + ")\\b", "ig");
  return escapeHtml(line).replace(rx, "<mark>$1</mark>");
}

/* ---------- Stats ---------- */
function renderStats(lastScore, viewMode = currentMode.id) {
  const s = loadStats(viewMode);
  const el = $("statsBody");
  // mode tabs — browse each difficulty's separate stats
  const tabs = `<div class="mode-tabs stats-tabs">` + MODE_ORDER.map((m) =>
    `<button type="button" class="mode-tab${m === viewMode ? " active" : ""}" data-statmode="${m}">${MODES[m].label}</button>`
  ).join("") + `</div>`;

  let body;
  if (s.played === 0) {
    body = `<p class="stats-empty">no games yet in ${MODES[viewMode].label} — start writing!</p>`;
  } else {
    const avg = (s.totalScore / s.played).toFixed(1);
    const maxCount = Math.max(...s.scoreCounts, 1);
    // highlight the just-played bar only on the mode that was actually played
    const youScore = (viewMode === currentMode.id) ? lastScore : null;
    const bars = s.scoreCounts.map((count, score) => {
      const h = Math.round((count / maxCount) * 56);
      const isYou = (score === youScore);
      return `<div class="histogram-col">
        <div class="histogram-bar${isYou ? " has-you" : ""}" style="height:${Math.max(h, count > 0 ? 4 : 2)}px"></div>
        <div class="histogram-score">${score}</div>
      </div>`;
    }).join("");
    body = `
      <div class="stats-grid">
        <div class="stat-cell"><span class="stat-val">${s.played}</span><span class="stat-lbl">Played</span></div>
        <div class="stat-cell"><span class="stat-val">${s.best}</span><span class="stat-lbl">Best</span></div>
        <div class="stat-cell"><span class="stat-val">${avg}</span><span class="stat-lbl">Average</span></div>
      </div>
      <div class="streak-row">
        <div class="streak-cell"><span class="stat-val">${s.currentStreak}</span><span class="stat-lbl">Current streak</span></div>
        <div class="streak-cell"><span class="stat-val">${s.maxStreak}</span><span class="stat-lbl">Best streak</span></div>
      </div>
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
function favRow(label, value, note) {
  return `<div class="fav-row"><span class="fav-lbl">${escapeHtml(label)}</span>` +
    `<span class="fav-val">${escapeHtml(value)}` +
    (note ? ` <span class="fav-note">${escapeHtml(note)}</span>` : "") + `</span></div>`;
}

// Lifetime catalog stats — global (not per-mode), drawn from the per-song/per-word
// tally written in endGame. Shows under every Stats tab, like the daily streak.
function lifetimeStatsHTML() {
  const t = loadSongTally();
  const discovered = Object.keys(t.songs).length;
  const total = allSongs.length;
  const favSong = topTallyEntry(t.songs);
  const favAlbum = topTallyEntry(t.albums);
  const nemesis = topTallyEntry(t.misses);
  const header = `<p class="histogram-label" style="margin-top:24px;">your catalog</p>`;
  if (!discovered && !nemesis) {
    return header + `<p class="stats-empty">no answers logged yet — play a game to start your catalog!</p>`;
  }
  const rows = [
    favRow("Favourite song", favSong ? favSong.key : "—", favSong ? `×${favSong.count}` : ""),
    favRow("Favourite album", favAlbum ? favAlbum.key : "—", favAlbum ? `×${favAlbum.count}` : ""),
    favRow("Nemesis word", nemesis ? `"${nemesis.key}"` : "—", nemesis ? `missed ×${nemesis.count}` : ""),
    favRow("Songs discovered", `${discovered} / ${total}`, ""),
  ];
  return header + `<div class="fav-list">${rows.join("")}</div>`;
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
function infiniteStatsHTML() {
  const rows = [];
  for (const variant of ["3lives", "sudden"]) {
    for (const m of MODE_ORDER) {
      const st = loadStats("inf-" + variant + "-" + m);
      if (st.played > 0) {
        rows.push(`<tr><td>${VARIANT_LABELS[variant]}</td><td>${MODES[m].label}</td>` +
          `<td class="num">${st.best}</td><td class="num">${st.played}</td></tr>`);
      }
    }
  }
  if (!rows.length) {
    return `<p class="histogram-label" style="margin-top:24px;">infinite</p>` +
      `<p class="stats-empty">no infinite runs yet — try Infinite mode!</p>`;
  }
  return `<p class="histogram-label" style="margin-top:24px;">infinite · best rounds survived</p>` +
    `<table class="inf-stats"><thead><tr><th>lives</th><th>difficulty</th>` +
    `<th class="num">best</th><th class="num">played</th></tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table>`;
}

/* ---------- Achievements ---------- */
let earnedAchievements = {};   // persisted: { id: "YYYY-MM-DD" }
let newlyUnlocked = [];        // ids unlocked this game (for the results recap)

function charmMarkup(icon) { return `<span class="charm" aria-hidden="true">${ACH_ICONS[icon]}</span>`; }

// Every unlock pops a toast. Already-earned ids no-op above, so a charm earned
// mid-game (toasted during play) never re-toasts at end-of-game. When several
// unlock at once (typically at endGame), the toasts stack in the corner.
function unlock(id) {
  if (!ACH_BY_ID[id] || earnedAchievements[id]) return;
  earnedAchievements[id] = new Date().toISOString().slice(0, 10);
  saveAchievements(earnedAchievements);
  newlyUnlocked.push(id);
  showToast(ACH_BY_ID[id]);
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

/* ---------- High scores (separate board per mode) ---------- */
function renderPodium(el, list, youName) {
  el.innerHTML = "";
  list.forEach((entry, i) => {
    const li = document.createElement("li");
    li.classList.add("rank-" + (i + 1));
    if (youName && entry.name === youName && entry.__you) li.classList.add("you");
    const num = String(i + 1).padStart(2, "0");
    const leader = i === 0 ? `<span class="leader-tag">★ leader</span>` : "";
    const tag = li.classList.contains("you") ? `<span class="you-tag">you</span>` : "";
    li.innerHTML =
      `<span class="rank-num">${num}</span>` +
      `<span class="name">${escapeHtml(entry.name)} ${leader}${tag}</span>` +
      `<span class="pts">${entry.score}</span>`;
    el.appendChild(li);
  });
}

/* ---------- Bracelet (hand-strung SVG) ---------- */
let justEarnedIndex = -1; // bead that just became a charm, for the swing-in

function renderBracelet() {
  const opts = gameType === "infinite" ? { total: Math.max(round, 1), letterBead: false } : undefined;
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

// The start-screen Hall of Fame follows the selected mode (+ infinite variant).
function refreshStartBoard() {
  const t = $("startPodiumTitle");
  const label = gameType === "infinite"
    ? VARIANT_LABELS[infiniteVariant] + " · " + currentMode.label
    : currentMode.label;
  if (t) t.textContent = "Hall of Fame · " + label;
  const fallback = gameType === "infinite" ? INFINITE_DEFAULT_PODIUM : undefined;
  renderPodium($("startPodium"), sortHs(loadHighScores(boardMode(), fallback)), null);
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
  el.textContent = gameType === "infinite"
    ? `endless pages · ${currentMode.seconds} seconds each`
    : `${TOTAL_ROUNDS} pages · ${currentMode.seconds} seconds each`;
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
  // player's saved preference so the difficulty picker reflects their choice.
  currentMode = loadMode();
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
  $("resultBracelet").innerHTML = buildBraceletSVG(roundResults, 0, -1, roundAlbums);
  $("finalScore").textContent = score;
  $("finalSub").textContent = "out of " + TOTAL_ROUNDS;
  $("keepGoingBtn").style.display = "none";
  $("resultAchievements").style.display = "none";
  $("namePrompt").style.display = "none";
  renderPodium($("resultPodium"), sortHs(loadDailyBoard(dateStr)), null);
  document.querySelector("#screen-results .podium-title").textContent = "Today's Board";
  renderShareButton(dateStr);
}

// Wordle-style copyable summary built from the per-round results.
function buildShareString(dateStr) {
  const dateObj = new Date(dateStr + "T00:00:00Z");
  const label = dateObj.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const emoji = roundResults.map((r) => (r ? "⭐" : "⬜")).join("");
  return `Swift Song Association 🎵\nDaily Challenge · ${label}\n${emoji}\n${score}/${TOTAL_ROUNDS}`;
}

function renderShareButton(dateStr) {
  const existing = $("shareBtn");
  if (existing) existing.remove();
  const btn = document.createElement("button");
  btn.id = "shareBtn";
  btn.className = "btn-ghost daily-share-btn";
  btn.textContent = "Copy result";
  btn.addEventListener("click", async () => {
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
    setTimeout(() => { btn.textContent = "Copy result"; }, 2000);
  });
  const braceletEl = $("resultBracelet");
  braceletEl.parentNode.insertBefore(btn, braceletEl.nextSibling);
}

// The daily leaderboard, reusing the regular podium renderer + name-prompt flow.
function renderDailyBoard(dateStr) {
  const dailyList = loadDailyBoard(dateStr);
  const lowest = dailyList.length >= 5 ? dailyList[dailyList.length - 1].score : -1;
  const beats = dailyList.length < 5 || score > lowest;
  const nameDiv = $("namePrompt");
  const titleEl = document.querySelector("#screen-results .podium-title");
  titleEl.textContent = "Today's Board";
  if (beats && score > 0) {
    nameDiv.style.display = "";
    renderPodium($("resultPodium"), sortHs(dailyList), null);
    const save = () => {
      const name = ($("nameInput").value || "You").trim().slice(0, 20) || "You";
      const updated = sortHs(dailyList.concat([{ name, score, __you: true }])).slice(0, 5);
      saveDailyBoard(updated.map(({ name, score }) => ({ name, score })), dateStr);
      nameDiv.style.display = "none";
      renderPodium($("resultPodium"), updated, name);
      titleEl.textContent = "Today's Board";
    };
    $("saveNameBtn").onclick = save;
    $("nameInput").onkeydown = (e) => { if (e.key === "Enter") save(); };
    setTimeout(() => $("nameInput").focus(), 50);
  } else {
    nameDiv.style.display = "none";
    renderPodium($("resultPodium"), sortHs(dailyList), null);
  }
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
  // First round (from the start screen) and reduced motion advance instantly.
  if (round === 0 || prefersReducedMotion()) {
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
  setTimeout(finish, 500);
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
  $("feedback").innerHTML = "";
  $("playArea").style.display = "";
  renderBracelet();
  renderLives();
  const input = $("songInput");
  input.value = "";
  input.disabled = false;
  hideDropdown();
  input.focus();

  resetTension();
  runRoundEggs();
  // Note: the timer is started by the caller (nextRound) — for a page turn it
  // only starts once the flip finishes, so no time is lost during the animation.
}

function startTimer() {
  clearTimer();
  timerStart = performance.now();
  const fill = $("timerFill");
  const label = $("timerLabel");
  const total = currentMode.seconds;
  fill.style.width = "100%";
  fill.classList.remove("low");
  label.textContent = total.toFixed(1);

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
  document.body.style.setProperty("--tension", String(t));
}
function updateTally(remaining) {
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
    div.className = "item" + (i === activeIndex ? " active" : "");
    div.innerHTML = `${escapeHtml(song.title)}`;
    div.addEventListener("mousedown", (e) => {
      e.preventDefault();
      submitAnswer(song, false);
    });
    dd.appendChild(div);
  });
  dd.classList.add("show");
}
function hideDropdown() { $("dropdown").classList.remove("show"); }

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
  // The typed phrase must hold the prompt word (stem-lenient by default; exact in
  // Ultra via currentMode.strict — so a stem-only line like "golden" for "gold" fails).
  if (!wordRegex(currentWord).test(phrase)) return null;

  // Fast path: a verbatim contiguous run anywhere in the lyrics (incl. across lines).
  for (const s of currentSongs) {
    if (s._normLyrics.includes(normPhrase)) {
      return { song: s, line: recoverLyricLine(s, normPhrase) };
    }
  }

  // Fuzzy path: best-matching word-bearing line per song; keep the best overall.
  const rx = wordRegex(currentWord);
  let best = null;
  for (const s of currentSongs) {
    const lines = s.lyrics.split("\n");
    for (const raw of lines) {
      if (!rx.test(raw)) continue;
      const ratio = fuzzySubstringRatio(normPhrase, normalizeLyric(raw));
      if (ratio < FUZZY_THRESHOLD) continue;
      if (!best || ratio > best.ratio ||
          (ratio === best.ratio && (s.lyrics.length < best.song.lyrics.length ||
            (s.lyrics.length === best.song.lyrics.length && s.title < best.song.title)))) {
        best = { song: s, line: raw.trim(), ratio };
      }
    }
  }
  return best ? { song: best.song, line: best.line } : null;
}

// Recover the original lyric line (for display) that holds the matched phrase.
function recoverLyricLine(song, normPhrase) {
  const lines = song.lyrics.split("\n");
  const hit = lines.find((l) => normalizeLyric(l).includes(normPhrase));
  return (hit || lines[0] || "").trim();
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

  if (lyricMatch) lyricLineAnswers++;   // recalled a lyric line (for You Knew The Line)

  // achievements: timing + streak signals (mid-game unlocks toast immediately)
  const elapsed = (performance.now() - timerStart) / 1000;
  const remaining = currentMode.seconds - elapsed;
  if (isTimeout) gameTimeouts++;
  if (correct) {
    if (elapsed < 2) unlock("speak-now");
    if (remaining < 1) unlock("getaway-car");
  }
  gameMaxStreak = Math.max(gameMaxStreak, correctStreak);
  if (correctStreak >= 5) unlock("bejeweled");
  if (correctStreak >= 10) unlock("sparks-fly");

  // Circle the player's pick before revealing the verdict (skipped on timeout / reduced
  // motion, and on a lyric answer — the circle re-draws a title the player never typed).
  const reveal = () => (correct ? showCorrectFeedback(song, lyricMatch) : showWrongFeedback(song, isTimeout));
  if (song && !isTimeout && !lyricMatch && !prefersReducedMotion()) {
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
  setTimeout(done, 640);
}

function lyricCard(song, word, isWrong, lineOverride) {
  const line = lineOverride != null ? lineOverride : extractLineWithWord(song.lyrics, word);
  const color = ALBUM_COLORS[song.album] || "var(--ink-soft)";
  const albumLabel = song.album ? `<span class="album-tag" style="--album-color:${color}">${escapeHtml(song.album)}</span>` : "";
  const cls = isWrong ? " wrong-card" : "";
  return `<div class="lyric-card${cls}" style="--album-color:${color}">
    <div class="song-title">${escapeHtml(song.title)}${albumLabel}</div>
    <div class="lyric-line">"${highlightWord(line, word)}"</div>
  </div>`;
}

function showCorrectFeedback(song, lyricMatch) {
  const fb = $("feedback");
  // On a lyric answer, celebrate the recall and show the exact line they typed.
  const banner = lyricMatch ? "✓ you knew the line" : "✓ that's the one";
  const card = lyricMatch
    ? lyricCard(song, currentWord, false, lyricMatch.line)
    : lyricCard(song, currentWord, false);
  fb.innerHTML = `
    <div class="banner good">${banner}</div>
    ${card}
    <div class="countdown">next page in <b id="cd">5</b></div>
    <button id="skipBtn" class="countdown-skip">skip →</button>`;
  $("skipBtn").addEventListener("click", advanceFromFeedback);
  celebrateCorrect(correctStreak);
  runCountdown();
}

function showWrongFeedback(song, isTimeout) {
  const fb = $("feedback");
  const reason = isTimeout ? "the page ran out" : "not this verse";
  // Ultra offers no help — examples is 0, so skip the cards and the label.
  const n = currentMode.examples;
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
  let n = 5;
  const el = $("cd");
  if (countdownId) clearInterval(countdownId);
  countdownId = setInterval(() => {
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

  // Daily plays don't touch any mode's stats board.
  if (!isDaily) updateStats(boardScore, mode);

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
  }
  if (isInfinite) {
    if (roundsSurvived >= 20) unlock("out-of-the-woods");
    if (roundsSurvived === 22) unlock("twenty-two");
  }
  // Lyric-line recall counts in any game type.
  if (lyricLineAnswers >= 5) unlock("you-knew-the-line");

  showScreen("results");
  const keepsakeOpts = isInfinite
    ? { total: Math.max(roundsSurvived, 1), letterBead: false }
    : undefined;
  $("resultBracelet").innerHTML = buildBraceletSVG(roundResults, 0, -1, roundAlbums, keepsakeOpts);
  $("finalScore").textContent = boardScore;
  $("finalSub").textContent = isInfinite ? "rounds · " + score + " correct" : "out of " + TOTAL_ROUNDS;
  $("keepGoingBtn").style.display = (isInfinite || isDaily) ? "none" : "";
  renderResultRecap();
  if (!isInfinite && score === TOTAL_ROUNDS) celebratePerfect();

  // Daily: persist the result, lock to one play/day, show the daily board + share.
  if (isDaily) {
    const dateStr = todayKey();
    saveDailyResult(dateStr, { score, roundResults: roundResults.slice(), roundAlbums: roundAlbums.slice() });
    bumpDailyStreak(dateStr);   // extend (or reset) the consecutive-days streak
    unlock("today-was-a-fairytale");   // finished a Daily Challenge
    dailyRng = null;   // back to Math.random() for any subsequent Classic game
    renderDailyBoard(dateStr);
    renderShareButton(dateStr);
    return;
  }

  // Reset any daily-only chrome left over from a previous daily results view.
  document.querySelector("#screen-results .podium-title").textContent = "Hall of Fame";
  const staleShare = $("shareBtn");
  if (staleShare) staleShare.remove();

  const fallback = isInfinite ? INFINITE_DEFAULT_PODIUM : undefined;
  const list = loadHighScores(mode, fallback);
  const lowest = list.length >= 5 ? list[list.length - 1].score : -1;
  const beats = list.length < 5 || boardScore > lowest;

  const nameDiv = $("namePrompt");
  if (beats && boardScore > 0) {
    nameDiv.style.display = "";
    renderPodium($("resultPodium"), sortHs(list), null);
    const save = () => {
      const name = ($("nameInput").value || "You").trim().slice(0, 20) || "You";
      const updated = sortHs(list.concat([{ name, score: boardScore, __you: true }])).slice(0, 5);
      saveHighScores(updated.map(({ name, score }) => ({ name, score })), mode);
      nameDiv.style.display = "none";
      renderPodium($("resultPodium"), updated, name);
    };
    $("saveNameBtn").onclick = save;
    $("nameInput").onkeydown = (e) => { if (e.key === "Enter") save(); };
    setTimeout(() => $("nameInput").focus(), 50);
  } else {
    nameDiv.style.display = "none";
    renderPodium($("resultPodium"), sortHs(list), null);
  }
}
function sortHs(list) { return list.slice().sort((a, b) => b.score - a.score); }

/* ---------- Easter eggs (Phase 8) ---------- */
let titleTaps = 0;
let activePen = null;            // 'quill' | 'fountain' | 'glitter' | null
let blueUsedThisRound = false;
let correctStreak = 0;           // consecutive correct answers this game
let gameTimeouts = 0;            // timeouts this game (for Fearless)
let gameMaxStreak = 0;           // best streak reached this game
let lyricLineAnswers = 0;        // lyric-line answers this game (for You Knew The Line)

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
  } else if (era === "graphite" && chance(0.5)) {
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
  if (prefersReducedMotion()) { addDoodle("snake", "corner-br", 84, 60); return; }
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
// bigger and more plentiful they get.
function celebrateCorrect(streak) {
  if (prefersReducedMotion()) return;
  const card = $("screen-game");
  if (!card) return;
  const count = Math.min(5 + streak * 2, 16);
  const sizeMin = Math.min(12 + (streak - 1) * 5, 36);
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
  if (prefersReducedMotion()) return;
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
    // Only once a verdict is actually on the page — not during the pen-circle
    // animation between submitting and the feedback appearing.
    if (!$("cd") && !$("continueBtn")) return;
    e.preventDefault();
    advanceFromFeedback();
  });
}

/* ---------- Init ---------- */
async function init() {
  showScreen("start");
  applyEra("gold");
  earnedAchievements = loadAchievements();
  console.log("%c♡ written in the margins · 13 pages of you ♡", "font-size:14px;color:#a9791f;font-family:cursive;");
  currentMode = loadMode();
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
  $("againBtn").addEventListener("click", () => {
    applyEra("gold");
    renderStartPickers();
    showScreen("start");
    $("startContent").style.display = "";
  });
  // Roll a finished classic run straight into endless play, carrying the score.
  $("keepGoingBtn").addEventListener("click", () => startInfinite("3lives", { carry: true }));
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

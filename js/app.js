"use strict";

/* ---------- Constants & state ---------- */
const TOTAL_ROUNDS = 13;
const ROUND_SECONDS = 10;
const RECENT_WINDOW = 5;
const HS_KEY = "swiftSongAssociation.highscores";
const STATS_KEY = "swiftSongAssociation.stats";
const STREAK_THRESHOLD = 7; // score >= this counts toward a streak

/* Difficulty modes — each just re-tunes existing levers (timer, dropdown,
   word-rarity pool, matching strictness, wrong-answer help). Gameplay code is
   shared; the mode object sets the parameters. */
const MODES = {
  easy:   { id: "easy",   label: "Easy",   seconds: 15, dropdown: true,  pool: "easy",  strict: false, noTitle: false, examples: 3, blurb: "15s · hints on · common words" },
  medium: { id: "medium", label: "Medium", seconds: 10, dropdown: true,  pool: "all",   strict: false, noTitle: false, examples: 3, blurb: "10s · hints on · all words" },
  hard:   { id: "hard",   label: "Hard",   seconds: 7,  dropdown: false, pool: "hard",  strict: false, noTitle: true,  examples: 3, blurb: "7s · no hints · rarer words · not in the title" },
  ultra:  { id: "ultra",  label: "Ultra",  seconds: 5,  dropdown: false, pool: "ultra", strict: true,  noTitle: true,  examples: 0, blurb: "5s · no hints · rarest · exact · not in the title" },
};
const MODE_ORDER = ["easy", "medium", "hard", "ultra"];
const DIFF_KEY = "swiftSongAssociation.difficulty";
let currentMode = MODES.medium;
let wordBuckets = { easy: [], all: [], hard: [], ultra: [] };
const DEFAULT_PODIUM = [
  { name: "Sabrina Carpenter", score: 13 },
  { name: "Taylor Swift", score: 12 },
  { name: "Olivia Rodrigo", score: 10 },
  { name: "SwiftLover13", score: 8 },
  { name: "Selena Gomez", score: 4 },
];

/* Era engine */
const ERAS = ["gold", "lavender", "red", "denim", "graphite", "midnight"];
const TENDER_ERAS = ["lavender", "denim"];   // round 5 (Track 5) leans tender
const FINALE_ERAS = ["gold", "midnight"];    // round 13 leans grand
let recentEras = [];

let allSongs = [];
let playableWords = [];
let score = 0;
let round = 0;
let recentWords = [];
let roundResults = [];   // per-round true/false for the bracelet
let roundAlbums = [];    // per-round album of the picked song (for the final bracelet)
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
const $ = (id) => document.getElementById(id);
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
  if (round === 5) pool = TENDER_ERAS;
  else if (round === TOTAL_ROUNDS) pool = FINALE_ERAS;
  else pool = ERAS.filter((e) => !recentEras.includes(e));
  if (!pool.length) pool = ERAS;
  const era = pool[Math.floor(Math.random() * pool.length)];
  recentEras.push(era);
  if (recentEras.length > 3) recentEras.shift();
  return era;
}
function applyEra(era) { document.body.setAttribute("data-era", era); }

/* ---------- Matching helpers ---------- */
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
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
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------- Stats ---------- */
// Medium keeps the legacy key for back-compat; other modes get a suffix.
function statsKey(mode) { return mode === "medium" ? STATS_KEY : STATS_KEY + "." + mode; }
function loadStats(mode = currentMode.id) {
  try {
    const raw = localStorage.getItem(statsKey(mode));
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.played === "number") return s;
    }
  } catch (e) { /* ignore */ }
  return { played: 0, best: 0, totalScore: 0, scoreCounts: Array(14).fill(0), lastPlayed: null, currentStreak: 0, maxStreak: 0 };
}
function saveStats(s, mode = currentMode.id) {
  try { localStorage.setItem(statsKey(mode), JSON.stringify(s)); } catch (e) { /* ignore */ }
}
// Total games across every mode — for the global "play N games" achievements.
function totalPlayed() { return MODE_ORDER.reduce((n, m) => n + loadStats(m).played, 0); }
function updateStats(gameScore, mode = currentMode.id) {
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

  el.innerHTML = tabs + body + achievementsGridHTML();
  el.querySelectorAll("[data-statmode]").forEach((b) =>
    b.addEventListener("click", () => renderStats(lastScore, b.dataset.statmode)));
}

/* ---------- Achievements ---------- */
const ACH_KEY = "swiftSongAssociation.achievements";
const ACH_ICONS = {
  // hung charms: filled bead bodies (ink-fill) with inked detail (ink)
  star:    `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 2.2 L14.7 8.7 L21.7 9.3 L16.3 13.9 L18 20.8 L12 17.1 L6 20.8 L7.7 13.9 L2.3 9.3 L9.3 8.7 Z"/><path class="ink" stroke-width="0.9" opacity="0.7" d="M12 6 L13.2 9.2 L16.6 9.5"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M10.6 1.6 C11.6 7.4 14 9.8 19.8 10.8 C14 11.8 11.6 14.2 10.6 20 C9.6 14.2 7.2 11.8 1.4 10.8 C7.2 9.8 9.6 7.4 10.6 1.6 Z"/><path class="ink-fill" d="M18.8 14.6 C19.2 16.6 19.8 17.2 21.8 17.6 C19.8 18 19.2 18.6 18.8 20.6 C18.4 18.6 17.8 18 15.8 17.6 C17.8 17.2 18.4 16.6 18.8 14.6 Z"/></svg>`,
  shield:  `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 1.8 L20 4.6 V11 C20 16.2 16.6 20.2 12 22.2 C7.4 20.2 4 16.2 4 11 V4.6 Z"/><path class="ink" d="M8.3 11.8 l2.7 2.7 4.8 -5.6"/></svg>`,
  bolt:    `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M13.6 1.8 L4.4 13.6 H10 L9 22.2 L19.6 9.5 H13.3 Z"/><path class="ink" stroke-width="0.9" opacity="0.6" d="M12 6 L9 13"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path class="ink" stroke-width="2.1" d="M19.4 14.2 A8 8 0 1 1 17 6.4"/><path class="ink-fill" d="M17.3 1.4 L19.1 7.6 L12.8 6.7 Z"/></svg>`,
  key:     `<svg viewBox="0 0 24 24"><circle class="ink-fill" cx="8" cy="8" r="5.4"/><circle cx="8" cy="8" r="1.9" fill="var(--paper)"/><path class="ink" d="M11.8 11.8 L20 20 M16.8 16.8 l2.4 -2.4 M14.2 14.2 l2.2 -2.2"/></svg>`,
  gem:     `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M6.6 3 H17.4 L21.6 9 L12 21.6 L2.4 9 Z"/><path class="ink" d="M2.4 9 H21.6 M8.8 3 L6.9 9 L12 21.6 M15.2 3 L17.1 9 L12 21.6"/></svg>`,
  rise:    `<svg viewBox="0 0 24 24"><path class="ink" stroke-width="2.1" stroke-linecap="round" d="M3 19 L9.5 12.5 L13 16 L20.5 6.5"/><path class="ink-fill" d="M14.6 5 L21.5 4 L21 10.8 Z"/></svg>`,
};
const ACHIEVEMENTS = [
  { id: "enchanted",        name: "Enchanted",        desc: "Finish your first game",              secret: false, icon: "sparkle" },
  { id: "mastermind",       name: "Mastermind",       desc: "Score a perfect 13/13",               secret: false, icon: "star" },
  { id: "fearless",         name: "Fearless",         desc: "Finish with no timeouts",             secret: false, icon: "shield" },
  { id: "speak-now",        name: "Speak Now",        desc: "Answer correctly in under 2s",        secret: false, icon: "bolt" },
  { id: "begin-again",      name: "Begin Again",      desc: "Play 5 games",                        secret: false, icon: "refresh" },
  { id: "getaway-car",      name: "Getaway Car",      desc: "Answer correctly with under 1s left", secret: true,  icon: "key" },
  { id: "bejeweled",        name: "Bejeweled",        desc: "Hit a 5-in-a-row streak",             secret: true,  icon: "gem" },
  { id: "long-story-short", name: "Long Story Short", desc: "Come back to finish on a 5+ streak",  secret: true,  icon: "rise" },
];
const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

let earnedAchievements = {};   // persisted: { id: "YYYY-MM-DD" }
let newlyUnlocked = [];        // ids unlocked this game (for the results recap)

function loadAchievements() {
  try {
    const raw = localStorage.getItem(ACH_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && typeof o === "object") return o; }
  } catch (e) { /* ignore */ }
  return {};
}
function saveAchievements() {
  try { localStorage.setItem(ACH_KEY, JSON.stringify(earnedAchievements)); } catch (e) { /* ignore */ }
}
function charmMarkup(icon) { return `<span class="charm" aria-hidden="true">${ACH_ICONS[icon]}</span>`; }

function unlock(id, toast) {
  if (!ACH_BY_ID[id] || earnedAchievements[id]) return;
  earnedAchievements[id] = new Date().toISOString().slice(0, 10);
  saveAchievements();
  newlyUnlocked.push(id);
  if (toast) showToast(ACH_BY_ID[id]);
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
// Medium keeps the legacy key for back-compat; other modes get a suffix.
function hsKey(mode) { return mode === "medium" ? HS_KEY : HS_KEY + "." + mode; }
function loadHighScores(mode = currentMode.id) {
  try {
    const raw = localStorage.getItem(hsKey(mode));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (e) { /* ignore */ }
  return DEFAULT_PODIUM.slice();
}
function saveHighScores(list, mode = currentMode.id) {
  try { localStorage.setItem(hsKey(mode), JSON.stringify(list)); } catch (e) { /* ignore */ }
}
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

function starPath(cx, cy, rOut, rIn) {
  let d = "";
  for (let k = 0; k < 10; k++) {
    const r = k % 2 === 0 ? rOut : rIn;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    d += (k ? "L" : "M") + (cx + r * Math.cos(a)).toFixed(2) + "," + (cy + r * Math.sin(a)).toFixed(2);
  }
  return d + "Z";
}

function buildBraceletSVG(results, activeRound, freshIndex, albums) {
  const W = 520, H = 64, xL = 26, xR = W - 26;
  // the thread sags between its tied ends like a real bracelet laid on the page
  const yAt = (x) => 20 + 10 * Math.sin(Math.PI * ((x - xL) / (xR - xL)));
  const tx0 = xL - 16, tx1 = xR + 16;

  let d = "";
  for (let s = 0; s <= 48; s++) {
    const x = tx0 + ((tx1 - tx0) * s) / 48;
    d += (s ? "L" : "M") + x.toFixed(1) + "," + yAt(x).toFixed(1);
  }
  // two offset strands read as twisted floss
  let svg = `<path class="b-thread" d="${d}" stroke-width="1.7" opacity="0.55"/>` +
            `<path class="b-thread" d="${d}" stroke-width="1" opacity="0.35" stroke-dasharray="6 4" transform="translate(0 1.3)"/>`;

  const knot = (x, y, dir) =>
    `<path class="b-knot" stroke-width="1.3" opacity="0.65" d="M${x},${y} q${5 * dir},-7 ${2 * dir},-11 M${x},${y} q${7 * dir},1 ${11 * dir},-4"/>` +
    `<circle cx="${x}" cy="${y}" r="2.2" fill="var(--ink-soft)" opacity="0.7"/>`;
  svg += knot(tx0, yAt(tx0), -1) + knot(tx1, yAt(tx1), 1);

  // tiny seed beads strung between the main beads
  for (let i = 0; i < TOTAL_ROUNDS - 1; i++) {
    const x = xL + ((xR - xL) * (i + 0.5)) / (TOTAL_ROUNDS - 1);
    svg += `<circle class="b-seed" cx="${x.toFixed(1)}" cy="${yAt(x).toFixed(1)}" r="1.9"/>`;
  }

  for (let i = 0; i < TOTAL_ROUNDS; i++) {
    const x = +(xL + ((xR - xL) * i) / (TOTAL_ROUNDS - 1)).toFixed(1);
    const y = +yAt(x).toFixed(1);
    const answered = results[i];
    // colour this bead by the album of the song picked that round (final bracelet)
    const albumCol = (albums && albums[i]) ? (ALBUM_COLORS[albums[i]] || null) : null;
    const beadStyle = albumCol ? ` style="--bead:${albumCol}"` : "";

    if (answered === true) {
      // a small bead on the thread, with a star charm dangling from a jump ring
      svg += `<circle cx="${x}" cy="${y}" r="4.1" class="b-bead" stroke-width="1"${beadStyle}/>`;
      const fresh = i === freshIndex;
      const delay = fresh ? "" : ` style="animation-delay:${(-(i * 0.9) % 5.5).toFixed(2)}s"`;
      svg += `<g class="charm-dangle${fresh ? " fresh" : ""}"${delay}>` +
        `<circle cx="${x}" cy="${y + 5.4}" r="2.3" fill="none" stroke="var(--ink)" stroke-width="1" opacity="0.7"/>` +
        `<path d="${starPath(x, y + 15.5, 7.4, 3.1)}" class="b-bead" stroke-width="1.1" stroke-linejoin="round"${beadStyle}/>` +
        `<circle cx="${x - 1.9}" cy="${y + 12.6}" r="1.2" class="b-gloss"/>` +
        `</g>`;
    } else if (answered === false) {
      // a quiet matte spacer bead — tinted to the picked album, kept muted
      const missStyle = albumCol ? ` style="fill:${albumCol}" fill-opacity="0.5"` : "";
      svg += `<circle cx="${x}" cy="${y}" r="4.9" class="b-miss" stroke-width="1"${missStyle}/>` +
             `<circle cx="${x}" cy="${y}" r="1.1" class="b-miss-dot"/>`;
    } else if (i + 1 === activeRound) {
      // the bead being strung right now: bigger, glossy, with a soft halo pulse
      svg += `<circle cx="${x}" cy="${y}" r="9" class="b-halo" stroke-width="2"/>` +
             `<circle cx="${x}" cy="${y}" r="8.4" class="b-bead" stroke-width="1.4"/>` +
             `<ellipse cx="${x - 2.6}" cy="${y - 3.1}" rx="3" ry="1.8" class="b-gloss" transform="rotate(-20 ${x - 2.6} ${y - 3.1})"/>`;
    } else if (i === TOTAL_ROUNDS - 1) {
      // the finale slot is a classic white letter bead
      svg += `<g transform="rotate(6 ${x} ${y})">` +
        `<rect x="${x - 7}" y="${y - 7}" width="14" height="14" rx="3.5" class="b-letter" stroke-width="1.1" opacity="0.8"/>` +
        `<text x="${x}" y="${y + 2.6}" text-anchor="middle" font-size="7.5" class="b-letter-text">13</text>` +
        `</g>`;
    } else {
      svg += `<circle cx="${x}" cy="${y}" r="5.6" class="b-future" stroke-width="1.1"/>`;
    }
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${svg}</svg>`;
}

function renderBracelet() {
  $("bracelet").innerHTML = buildBraceletSVG(roundResults, round, justEarnedIndex, roundAlbums);
  $("charmCount").textContent = roundResults.filter(Boolean).length;
  $("pageNum").textContent = Math.min(Math.max(round, 1), TOTAL_ROUNDS);
}

/* ---------- Data load ---------- */
/* ---------- Album colours (left-rule tint + tag on lyric cards) ---------- */
const ALBUM_COLORS = {
  "Taylor Swift":                     "#5a9ea6",
  "Fearless":                         "#b8943a",
  "Speak Now":                        "#8b5fa0",
  "Red":                              "#a32a2a",
  "1989":                             "#4a8fb5",
  "reputation":                       "#555555",
  "Lover":                            "#c4649a",
  "folklore":                         "#7a8a72",
  "evermore":                         "#7a5a38",
  "Midnights":                        "#3d4f8a",
  "The Tortured Poets Department":    "#7a6e60",
  "The Life of a Showgirl":          "#e07830",
};

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
function loadMode() {
  try {
    const id = localStorage.getItem(DIFF_KEY);
    if (id && MODES[id]) return MODES[id];
  } catch (e) { /* ignore */ }
  return MODES.medium;
}
function setMode(id) {
  if (!MODES[id]) return;
  currentMode = MODES[id];
  try { localStorage.setItem(DIFF_KEY, id); } catch (e) { /* ignore */ }
  renderModePicker();
  refreshStartBoard();
}
// The start-screen Hall of Fame follows the selected mode.
function refreshStartBoard() {
  const t = $("startPodiumTitle");
  if (t) t.textContent = "Hall of Fame · " + currentMode.label;
  renderPodium($("startPodium"), sortHs(loadHighScores(currentMode.id)), null);
}
function renderModePicker() {
  const tabs = $("modeTabs");
  if (!tabs) return;
  tabs.innerHTML = MODE_ORDER.map((m) =>
    `<button type="button" class="mode-tab${m === currentMode.id ? " active" : ""}" data-mode="${m}">${MODES[m].label}</button>`
  ).join("");
  tabs.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("modeBlurb").textContent = currentMode.blurb;
}

/* ---------- Game flow ---------- */
function startGame() {
  score = 0;
  round = 0;
  correctStreak = 0;
  gameTimeouts = 0;
  gameMaxStreak = 0;
  newlyUnlocked = [];
  recentWords = [];
  recentEras = [];
  roundResults = [];
  roundAlbums = [];
  $("songInput").placeholder = currentMode.dropdown ? "write the line…" : "write the full title…";
  $("gameHint").textContent = currentMode.dropdown ? "Enter accepts the top match" : "no hints — type the full title, then Enter";
  showScreen("game");
  nextRound();
}

function pickWord() {
  const bucket = wordBuckets[currentMode.pool] || playableWords;
  const pool = bucket.filter((w) => !recentWords.includes(w));
  const choices = pool.length ? pool : bucket;
  const word = choices[Math.floor(Math.random() * choices.length)];
  recentWords.push(word);
  if (recentWords.length > RECENT_WINDOW) recentWords.shift();
  return word;
}

function nextRound() {
  if (round >= TOTAL_ROUNDS) { endGame(); return; }
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

function advanceRound() {
  round++;
  roundLocked = false;
  justEarnedIndex = -1;
  currentWord = pickWord();
  currentSongs = validSongs(currentWord, currentMode.strict, currentMode.noTitle);
  applyEra(pickEra());

  $("wordDisplay").textContent = currentWord;
  $("feedback").innerHTML = "";
  $("playArea").style.display = "";
  renderBracelet();
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
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const song of allSongs) {
    const t = song.title.toLowerCase();
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

/* ---------- Submit & feedback ---------- */
function submitAnswer(song, isTimeout) {
  if (roundLocked) return;

  if (!song && !isTimeout) {
    if (dropdownItems.length) {
      song = dropdownItems[activeIndex >= 0 ? activeIndex : 0];
    } else {
      const typed = $("songInput").value.trim().toLowerCase();
      song = allSongs.find((s) => s.title.toLowerCase() === typed) || null;
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
  justEarnedIndex = correct ? round - 1 : -1;
  if (correct) score++;
  correctStreak = correct ? correctStreak + 1 : 0;
  renderBracelet();

  // achievements: timing + streak signals (mid-game unlocks toast immediately)
  const elapsed = (performance.now() - timerStart) / 1000;
  const remaining = currentMode.seconds - elapsed;
  if (isTimeout) gameTimeouts++;
  if (correct) {
    if (elapsed < 2) unlock("speak-now", true);
    if (remaining < 1) unlock("getaway-car", true);
  }
  gameMaxStreak = Math.max(gameMaxStreak, correctStreak);
  if (correctStreak >= 5) unlock("bejeweled", true);

  // Circle the player's pick before revealing the verdict (skipped on timeout / reduced motion).
  const reveal = () => (correct ? showCorrectFeedback(song) : showWrongFeedback(song, isTimeout));
  if (song && !isTimeout && !prefersReducedMotion()) {
    showCircledChoice(song, reveal);
  } else {
    reveal();
  }
}

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
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

function lyricCard(song, word, isWrong) {
  const line = extractLineWithWord(song.lyrics, word);
  const color = ALBUM_COLORS[song.album] || "var(--ink-soft)";
  const albumLabel = song.album ? `<span class="album-tag" style="--album-color:${color}">${escapeHtml(song.album)}</span>` : "";
  const cls = isWrong ? " wrong-card" : "";
  return `<div class="lyric-card${cls}" style="--album-color:${color}">
    <div class="song-title">${escapeHtml(song.title)}${albumLabel}</div>
    <div class="lyric-line">"${highlightWord(line, word)}"</div>
  </div>`;
}

function showCorrectFeedback(song) {
  const fb = $("feedback");
  fb.innerHTML = `
    <div class="banner good">✓ that's the one</div>
    ${lyricCard(song, currentWord, false)}
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

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------- End game ---------- */
function endGame() {
  clearTimer();
  resetTension();
  applyEra(FINALE_ERAS[Math.floor(Math.random() * FINALE_ERAS.length)]);
  updateStats(score, currentMode.id);
  const played = totalPlayed();   // across all modes — achievements are global

  // end-of-game achievements (shown in the results recap, no toast)
  if (score === TOTAL_ROUNDS) unlock("mastermind", false);
  if (gameTimeouts === 0) unlock("fearless", false);
  if (played >= 1) unlock("enchanted", false);
  if (played >= 5) unlock("begin-again", false);
  const trailingStreak = (() => { let n = 0; for (let i = roundResults.length - 1; i >= 0 && roundResults[i]; i--) n++; return n; })();
  if (roundResults.includes(false) && trailingStreak >= 5) unlock("long-story-short", false);

  showScreen("results");
  $("resultBracelet").innerHTML = buildBraceletSVG(roundResults, 0, -1, roundAlbums);
  $("finalScore").textContent = score;
  $("finalSub").textContent = "out of " + TOTAL_ROUNDS;
  renderResultRecap();
  if (score === TOTAL_ROUNDS) celebratePerfect();

  const list = loadHighScores();
  const lowest = list.length >= 5 ? list[list.length - 1].score : -1;
  const beats = list.length < 5 || score > lowest;

  const nameDiv = $("namePrompt");
  if (beats && score > 0) {
    nameDiv.style.display = "";
    renderPodium($("resultPodium"), sortHs(list), null);
    const save = () => {
      const name = ($("nameInput").value || "You").trim().slice(0, 20) || "You";
      const updated = sortHs(list.concat([{ name, score, __you: true }])).slice(0, 5);
      saveHighScores(updated.map(({ name, score }) => ({ name, score })));
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

const PEN_LABELS = { quill: "quill pen", fountain: "fountain pen", glitter: "glitter gel pen" };
const PEN_SVG = {
  quill: `<svg viewBox="0 0 24 24"><g class="ink"><path d="M4.5 19.5 C9 12.5 14 6.5 21 2.5 C19.2 10.8 15 16.8 8 19.8 Z"/><path d="M18.5 5 L7.5 16.5"/><path d="M15.5 6.5 l-3.6 -1 M13.5 8.5 l-3.6 -1 M11.5 10.5 l-3.6 -1 M9.5 12.5 l-3.6 -1"/></g></svg>`,
  fountain: `<svg viewBox="0 0 24 24"><g class="ink"><path d="M19.5 2.8 L8.5 13.8"/><path d="M8.5 13.8 L6 16.3"/></g><path class="ink-fill" d="M6 16.3 L3.2 21 L8 18.6 Z"/><path class="ink" stroke-width="1" d="M5 18.6 L6.8 16.8"/></svg>`,
  glitter: `<svg viewBox="0 0 24 24"><g class="ink"><path d="M18.5 3.5 L8 14"/><path d="M8 14 L5 17"/></g><path class="ink-fill" d="M5 17 L2.6 21.4 L7 19 Z"/><g class="glitter-spark"><path d="M18.5 11 l1 2.2 2.2 1 -2.2 1 -1 2.2 -1 -2.2 -2.2 -1 2.2 -1 z"/><circle cx="21.2" cy="6.8" r="1"/><circle cx="13" cy="18.4" r="0.9"/></g></svg>`,
};

const STAR_SVG = `<svg viewBox="0 0 24 24"><path d="M12 2 L14.6 9 L22 9.3 L16 14 L18 21.5 L12 17 L6 21.5 L8 14 L2 9.3 L9.4 9 Z" fill="currentColor"/></svg>`;
const SPARKLE_SVG = `<svg viewBox="0 0 24 24"><path d="M12 1 C13 8 16 11 23 12 C16 13 13 16 12 23 C11 16 8 13 1 12 C8 11 11 8 12 1 Z" fill="currentColor"/></svg>`;

const DOODLE_SVG = {
  // a fence panel with 5 diamond cut-outs in a quincunx (Taylor's fence photo)
  fence: `<svg viewBox="0 0 76 64"><g class="ink"><rect x="3" y="6" width="70" height="52" rx="2"/><line x1="20" y1="6" x2="20" y2="58"/><line x1="38" y1="6" x2="38" y2="58"/><line x1="56" y1="6" x2="56" y2="58"/><path d="M14 18 l5 5 -5 5 -5 -5 z"/><path d="M62 18 l5 5 -5 5 -5 -5 z"/><path d="M14 42 l5 5 -5 5 -5 -5 z"/><path d="M62 42 l5 5 -5 5 -5 -5 z"/><path d="M38 30 l5 5 -5 5 -5 -5 z"/></g></svg>`,
  // a quiet inked coil — the reduced-motion stand-in for the slithering snake
  snake: `<svg viewBox="0 0 84 58"><g class="ink"><path d="M8 42 C20 42 20 28 32 28 C44 28 44 42 56 42 C66 42 70 32 67 24"/><path d="M67 24 C65 17 71 12 76 15"/></g><path class="ink-fill" d="M73 11 a3.2 3.2 0 1 1 0.1 0 z"/><circle cx="74.4" cy="13.6" r="0.7" fill="var(--paper)"/><g class="ink"><path d="M77 13 l5 -2 m-5 3.4 l5 1"/></g><g class="ink" stroke-width="1.3" opacity="0.6"><path d="M17 40 l2 -3 m7 0 l2 -3 m9 4 l2 3 m7 -1 l2 3"/></g></svg>`,
  scarf: `<svg viewBox="0 0 60 58"><g class="ink"><path d="M13 9 C26 18 34 18 47 9"/><path d="M15 14 C26 21 34 21 45 14"/><path d="M27 18 C24 26 24 31 28 35 L24 51"/><path d="M33 18 C36 26 36 31 32 35 L36 49"/><path d="M27.5 35 L32.5 35"/></g><g class="ink" stroke-width="0.9" opacity="0.65"><path d="M26 24 l8 0.4 M25.4 28 l9 0.4 M26.5 31 l7 0.4"/></g><g class="ink" stroke-width="1.4"><path d="M22 51 l-0.8 5 m3.2 -6 l0.4 6 m3.4 -6 l1 5"/><path d="M34 49 l-0.8 5 m3.4 -6 l0.4 6 m3.4 -6 l1 5"/></g></svg>`,
  cat: `<svg viewBox="0 0 60 56"><g class="ink"><path d="M16 13 L20 25 M16 13 L13 24"/><path d="M44 13 L40 25 M44 13 L47 24"/><path d="M13 27 C9 33 9 44 14 49 C21 53 39 53 46 49 C51 44 51 33 47 27 C40 20 20 20 13 27 Z"/><path d="M46 47 C55 47 59 38 55 31"/></g><g class="ink" stroke-width="1.5"><circle cx="24" cy="35" r="1.3" class="ink-fill"/><circle cx="36" cy="35" r="1.3" class="ink-fill"/><path d="M30 38 l0 2.4 M30 40.4 l-3 2 M30 40.4 l3 2"/></g><g class="ink" stroke-width="0.9" opacity="0.7"><path d="M22 39 l-9 -1.5 m9 4 l-9 1.5 M38 39 l9 -1.5 m-9 4 l9 1.5"/></g></svg>`,
  guitar: `<svg viewBox="0 0 44 60"><g class="ink"><path d="M22 23 C15 23 12 31 16 36 C10 41 11 53 22 55 C33 53 34 41 28 36 C32 31 29 23 22 23 Z"/><circle cx="22" cy="41" r="4.4"/><rect x="19.4" y="5" width="5.2" height="18" rx="1.4"/><path d="M20 5 q-2.4 -2 -0.2 -3.4 M24 5 q2.4 -2 0.2 -3.4"/><path d="M22 23 L22 36"/><path d="M16.5 48 L27.5 48"/></g><g class="ink" stroke-width="0.8" opacity="0.7"><path d="M20.4 23 L20.4 34 M22 23 L22 34 M23.6 23 L23.6 34"/></g><g class="ink" stroke-width="1.2"><circle cx="20" cy="3" r="0.6" class="ink-fill"/><circle cx="24" cy="3" r="0.6" class="ink-fill"/></g></svg>`,
  thirteen: `<svg viewBox="0 0 40 40"><text x="6" y="29" font-family="Caveat, cursive" font-size="29" fill="var(--ink-soft)">13</text><ellipse cx="19" cy="20" rx="17" ry="14.5" fill="none" stroke="var(--ink-soft)" stroke-width="1.5" transform="rotate(-8 19 20)"/></svg>`,
};

function chance(p) { return Math.random() < p; }

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
  if (round === 5) {
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
  renderModePicker();
  refreshStartBoard();
  const titleEl = document.querySelector("header.title h1");
  if (titleEl) titleEl.addEventListener("click", () => {
    if (++titleTaps >= 13) { titleTaps = 0; revealSecret13(); }
  });
  $("playBtn").addEventListener("click", startGame);
  $("statsBtn").addEventListener("click", () => { statsBackTarget = "start"; renderStats(null); showScreen("stats"); });
  $("resultsStatsBtn").addEventListener("click", () => { statsBackTarget = "results"; renderStats(score); showScreen("stats"); });
  $("statsBackBtn").addEventListener("click", () => {
    const prev = statsBackTarget;
    showScreen(prev);
    if (prev === "start") { $("startContent").style.display = ""; }
  });
  $("againBtn").addEventListener("click", () => {
    applyEra("gold");
    refreshStartBoard();
    showScreen("start");
    $("startContent").style.display = "";
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

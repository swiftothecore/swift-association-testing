"use strict";
import { $, escapeRegExp, escapeHtml, prefersReducedMotion, shuffle, chance, normalizeTitle, normalizeLyric, fuzzySubstringRatio, levenshtein, mulberry32, dailySeed, censorText, anniversaryNote } from "./util.js";
import {
  TOTAL_ROUNDS, RECENT_WINDOW, DIFF_KEY, DEFAULT_SETTINGS,
  MODES, MODE_ORDER, MODE_COLORS, DIFFICULTY_LADDER, MODALITY_MODES,
  ERAS, TENDER_ERAS, FINALE_ERAS, ALBUM_ERA, TS_MILESTONES,
  ALBUM_COLORS, CB_ALBUM_COLORS, STUDIO_ALBUMS, TITLE_ALIASES,
  ACHIEVEMENTS, ACH_ICONS, ACH_BY_ID, ACH_GROUPS, ACH_GROUP_COLORS, ACH_GROUP_OF, ACH_NO_TRADE,
  CHALLENGES, CHALLENGE_BY_ID, CHALLENGE_ORDER,
  ALBUM_FOCUS_DIFFS, ALBUM_FOCUS_TARGET,
  ADAPTIVE_BUCKETS, ADAPTIVE_LEVELS, ADAPT_MAX_LEVEL, ADAPT_START_LEVEL, ADAPT_PROMO_STREAK, ADAPT_NODROP_LEVEL,
  PEN_SVG, STAR_SVG, SPARKLE_SVG, DOODLE_SVG,
} from "./config.js";
import { buildBraceletSVG } from "./bracelet.js";
import { wordRegex as wordRegexCore, extractLineWithWord as extractLineWithWordCore, highlightWord as highlightWordCore } from "./match.js";
import {
  loadRecords, insertRecord, migrateRecordsFromStats, getPlayerName, setPlayerName,
  getAvatar, setAvatar,
  loadHistory, appendHistory,
  loadStats, updateStats, totalPlayed,
  loadAchievements, saveAchievements,
  loadMode,
  loadDailyResult, saveDailyResult, clearDailyResult, dailyTotals, dailyPlayedDates,
  loadDailyProgress, saveDailyProgress, clearDailyProgress,
  bumpDailyStreak, effectiveDailyStreak, saveDailyStreak,
  markTypePlayed,
  loadSongTally, recordGameTally,
  loadMetrics, recordGameMetrics,
  loadSettings, saveSettings,
  exportData, importData,
  loadChallengeState, saveChallengeState, challengeRecord,
  loadChallengeTokens, saveChallengeTokens, resetChallenges,
  loadAlbumFocus, albumFocusRecord, recordAlbumFocusRun,
  adaptiveRecord, recordAdaptiveRun,
  resetRecords, resetStatsAll, resetAchievements, resetTally, resetDaily, clearAllData,
} from "./storage.js";

/* ---------- Constants & state ---------- */
// Lyric-line answering: a typed line must be at least this many words (so a bare
// prompt-word echo — or a token three-word stub — can't pass), and must match a real
// word-bearing lyric line at or above this fuzzy similarity (1 = verbatim; lower
// tolerates typos / a partial line). The 4-word floor nudges players to recall more
// than a fragment; verse-bonus grading rewards fuller lines on top of that.
const MIN_LYRIC_WORDS = 4;
// ...but a 3-word phrase still passes if it's long enough by character count — a
// genuinely long trio (e.g. "unconditional everlasting devotion") is clearly a real
// recalled line, not a bare-word cheat. Short trios ("i love you") still fall short.
const MIN_LYRIC_WORDS_SHORT = 3;
const MIN_LYRIC_SHORT_CHARS = 20;
const FUZZY_THRESHOLD = 0.8;
// Recall grading: a typed line covering this fraction of the matched real line earns
// a verse bonus; at the "perfect" mark (or verbatim) it earns the full bonus.
const RECALL_GOOD = 0.5;
const RECALL_PERFECT = 0.9;
// The top rung of the ladder: recalling a word-perfect block this many real lines long
// is a "whole verse" (+3) — the loudest reward, and the Overachiever trigger.
const WHOLE_VERSE_LINES = 4;

let currentMode = MODES.medium;
let wordBuckets = { easy: [], all: [], hard: [], ultra: [] };
let recentEras = [];

let allSongs = [];
let titleIndex = new Map();   // normalizeTitle(title|alias) -> song, built in loadData
let spacelessIndex = new Map(); // titleIndex key with spaces removed -> song (space-error fallback)
let playableWords = [];
let titleWordList = [];  // playable words that appear in at least one song title (Title...? challenge pool)
let shortTitleWordList = []; // playable words with a valid (lyrics) song whose title is ≤2 words (Short n' Sweet pool)
let albumWordMap = {};   // album -> playable words with a valid (lyrics) song in that album (On Tour! pool)
let albumOrder = [];     // album names in canonical songs.json order (On Tour! setlist order)
let score = 0;
let round = 0;
let usedWords = [];
let roundResults = [];   // per-round true/false for the bracelet
let roundAlbums = [];    // per-round album of the picked song (for the final bracelet)
let roundWords = [];     // per-round prompt word (for the lifetime tally / Nemesis Word)
let roundSongs = [];     // per-round answered song title, null on a miss (lifetime tally)
let roundHinted = [];    // per-round true if a hint was taken (a hinted run can't set a PB)
let hintsUsed = 0;       // count of rounds this game where a hint was taken
let runFolded = false;   // partial/full stats already saved for the current run (quit / unload / endGame)
let hintTier = 0;        // hints revealed this round (0..3); reset each round
let roundHintSong = null;// the valid song this round's hints zoom in on
let hintUrgeTimer = null;// idle nudge timer for Relaxed (no clock)
let gameType = "classic";       // "classic" (fixed 13) | "infinite" (until lives run out) | "adaptive" (fixed 13, floating rarity) | "daily" | "challenge" | "album"
let focusAlbum = null;          // Album Focus: the locked-in studio album while gameType === "album"
let focusDifficulty = null;     // Album Focus: the chosen MODES id this run plays at
let infiniteVariant = "3lives"; // "3lives" | "sudden"
let lives = 0;                  // remaining lives in infinite mode
let adaptiveLevel = ADAPT_START_LEVEL; // Adaptive: current rarity level (1..4), floats with performance
let adaptivePeak = ADAPT_START_LEVEL;  // Adaptive: highest level reached this run (the board metric)
let adaptivePromo = 0;          // Adaptive: correct-in-a-row at the current level toward promotion
let adaptiveReachedTop = false; // Adaptive: ever hit the Rarest tier this run (for The Lakes)
let adaptiveHeldTop = true;     // Adaptive: still true if no miss has landed since reaching the top (for Stay Stay Stay)
let adaptiveDropAnnounced = true; // Adaptive: the dropdown state the player was last shown a curtain for (starts on, at L2)
let dailyRng = null;            // seeded PRNG, non-null only during a daily game
let dailyShareTime = null;      // completion time (sec) of the daily on screen — for the copyable result
let currentChallenge = null;    // the active CHALLENGES entry while gameType === "challenge"
let challengeRunActive = false; // true only during a live challenge run (gates the achievement sandbox)
let vanishTimer = null;         // Vanishing Word: timeout that hides the prompt word
let revolveId = null;           // Revolving Door: interval that swaps the word every rotateMs
let revolveIndex = 0;           // Revolving Door: how many times the word has revolved this round
let lastAlphaLetter = "";       // From A to Z: first letter of the last accepted answer
let roundSecondsOverride = null; // Shrinking Timer: per-round clock override (null = use the mode's seconds)
let chainLetter = "";           // Wrapped Like A Chain: required first letter of the next title ("" = free)
let tourSetlist = [];           // On Tour!: the album scheduled for each round (index = round-1)
let comboClock = 0;             // It's A Clock!: seconds left on the single shared run clock
let challengeTargetSong = null; // One Of A Kind: the never-before-answered song to surface
let challengeForcedRound = 0;   // One Of A Kind: the round that forces challengeForcedWordVal
let challengeForcedWordVal = "";// One Of A Kind: the prompt word that surfaces the target song
let forcedFirstWord = "";       // "Play this word" deep-link (search/?word=): forces round 1's prompt word
let newSongLives = 0;           // One Of A Kind: wrong target guesses left before the run fails
const NEW_SONG_LIVES = 3;       // One Of A Kind: starting guesses (discourages spamming the target)
let extraSecondsPerRound = 0;   // Choose Your Path: bonus seconds added to every round's clock
let skipTokens = 0;             // Choose Your Path: one-time word "swaps" earned at a fork
let pathForksTaken = [];        // Choose Your Path: fork rounds whose perk has been chosen
let perksTaken = [];            // Choose Your Path: perk ids already chosen (never re-offered)
let pathMulligans = 0;          // Choose Your Path: wrong answers that can be retried (Second Chance)
let perkReveals = new Set();    // Choose Your Path: active per-round reveals (letter/album/count/example)
let perkPoolOverride = null;    // Choose Your Path: Crowd Pleaser → draw words from the common pool
let perkNoTitleOff = false;     // Choose Your Path: Off The Record → allow the word in the title
let perkCalm = false;           // Choose Your Path: Steady Hands → no timer tremor/tension
let roundLyricOnly = false;     // Switch-Up: this page demands a lyric line (true) or a title (false)
let roundNamed = [];            // Double Trouble: distinct valid titles named this page so far
// Devil's Path: curses taken at forks, each a permanent handicap for the rest of the run.
let devilCursesTaken = [];      // curse ids already taken (never re-offered)
let devilDropOff = false;       // In The Dark: suggestions switched off
let devilVanish = false;        // Disappearing Ink: the word fades each page
let devilFx = null;             // word distortion: "scramble" | "drop" | "reverse" (or null)
let devilNoTitle = false;       // No Giveaways: the word can't be in the answer's title
let devilShortOnly = false;     // Keep It Short: only ≤2-word titles count
let devilBannedAlbums = [];     // Off Limits / Locked Out: albums no longer accepted
let devilBannedInitials = [];   // Forbidden Letters: title-start letters no longer accepted
let devilPoolHard = false;      // Rarer Air: remaining words drawn from the rarer pool
let roundWildcard = null;       // Wildcard: this round's active sub-constraint
let lastWildcardId = "";        // Wildcard: previous round's constraint id (no immediate repeat)
let currentWord = "";
let currentSongs = [];
// The full lyrics-valid set for the round, BEFORE a challenge sub-rule narrows currentSongs
// (Short n' Sweet / Wrapped Like A Chain / On Tour!). Soft-rejects use it to tell a near-miss
// (lyrics fit, sub-rule doesn't) from a wholly wrong answer.
let currentLyricSongs = [];
let dropdownItems = [];
let activeIndex = -1;
let timerId = null;
let countdownId = null;
let timerStart = 0;
let roundLocked = false;
let feedbackShownAt = 0;        // ms timestamp the verdict appeared — Enter-to-advance is held off for ENTER_SKIP_GRACE after it
const ENTER_SKIP_GRACE = 250;   // so a held/late Enter from the answer screen can't instantly blow past the result
let debounceId = null;
let statsBackTarget = "start";
let settings = { ...{} };       // populated from loadSettings() in init
let pausedRemaining = null;     // timer seconds left when the settings modal paused play

// Dev cheats (only active behind the ?dev flag; see devActive / js/dev.js).
let devNoLog = false;           // when true, endGame skips folding the run into history/stats/records
let devFrozenRemaining = null;  // seconds stashed by the dev timer-freeze toggle

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
  refreshSnow();   // December snowfall follows the reduce-motion setting live
}

/* ---------- December snowfall ---------- */
// A full-viewport canvas of drifting flakes, decorative only. Active in December
// (the player's active timezone, via todayKey — so it follows the same local
// calendar as the daily reset) and only when motion is allowed.
let snowRaf = null, snowFlakes = [], snowCanvas = null, snowCtx = null,
    snowLast = 0, snowResizeT = null, snowResizeBound = false;
function snowActive() { return todayKey().slice(5, 7) === "12" && !motionReduced(); }
function sizeSnowCanvas() {
  if (!snowCanvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  snowCanvas.width = Math.max(1, Math.round(w * dpr));
  snowCanvas.height = Math.max(1, Math.round(h * dpr));
  snowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Flake count scales with viewport area, capped for performance. Depth is faked
  // per flake (size/speed/opacity), so nearer flakes fall faster and brighter.
  const target = Math.min(150, Math.round((w * h) / 13000));
  if (snowFlakes.length > target) snowFlakes.length = target;
  while (snowFlakes.length < target) {
    const d = Math.random();
    snowFlakes.push({ x: Math.random() * w, y: Math.random() * h,
      r: 0.8 + d * 2.6, sp: 8 + d * 26, dr: 0.3 + d * 0.7,
      ph: Math.random() * 6.2832, o: 0.3 + d * 0.55 });
  }
}
function snowFrame(ts) {
  if (!snowActive() || !snowCtx) { stopSnow(); return; }
  const w = window.innerWidth, h = window.innerHeight;
  let dt = snowLast ? (ts - snowLast) / 1000 : 0.016;
  snowLast = ts;
  if (dt > 0.05) dt = 0.05;   // clamp big jumps from a throttled/backgrounded tab
  snowCtx.clearRect(0, 0, w, h);
  snowCtx.fillStyle = "#ffffff";
  for (const f of snowFlakes) {
    f.y += f.sp * dt;
    f.x += Math.sin(ts / 1000 + f.ph) * 13 * f.dr * dt;   // gentle lateral sway
    if (f.y > h + 4) { f.y = -4; f.x = Math.random() * w; }
    if (f.x > w + 4) f.x = -4; else if (f.x < -4) f.x = w + 4;
    snowCtx.globalAlpha = f.o;
    snowCtx.beginPath();
    snowCtx.arc(f.x, f.y, f.r, 0, 6.2832);
    snowCtx.fill();
  }
  snowCtx.globalAlpha = 1;
  snowRaf = requestAnimationFrame(snowFrame);
}
function startSnow() {
  if (!snowCanvas) {
    snowCanvas = document.getElementById("snowfall");
    if (!snowCanvas) return;
    snowCtx = snowCanvas.getContext("2d");
  }
  if (!snowResizeBound) {
    window.addEventListener("resize", () => {
      clearTimeout(snowResizeT);
      snowResizeT = setTimeout(() => { if (snowActive()) sizeSnowCanvas(); }, 150);
    });
    snowResizeBound = true;
  }
  sizeSnowCanvas();
  snowCanvas.style.display = "block";
  snowLast = 0;
  if (!snowRaf) snowRaf = requestAnimationFrame(snowFrame);
  unlock("snow-on-the-beach");   // weird but beautiful — you caught the December snow
}
function stopSnow() {
  if (snowRaf) { cancelAnimationFrame(snowRaf); snowRaf = null; }
  if (snowCanvas) {
    snowCtx && snowCtx.clearRect(0, 0, snowCanvas.width, snowCanvas.height);
    snowCanvas.style.display = "none";
  }
}
function refreshSnow() { if (snowActive()) startSnow(); else stopSnow(); }
// Remember the last type clicked so defaultGameType:"last" can restore it next launch.
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
  achievements: $("screen-achievements"),
  challenges: $("screen-challenges"),
  songbook: $("screen-songbook"),
  albumfocus: $("screen-albumfocus"),
};
function showScreen(name) {
  // Defensive: clear any stray inline animation a flip sheet helper might have left on a real
  // screen, so every screen animates normally on its next genuine show.
  Object.values(screens).forEach((s) => { s.classList.remove("active"); s.style.animation = ""; });
  screens[name].classList.add("active");
  // Drop any lingering perfect-game shimmer; celebratePerfect re-adds it after
  // showScreen("results") when the run was actually flawless.
  clearPerfectFX();
  // The daily reset countdown only lives on the start screen; don't let its interval
  // outlive the view (renderDailyButtonState restarts it when start is shown again).
  if (name !== "start") stopResetCountdown();
  // Re-arm the quit button fresh for each visit to the game (drop any stale armed state).
  if (name === "game") {
    const qb = $("quitBtn");
    if (qb) { clearTimeout(quitTimer); qb.classList.remove("armed"); qb.textContent = qb.dataset.label; }
  }
  // Re-scatter the keepsake-card tape each time its screen is shown, so the pinning
  // feels hand-done rather than templated.
  if (name === "start" || name === "results") scatterNavTape(name);
  // Move keyboard/screen-reader focus onto the newly shown screen so the next Tab
  // (and the SR reading position) start there, not on the now-hidden trigger. The
  // game screen manages its own focus on #songInput, so don't steal it there.
  if (name !== "game") {
    const sec = screens[name];
    if (sec && typeof sec.focus === "function") {
      try { sec.focus({ preventScroll: true }); } catch (_) { sec.focus(); }
    }
  }
}

/* Side-to-side page turns for screen navigation. Where nextRound's flip lifts the answered
   page up from its top edge (forward through the notebook), these turn pages sideways around
   the left spine. Two complementary motions sell "going in" vs "coming back":
     • flipAwayToScreen — FORWARD into a sub-page (records/stats/charms/challenges): the page
       you're leaving turns away to the left, revealing the destination already in place beneath.
     • flipInToScreen — BACK (and give-up): the page you're returning to turns IN from the left,
       landing on top of the screen you're leaving, which then becomes the real active screen.
   Both clone a screen as a frozen sheet (the nextRound technique) and honour the same
   reduced-motion / instant-speed / page-turn-off opt-outs (else they just switch instantly).
   A flip sheet is the clone of `src`, positioned over `at` (a currently-visible screen, so its
   offsets are real even when `src` is display:none). */
function makeFlipSheet(src, at, sideClass, shadeClass) {
  const flip = src.cloneNode(true);
  // Keep element ids on the clone: much of the look is keyed off ids (e.g. #playBtn's gold
  // gradient + pencil ::before), so stripping them would render the sheet in an unstyled state.
  // The real screens come earlier in the DOM, so getElementById still resolves to them; the
  // clone carries no event listeners (cloneNode) and is pointer-events:none and short-lived.
  flip.classList.remove("screen", "active");
  // Purely a visual page-turn artifact (and a duplicate of live regions like #wordDisplay) —
  // keep it out of the a11y tree so screen readers don't re-announce the cloned word/feedback.
  flip.setAttribute("aria-hidden", "true");
  flip.classList.add("page-flip-sheet", sideClass);
  flip.style.animation = "";          // never inherit a one-off inline animation from the source
  flip.style.opacity = "";
  flip.style.transition = "";
  flip.style.top = at.offsetTop + "px";
  flip.style.left = at.offsetLeft + "px";
  flip.style.width = at.offsetWidth + "px";
  const shade = document.createElement("div");
  shade.className = "flip-shade " + shadeClass;
  flip.appendChild(shade);
  at.parentNode.appendChild(flip);
  return flip;
}
function scheduleFlipRemoval(flip, onEnd) {
  let finished = false;
  const finish = () => { if (finished) return; finished = true; flip.remove(); if (onEnd) onEnd(); };
  flip.addEventListener("animationend", (e) => { if (e.target === flip) finish(); });
  setTimeout(finish, 500 * animScale() || 250);
}
function flipDisabled(name, current) {
  return !current || current === screens[name] || motionReduced() || animInstant() || !settings.pageTurn;
}
// FORWARD: the leaving page turns away to reveal the destination beneath it.
function flipAwayToScreen(name) {
  const current = Object.values(screens).find((s) => s.classList.contains("active"));
  if (flipDisabled(name, current)) { showScreen(name); return; }
  const flip = makeFlipSheet(current, current, "page-flip-sheet--side", "flip-shade--side");
  showScreen(name);                                   // destination now active beneath the sheet
  scheduleFlipRemoval(flip);
}
// BACK: the destination page turns in on top of the page you're leaving. The destination must
// already be rendered (and any display fix applied) by the caller before this runs.
function flipInToScreen(name) {
  const current = Object.values(screens).find((s) => s.classList.contains("active"));
  if (flipDisabled(name, current)) { showScreen(name); return; }
  const dest = screens[name];
  // 1. Freeze the page we're leaving as a static backdrop, so swapping the real screens
  //    underneath it is invisible.
  const backdrop = makeFlipSheet(current, current, "flip-static", "flip-shade--off");
  // 2. Activate the destination beneath the backdrop NOW — so it's fully prepared (tape
  //    re-scattered, etc.) before we clone it.
  showScreen(name);
  // Suppress the destination's own enter-fade: the incoming flip sheet IS the motion, and
  // when the page we're leaving is shorter than the destination (e.g. give-up: the game
  // card is shorter than the start screen) the real screen's fade would otherwise play in
  // the uncovered strip below the backdrop — a second animation fighting the page turn.
  // Left in place when the flip finishes: clearing it here would revert the still-active
  // destination to its CSS fade and replay it (an extra flash). The next genuine showScreen
  // clears every screen's inline animation, so the fade plays normally on the next show.
  dest.style.animation = "none";
  // 3. Clone the now-final destination for the incoming sheet — so its tape and id-styled
  //    buttons match the real screen exactly — and flip it in over the backdrop. (dest is the
  //    visible active screen now, so its offsets are real.)
  const incoming = makeFlipSheet(dest, dest, "page-flip-sheet--in", "flip-shade--in");
  // 4. The destination is often SHORTER than the page we're leaving, so fade the backdrop's
  //    lower (uncovered) half out near the end — it dissolves into the desk instead of snapping
  //    away when the sheets are removed.
  const s = animScale() || 1;
  backdrop.offsetHeight;                        // flush the opacity:1 baseline so the transition runs
  backdrop.style.transition = `opacity ${(0.16 * s).toFixed(3)}s linear ${(0.32 * s).toFixed(3)}s`;
  backdrop.style.opacity = "0";
  scheduleFlipRemoval(incoming, () => { backdrop.remove(); });
}

/* ---------- Random sticky-tape placement for the nav keepsake cards ----------
   Each card gets 2–4 strips (mostly 3), each pinned to a distinct randomly chosen corner
   or edge with a little rotation jitter, so the cards look genuinely taped down rather
   than templated. Strips are injected as .nav-tape child elements (styles.css) — real
   elements, so there's no two-strip ceiling like the old ::before/::after approach. */
const TAPE_SPOTS = [
  { left: "-9px",  top: "-6px",     rot: [-52, -34] },              // top-left
  { right: "-9px", top: "-6px",     rot: [34, 52] },                // top-right
  { left: "-10px", bottom: "-7px",  rot: [30, 50] },                // bottom-left
  { right: "-10px", bottom: "-7px", rot: [-50, -30] },              // bottom-right
  { left: "50%",   top: "-7px",     tx: "-50%", rot: [-7, 7] },     // top-centre
  { left: "50%",   bottom: "-8px",  tx: "-50%", rot: [-7, 7] },     // bottom-centre
];
// A hand-torn short-edge silhouette: the top/bottom run straight, while the left and
// right ends bite inward by a random amount at each segment, so every strip tears
// differently. Returns a CSS polygon() for clip-path.
function tornEdge() {
  const J = 13;                // max inward bite, % of the strip length
  const segs = 5;              // tear resolution down each short edge
  const bite = () => +(Math.random() * J).toFixed(1);
  const pts = [`${bite()}% 0%`, `${(100 - bite()).toFixed(1)}% 0%`];   // straight top
  for (let i = 1; i < segs; i++) pts.push(`${(100 - bite()).toFixed(1)}% ${(i / segs * 100).toFixed(1)}%`); // right edge down
  pts.push(`${(100 - bite()).toFixed(1)}% 100%`, `${bite()}% 100%`);   // straight bottom
  for (let i = segs - 1; i >= 1; i--) pts.push(`${bite()}% ${(i / segs * 100).toFixed(1)}%`);  // left edge up
  return `polygon(${pts.join(", ")})`;
}
function makeTapeStrip(spot) {
  const t = document.createElement("span");
  t.className = "nav-tape";
  const rot = (spot.rot[0] + Math.random() * (spot.rot[1] - spot.rot[0])).toFixed(1);
  t.style.top = spot.top || "auto";
  t.style.right = spot.right || "auto";
  t.style.bottom = spot.bottom || "auto";
  t.style.left = spot.left || "auto";
  t.style.width = (44 + Math.round(Math.random() * 16)) + "px";   // varied length
  t.style.height = (15 + Math.round(Math.random() * 3)) + "px";   // near-constant tape width
  t.style.transform = `translateX(${spot.tx || "0"}) rotate(${rot}deg)`;
  t.style.clipPath = tornEdge();
  return t;
}
function scatterNavTape(screenName) {
  const root = screens[screenName] || document;
  const cards = [...root.querySelectorAll(".nav-card")];
  // Roll every card's strip count first so we can veto the "all cards doubled" case
  // before anything is drawn: if all three rolled 2, knock one random card back to 1.
  const counts = cards.map(() => (chance(0.3) ? 2 : 1));   // mostly one, occasionally two
  if (counts.length && counts.every((n) => n === 2)) counts[Math.floor(Math.random() * counts.length)] = 1;
  cards.forEach((card, c) => {
    card.querySelectorAll(".nav-tape").forEach((t) => t.remove());   // clear last visit's strips
    const pool = shuffle(TAPE_SPOTS.slice());
    for (let i = 0; i < counts[c] && i < pool.length; i++) card.appendChild(makeTapeStrip(pool[i]));
  });
}

/* ---------- Era selection ---------- */
function pickEra() {
  // Album Focus locks the whole run to its album's era wash (bracelet/cards already use
  // the album colour; this themes the page to match).
  if (gameType === "album" && focusAlbum) return ALBUM_ERA[focusAlbum] || "gold";
  let pool;
  // Round-5/round-13 biases apply to any fixed 13-round run (classic + daily + challenge).
  const fixedRun = gameType === "classic" || gameType === "daily" || gameType === "challenge" || gameType === "adaptive";
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
// The pure matching core (wordVariants/wordRegex/extractLineWithWord/highlightWord)
// lives in js/match.js so the searcher reuses the exact same logic. The wrappers below
// add the game's defaults — strictness from effectiveStrict() and display censoring —
// then delegate to that core.
// The strictness used for gameplay matching: the active mode's strict flag (no mode
// sets it currently — every difficulty is stem-lenient, incl. Ultra), OR the player's
// global "stem matching off" opt-out (Settings → Gameplay) which forces exact-word
// matching even in lenient modes. NOT used for the rarity buckets/daily determinism
// (those pass explicit strict args), only for judging/highlighting a round.
function effectiveStrict() { return currentMode.strict || settings.stemMatching === false; }
// Per-challenge lever overrides: a challenge entry may set `noTitle` / `pool` to
// override the difficulty mode it borrows (e.g. Word Games allows title-word songs,
// From A to Z draws from the common pool so every round has options). Falls back to
// the active mode for non-challenge runs / challenges that don't override.
function effectiveNoTitle() {
  if (perkNoTitleOff) return false;            // Choose Your Path: Off The Record
  if (gameType === "challenge" && currentChallenge) {
    if (currentChallenge.rule === "devil" && devilNoTitle) return true;   // Devil's Path: No Giveaways
    if (currentChallenge.noTitle !== undefined) return currentChallenge.noTitle;
  }
  return currentMode.noTitle;
}
function effectivePool() {
  if (gameType === "adaptive") return ADAPTIVE_BUCKETS[adaptiveLevel] || "all";   // Adaptive: level drives the rarity bucket
  if (perkPoolOverride) return perkPoolOverride;   // Choose Your Path: Crowd Pleaser
  if (gameType === "challenge" && currentChallenge) {
    if (currentChallenge.rule === "devil" && devilPoolHard) return "hard";   // Devil's Path: Rarer Air
    if (currentChallenge.pool) return currentChallenge.pool;
  }
  return currentMode.pool;
}
// Whether suggestions (the title dropdown) are live right now. Off in lyric-only modes,
// off on a Switch-Up lyric page (a dropdown would hand over the title), and off once
// Devil's Path's "In The Dark" curse has been taken.
function effectiveDropdown() {
  if (lyricModeNow()) return false;
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "devil" && devilDropOff) return false;
  // Adaptive: the rarest tiers switch suggestions off so they test recall, not recognition.
  if (gameType === "adaptive" && adaptiveLevel >= ADAPT_NODROP_LEVEL) return false;
  return currentMode.dropdown;
}
// Whether THIS page accepts only a sung lyric line (no title): Lyricist mode always, and
// Switch-Up on a lyric page.
function lyricModeNow() {
  if (currentMode.lyricOnly) return true;
  return gameType === "challenge" && currentChallenge && currentChallenge.rule === "switchup" && roundLyricOnly;
}
// Lenient (default) also matches the inflected forms above (cheat→cheats); strict
// requires the exact word. Defaults to the active mode + the stem-matching opt-out.
function wordRegex(word, strict) {
  if (strict === undefined) strict = effectiveStrict();
  return wordRegexCore(word, strict);
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
  if (!effectiveNoTitle() || effectiveDropdown()) { el.style.display = "none"; el.innerHTML = ""; return; }
  const titles = titleSongsForWord(currentWord, effectiveStrict()).map((s) => s.title);
  if (!titles.length) { el.style.display = "none"; el.innerHTML = ""; return; }
  const SHOWN = 3;
  const shown = titles.slice(0, SHOWN)
    .map((t) => `<span class="ex-title">${escapeHtml(censor(t))}</span>`);
  if (titles.length > SHOWN) shown.push(`<span class="ex-more">+${titles.length - SHOWN} more</span>`);
  const lead = titles.length === 1 ? "can’t be played — it’s in the title" : "can’t be played — they’re in the title";
  el.innerHTML = `<span class="ex-lead">${lead}</span>${shown.join("")}`;
  el.style.display = "";
}
function extractLineWithWord(lyrics, word, strict) {
  if (strict === undefined) strict = effectiveStrict();
  return extractLineWithWordCore(lyrics, word, strict);
}
// Mask explicit words for display. The racial slur is always masked; general
// profanity only when the player turns on "censor explicit words". The prompt word
// itself is never explicit (the one near-miss, "damn", is left uncensored), so
// masking a line never touches the word we go on to highlight. See censorText (util.js).
function censor(text) { return censorText(text, settings.censorExplicit === true); }
function highlightWord(line, word, strict) {
  if (strict === undefined) strict = effectiveStrict();
  return highlightWordCore(censor(line), word, strict);
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
// Recent run scores for the "recent form" sparkline (oldest→newest, capped).
// All tab = every classic run; a mode tab = that mode's runs. Daily/Infinite use
// different score scales, so they're excluded — the same scope as the All
// histogram, which sums only the classic difficulty boards.
function recentScores(viewMode, cap = 12) {
  const picked = loadHistory().filter((e) =>
    viewMode === "all" ? e.t === "classic" : e.m === viewMode);
  return picked.slice(0, cap).map((e) => e.s).reverse();
}
// Rolling "forgiving form" average — the mean score of the last `cap` games for
// this view (TypeRacer-style, so a bad month stops haunting the number). Same
// scope as recentScores/the histogram (All = classic runs, a mode tab = that
// mode); includes hinted runs, which is fine for recent *form*. Returns the
// average and the actual sample size (< cap when there aren't `cap` games yet),
// so the label can read "last 8" honestly instead of padding.
function recentAverage(viewMode, cap = 20) {
  const picked = loadHistory().filter((e) =>
    viewMode === "all" ? e.t === "classic" : e.m === viewMode);
  const window = picked.slice(0, cap);
  const n = window.length;
  if (n === 0) return { avg: null, n: 0 };
  return { avg: window.reduce((a, e) => a + e.s, 0) / n, n };
}
// A small hand-inked sparkline of recent scores (0–TOTAL_ROUNDS), with a dotted
// baseline at the window's average and a filled dot on the latest game.
function sparklineSVG(scores) {
  const W = 360, H = 40, pad = 6, top = 6, bot = 34, n = scores.length;
  const x = (i) => n === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (n - 1);
  const y = (v) => bot - (Math.min(v, TOTAL_ROUNDS) / TOTAL_ROUNDS) * (bot - top);
  const pts = scores.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const avg = scores.reduce((a, b) => a + b, 0) / n;
  const ay = y(avg).toFixed(1), lx = x(n - 1).toFixed(1), ly = y(scores[n - 1]).toFixed(1);
  return `<svg class="form-spark" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="${ay}" x2="${W}" y2="${ay}" class="form-base"/>
    <polyline points="${pts}" class="form-line"/>
    <circle cx="${lx}" cy="${ly}" r="3.6" class="form-dot"/>
  </svg>`;
}
// Last difficulty viewed under the Classic tier this session — so re-clicking
// "Classic" (after a detour through All/Infinite) returns there, not to the
// active play mode. Falls back to currentMode.id until a difficulty is opened.
let lastStatsDifficulty = null;
function renderStats(lastScore, viewMode = defaultStatsView()) {
  const el = $("statsBody");
  // "classic" is a tier-1 selector, not a real view — resolve it to a difficulty.
  if (viewMode === "classic") viewMode = lastStatsDifficulty || currentMode.id;
  const isAll = viewMode === "all";
  const isInf = viewMode === "infinite";
  const isAdaptive = viewMode === "adaptive";
  const isClassic = !isAll && !isInf && !isAdaptive; // a difficulty mode id
  if (isClassic) lastStatsDifficulty = viewMode;
  // Two-tier tabs (mirrors the start screen). Tier 1 = view / game type:
  // All · Classic · Infinite · Adaptive. Tier 2 = difficulty, shown only under Classic.
  const tier1 = `<div class="mode-tabs stats-tabs">` +
    `<button type="button" class="mode-tab${isAll ? " active" : ""}" data-statmode="all">All</button>` +
    `<button type="button" class="mode-tab${isClassic ? " active" : ""}" data-statmode="classic">Classic</button>` +
    `<button type="button" class="mode-tab mode-tab--inf${isInf ? " active" : ""}" data-statmode="infinite"><span class="inf-glyph" aria-hidden="true">∞</span>Infinite</button>` +
    `<button type="button" class="mode-tab${isAdaptive ? " active" : ""}" data-statmode="adaptive">Adaptive</button>` +
    `</div>`;
  const tier2 = isClassic
    ? `<div class="mode-tabs stats-subtabs">` + MODE_ORDER.map((m) =>
        `<button type="button" class="mode-tab${m === viewMode ? " active" : ""}" data-statmode="${m}">${MODES[m].label}</button>`
      ).join("") + `</div>`
    : "";
  const tabs = tier1 + tier2;

  // Infinite is its own game type — its own headline + ledger, not the 0–13 histogram.
  if (isInf) {
    el.innerHTML = tabs + infiniteTabHTML();
    el.querySelectorAll("[data-statmode]").forEach((b) =>
      b.addEventListener("click", () => renderStats(lastScore, b.dataset.statmode)));
    return;
  }

  // Adaptive is its own game type too — ranked on the peak level reached, not a 0–13 score.
  if (isAdaptive) {
    el.innerHTML = tabs + adaptiveTabHTML();
    el.querySelectorAll("[data-statmode]").forEach((b) =>
      b.addEventListener("click", () => renderStats(lastScore, b.dataset.statmode)));
    return;
  }

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
      const tip = `scored ${score}/${TOTAL_ROUNDS} · ${count} time${count === 1 ? "" : "s"}`;
      return `<div class="histogram-col" data-tip="${tip}">
        <div class="histogram-bar${isYou ? " has-you" : ""}" style="height:${Math.max(h, count > 0 ? 4 : 2)}px"></div>
        <div class="histogram-score">${score}</div>
      </div>`;
    }).join("");
    // Best correct-in-a-row (lifetime, per mode; max across modes in the All view) +
    // perfect-game count. Same two cells for every tab.
    // "By the numbers" header (design E): three primaries on top, then a
    // recent-form sparkline beside the secondary stats (best-in-a-row, perfect).
    const recent = recentScores(viewMode);
    const formPanel = recent.length >= 2
      ? sparklineSVG(recent)
      : `<span class="statE-form-empty">— more games will draw your form —</span>`;
    const star = `<span class="statE-star">${STAR_SVG}</span>`;
    // Rolling "forgiving form" — last-20 average, sitting beside the lifetime
    // best/average so a gentle current number reads against the aspirational one.
    const form = recentAverage(viewMode);
    const formChip = form.avg === null
      ? `<div class="statE-cell"><span class="statE-val statE-accent">–</span><span class="statE-lbl">Recent</span></div>`
      : `<div class="statE-cell"><span class="statE-val statE-accent">${form.avg.toFixed(1)}</span><span class="statE-lbl">Last ${form.n}</span></div>`;
    body = `
      <div class="statE-top">
        <div class="statE-cell"><span class="statE-val">${s.played}</span><span class="statE-lbl">Played</span></div>
        <div class="statE-cell"><span class="statE-val statE-best">${s.best}</span>${star}<span class="statE-lbl">Best</span></div>
        <div class="statE-cell"><span class="statE-val">${avg}</span><span class="statE-lbl">Average</span></div>
      </div>
      <div class="statE-form">
        <div class="statE-form-spark">
          <span class="statE-lbl statE-form-lbl">recent form${recent.length >= 2 ? " · last " + recent.length : ""}</span>
          ${formPanel}
        </div>
        <div class="statE-chips">
          ${formChip}
          <div class="statE-cell"><span class="statE-val statE-accent">${s.bestInRow || 0}</span><span class="statE-lbl">In a row</span></div>
          <div class="statE-cell"><span class="statE-val statE-accent">${s.scoreCounts[TOTAL_ROUNDS] || 0}</span>${star}<span class="statE-lbl">Perfect</span></div>
        </div>
      </div>
      <p class="histogram-label">score distribution</p>
      <div class="histogram">${bars}</div>`;
  }

  // Catalogue, lifetime numbers + daily streak are lifetime summaries — All tab only.
  if (isAll) body += extraStatsHTML() + lifetimeStatsHTML() + dailyStatsHTML();
  el.innerHTML = tabs + body;
  el.querySelectorAll("[data-statmode]").forEach((b) =>
    b.addEventListener("click", () => renderStats(lastScore, b.dataset.statmode)));
  el.querySelectorAll("[data-open-songbook]").forEach((b) =>
    b.addEventListener("click", () => openSongbook(b.dataset.openSongbook)));
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

// Display name for an album — long titles that overflow the keepsake cards get a
// short form (e.g. "The Tortured Poets Department" → "TTPD").
function albumDisplayName(name) {
  return name === "The Tortured Poets Department" ? "TTPD" : name;
}

// Lifetime catalogue stats — global (not per-mode), drawn from the per-song/per-word
// tally written in endGame. Shows under every Stats tab, like the daily streak.
// Three zones: a hero "songs discovered" meter (filled portion split into album-colour
// segments), two album-tinted keepsake cards, and a red-pen-circled nemesis word.
function lifetimeStatsHTML() {
  const t = loadSongTally();
  const m = loadMetrics();
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
  // Floor, not round — 243/244 must read 99%, never a misleading 100% before completion.
  const pct = Math.floor((discovered / total) * 100);

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

  // The meter doubles as the door into the songbook (the missing-songs checklist that
  // backs the "I Hate It Here" charm) — same tally, drilled into per-album detail.
  const remaining = total - discovered;
  const meter = `
    <button type="button" class="cat-meter cat-meter--btn" data-open-songbook="stats">
      <div class="cat-meter-head"><span>songs discovered</span><span>${pct}%</span></div>
      <div class="cat-meter-num"><b>${discovered}</b> / ${total} songs</div>
      <div class="cat-bar">${segs}</div>
      <div class="cat-meter-cta">${remaining > 0 ? remaining + " still to find" : "every song found ★"} <span aria-hidden="true">→</span></div>
    </button>`;

  // Words discovered — distinct prompt words answered correctly, out of the playable set.
  const wordsFound = Object.keys(t.words || {}).length;
  const wordTotal = playableWords.length || 1;
  const wordPct = Math.floor((wordsFound / wordTotal) * 100);
  const wordMeter = `
    <div class="cat-meter">
      <div class="cat-meter-head"><span>words discovered</span><span>${wordPct}%</span></div>
      <div class="cat-meter-num"><b>${wordsFound}</b> / ${wordTotal} words</div>
      <div class="cat-bar"><div class="cat-seg" style="width:${(wordsFound / wordTotal) * 100}%;background:var(--ink-accent)"></div></div>
    </div>`;

  const songCard = `
    <div class="cat-card" style="border-left-color:${songColor}">
      <div class="cat-card-head"><span class="cat-star">${STAR_SVG}</span>favourite song</div>
      <div class="cat-card-val">${favSong ? escapeHtml(censor(favSong.key)) : "—"}</div>
      <div class="cat-card-sub" style="color:${songColor}">${favSong ? (songAlbum ? escapeHtml(albumDisplayName(songAlbum)) + " · " : "") + "sung ×" + favSong.count : "play a game"}</div>
    </div>`;
  const albumCard = `
    <div class="cat-card" style="border-left-color:${albColor}">
      <div class="cat-card-head"><span class="cat-dot" style="background:${albColor}"></span>favourite album</div>
      <div class="cat-card-val">${favAlbum ? escapeHtml(albumDisplayName(favAlbum.key)) : "—"}</div>
      <div class="cat-card-sub" style="color:${albColor}">${favAlbum ? "×" + favAlbum.count + " correct" : "play a game"}</div>
    </div>`;

  // The nemesis word is a real prompt word, so it deep-links straight into the lyric
  // searcher — one click to see every song that holds the word you keep missing.
  const nemesisSub = nemesis
    ? `missed ×${nemesis.count} · <a class="cat-search-link" href="search/#q=${encodeURIComponent(nemesis.key)}" title="See every song with “${escapeHtml(nemesis.key)}” in the lyric searcher">look it up →</a>`
    : "no misses yet";
  const nemesisBlock = `
    <div class="cat-nemesis">
      <div>
        <div class="cat-card-head">nemesis word</div>
        <div class="cat-nemesis-sub">${nemesisSub}</div>
      </div>
      <div class="cat-nemesis-word">
        <span>${nemesis ? escapeHtml(nemesis.key) : "—"}</span>
        <svg viewBox="0 0 160 60" preserveAspectRatio="none" aria-hidden="true">
          <path d="M18 30 C18 12, 60 8, 90 10 C130 13, 152 22, 150 34 C148 48, 100 54, 64 52 C28 50, 12 42, 16 28" fill="none" stroke="rgba(178,58,58,0.7)" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      </div>
    </div>`;

  // "From memory" — the verse-bonus prestige tally (lyric lines recalled, word-perfect ones).
  // Paired beside the nemesis word so neither owns a whole row.
  const lines = m.lyricLines || 0;
  const perfect = m.versePerfect || 0;
  const fromMemoryBlock = `
    <div class="cat-frommemory">
      <div class="cat-card-head"><span class="cat-star">${STAR_SVG}</span>from memory</div>
      <div class="cat-fm-val">${lines}</div>
      <div class="cat-fm-sub">${lines ? "lines written · " + perfect + " word-perfect" : "write a lyric line"}</div>
    </div>`;

  return header + `<div class="cat-wrap">${meter}${wordMeter}<div class="cat-cards">${songCard}${albumCard}</div><div class="cat-pair">${fromMemoryBlock}${nemesisBlock}</div></div>`;
}

// Daily-challenge streak — global (not per-mode), so it shows under every tab.
// --- Hand-inked marker marks for the daily calendar ---------------------------
// Each X/O is a one-off: drawn from pressure-tapered ribbon strokes (fat-marker
// profile — near-uniform body, blunt rounded tips) with per-mark jitter, so no two
// look stamped. Rendered as inline SVG strings (the Stats body is set via innerHTML),
// re-randomised on every renderStats call. multiply blend makes the X's crossing and
// the O's self-overlap bleed darker, like wet ink. See CLAUDE.md "daily calendar".
const MARK_REDS = ["#c0352b", "#b62f27", "#c43d31", "#aa2c25"];
const MARK_GREENS = ["#2f6d4f", "#356f4a", "#2b6044"];
const mRand = (a, b) => a + Math.random() * (b - a);
const mPick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Centerline → filled ribbon path (+ rounded tip circles). wmax = full body width.
function markerRibbon(pts, wmax) {
  const N = pts.length - 1, left = [], right = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const shape = Math.pow(Math.sin(Math.PI * t), 0.32);   // flat-topped: blunt ends
    const w = wmax * (0.78 + 0.22 * shape);
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(N, i + 1)];
    const tx = p1[0] - p0[0], ty = p1[1] - p0[1], tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl, ny = tx / tl;
    left.push([pts[i][0] + nx * w / 2, pts[i][1] + ny * w / 2]);
    right.push([pts[i][0] - nx * w / 2, pts[i][1] - ny * w / 2]);
  }
  let d = "M " + left[0][0].toFixed(2) + " " + left[0][1].toFixed(2);
  for (let i = 1; i <= N; i++) d += " L " + left[i][0].toFixed(2) + " " + left[i][1].toFixed(2);
  for (let i = N; i >= 0; i--) d += " L " + right[i][0].toFixed(2) + " " + right[i][1].toFixed(2);
  return { d: d + " Z", a: pts[0], b: pts[N], r: wmax * 0.39 };
}

// One marker stroke: a single smooth arc (wrist pivot) with overshoot + soft lift.
function markerSlash(a, b, bow, hook) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const os = len * mRand(0.02, 0.06);
  const A = [a[0] - ux * os, a[1] - uy * os], B = [b[0] + ux * os, b[1] + uy * os];
  const cx = (A[0] + B[0]) / 2 + nx * bow, cy = (A[1] + B[1]) / 2 + ny * bow;
  const N = 24, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, mt = 1 - t;
    pts.push([mt * mt * A[0] + 2 * mt * t * cx + t * t * B[0], mt * mt * A[1] + 2 * mt * t * cy + t * t * B[1]]);
  }
  if (hook) {
    const K = 4, piv = pts[N - K], cs = Math.cos(hook), sn = Math.sin(hook);
    for (let i = N - K + 1; i <= N; i++) {
      const vx = pts[i][0] - piv[0], vy = pts[i][1] - piv[1];
      pts[i] = [piv[0] + vx * cs - vy * sn, piv[1] + vx * sn + vy * cs];
    }
  }
  return pts;
}

function ribbonSVG(rib, col, op) {
  const o = op.toFixed(2), cap = (p) =>
    `<circle cx="${p[0].toFixed(2)}" cy="${p[1].toFixed(2)}" r="${rib.r.toFixed(2)}" fill="${col}" opacity="${o}" style="mix-blend-mode:multiply"/>`;
  return `<path d="${rib.d}" fill="${col}" opacity="${o}" stroke-linejoin="round" style="mix-blend-mode:multiply"/>` + cap(rib.a) + cap(rib.b);
}

function markerX(s) {
  const col = mPick(MARK_REDS), w = s * mRand(0.12, 0.155), op = mRand(0.8, 0.9);
  const pad = s * mRand(0.18, 0.23), off = mRand(-s * 0.05, s * 0.05);
  const j = (v) => v + mRand(-s * 0.04, s * 0.04);
  const s1 = markerSlash([j(pad), j(pad)], [j(s - pad), j(s - pad)], mRand(-s * 0.06, s * 0.06), mRand(0.05, 0.22) * mPick([1, -1]));
  const s2 = markerSlash([j(s - pad) + off, j(pad)], [j(pad) + off, j(s - pad)], mRand(-s * 0.06, s * 0.06), mRand(0.05, 0.22) * mPick([1, -1]));
  const inner = ribbonSVG(markerRibbon(s1, w), col, op) + ribbonSVG(markerRibbon(s2, w * mRand(0.94, 1.06)), col, op);
  return `<svg class="cal-mark" viewBox="0 0 ${s} ${s}" style="transform:rotate(${mRand(-11, 11).toFixed(1)}deg)">${inner}</svg>`;
}

function markerO(s) {
  const col = mPick(MARK_GREENS), w = s * mRand(0.11, 0.14), op = mRand(0.8, 0.9);
  const cx = s / 2 + mRand(-s * 0.03, s * 0.03), cy = s / 2 + mRand(-s * 0.03, s * 0.03);
  const rx = s * mRand(0.32, 0.37), ry = s * mRand(0.31, 0.36);
  const tilt = mRand(-0.3, 0.3), ct = Math.cos(tilt), st = Math.sin(tilt);
  const start = mRand(-2.6, -1.6), sweep = Math.PI * 2 * mRand(1.05, 1.13), ph = mRand(0, 6.28);
  const N = 60, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, a = start + sweep * t, wob = 1 + 0.022 * Math.sin(a * 2 + ph);
    const x = Math.cos(a) * rx * wob, y = Math.sin(a) * ry * wob;
    pts.push([cx + x * ct - y * st, cy + x * st + y * ct]);
  }
  return `<svg class="cal-mark" viewBox="0 0 ${s} ${s}" style="transform:rotate(${mRand(-9, 9).toFixed(1)}deg)">${ribbonSVG(markerRibbon(pts, w), col, op)}</svg>`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// The current month as a notebook calendar: today ringed in green marker, every
// completed-daily day struck out with a unique red marker X. Month/today come from
// todayKey() (active timezone); the crossed-off set from dailyPlayedDates().
function dailyCalendarHTML() {
  const today = todayKey();                       // YYYY-MM-DD in the active zone
  const [yy, mm, dd] = today.split("-").map(Number);
  const monthIdx = mm - 1;
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(yy, monthIdx, 1)).getUTCDay();   // 0 = Sunday
  const pad2 = (n) => String(n).padStart(2, "0");
  const monthPrefix = `${yy}-${pad2(mm)}-`;
  const played = dailyPlayedDates();

  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<div class="cal-cell cal-blank"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = day === dd, done = played[monthPrefix + pad2(day)] != null;
    let ink = "";
    if (isToday) ink += markerO(30);
    if (done) ink += markerX(30);
    const cls = "cal-cell" + (day > dd ? " cal-future" : "") + (isToday ? " cal-today" : "");
    cells += `<div class="${cls}"><span class="cal-num">${day}</span><span class="cal-ink">${ink}</span></div>`;
  }
  const dows = ["S", "M", "T", "W", "T", "F", "S"].map((x) => `<div class="cal-dow">${x}</div>`).join("");
  return `<div class="daily-cal">` +
    `<div class="cal-head"><span class="cal-month">${MONTH_NAMES[monthIdx]}</span><span class="cal-year">${yy}</span></div>` +
    `<div class="cal-grid cal-dows">${dows}</div>` +
    `<div class="cal-grid cal-days">${cells}</div>` +
    `</div>`;
}

function dailyStatsHTML() {
  const d = effectiveDailyStreak(todayKey());
  const cal = dailyCalendarHTML();
  const head = `<p class="histogram-label" style="margin-top:24px;">daily challenge</p>`;
  if (!d.lastPlayed) {
    return head + cal + `<p class="stats-empty">no daily runs yet — try today's Daily Challenge!</p>`;
  }
  const note = d.playedToday
    ? `<p class="daily-streak-note">✓ played today's challenge</p>`
    : `<p class="daily-streak-note">today's challenge awaits</p>`;
  return head +
    `<div class="streak-row">` +
    `<div class="streak-cell"><span class="stat-val">🔥 ${d.current}</span><span class="stat-lbl">day streak</span></div>` +
    `<div class="streak-cell"><span class="stat-val">${d.best}</span><span class="stat-lbl">best streak</span></div>` +
    `</div>` + note + cal;
}

// Lifetime cross-game numbers — global (All tab only, like the catalogue). Drawn from
// the metrics store folded in endGame and the song tally. A notebook bento: an accuracy
// ring + album-spine meter up top, a row of quick-stat tiles, a daily footer. Empty
// until the first finished game. ("Best streak ever" lives in the per-tab block above —
// it's the same bestInRow value, so it isn't repeated here.)
// Tiny ink marginalia icons (18×18, stroked in currentColor).
const NUM_ICONS = {
  rounds:  `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M5 3h5l3 3v9H5z"/><path d="M10 3v3h3"/></svg>`,
  bolt:    `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M10.5 2L4.5 10H8l-.8 6 6.3-9H10z"/></svg>`,
  clock:   `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="9" cy="9" r="6.4"/><path d="M9 5v4.2l2.8 1.8" stroke-linecap="round"/></svg>`,
  lines:   `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.5 6h11M3.5 9h11M3.5 12h7"/></svg>`,
  cal:     `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="3" y="4.2" width="12" height="10.8" rx="1.2"/><path d="M3 7.4h12M6 2.6v2.6M12 2.6v2.6"/></svg>`,
  rosette: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><circle cx="9" cy="9" r="6.4"/><path d="M9 5.4l1 2.1 2.3.2-1.7 1.5.5 2.3L9 10.5 6.9 11.7l.5-2.3L5.7 7.7 8 7.5z"/></svg>`,
};

const RING_CIRC = 2 * Math.PI * 52;   // accuracy ring: r=52 in a 120×120 viewBox

function extraStatsHTML() {
  const m = loadMetrics();
  if (m.roundsTotal === 0) return "";
  const t = loadSongTally();
  const dt = dailyTotals();   // authoritative daily counts (per-day keys, not the metrics store)
  const secs = (ms) => (ms / 1000).toFixed(1) + "s";
  const fastest = m.fastestMs != null ? secs(m.fastestMs) : "—";
  const avg = m.answerN ? secs(m.answerSumMs / m.answerN) : "—";
  const accPct = m.roundsTotal ? Math.round((m.roundsCorrect / m.roundsTotal) * 100) : 0;
  const ringOffset = RING_CIRC * (1 - accPct / 100);

  // Album-spine meter: one bar per album in chronological catalogue order, lit in its
  // album colour once any of its songs has been answered, faint until then.
  const albumOrder = [];
  for (const s of allSongs) if (s.album && !albumOrder.includes(s.album)) albumOrder.push(s.album);
  const albumsTotal = albumOrder.length || 1;
  const albumsCollected = albumOrder.filter((a) => (t.albums || {})[a] > 0).length;
  const spines = albumOrder.map((a) => {
    const got = ((t.albums || {})[a] || 0) > 0;
    const c = got ? (albumColor(a) || "var(--ink-soft)") : "rgba(43,39,34,0.13)";
    return `<div class="num-spine" style="background:${c}" title="${escapeHtml(a)}"></div>`;
  }).join("");

  const tile = (icon, label, value) =>
    `<div class="num-card num-tile"><span class="num-ico">${NUM_ICONS[icon]}</span>` +
    `<span class="num-val">${value}</span><span class="num-sub">${label}</span></div>`;

  return `<p class="histogram-label" style="margin-top:24px;">by the numbers</p>
    <div class="num-hero-row">
      <div class="num-card num-acc">
        <div class="num-ring">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle class="num-ring-track" cx="60" cy="60" r="52"/>
            <circle class="num-ring-arc" cx="60" cy="60" r="52" transform="rotate(-90 60 60)"
              stroke-dasharray="${RING_CIRC.toFixed(1)}" stroke-dashoffset="${ringOffset.toFixed(1)}"/>
          </svg>
          <div class="num-ring-val"><b>${accPct}</b><span>%</span></div>
        </div>
        <div>
          <div class="num-lbl">Accuracy</div>
          <div class="num-sub">${m.roundsCorrect} of ${m.roundsTotal}<br>rounds right</div>
        </div>
      </div>
      <div class="num-card num-albums">
        <div class="num-albums-head">
          <span class="num-lbl">Albums collected</span>
          <span class="num-count">${albumsCollected}<i> / ${albumsTotal}</i></span>
        </div>
        <div class="num-spines">${spines}</div>
      </div>
    </div>
    <div class="num-tiles">
      ${tile("rounds", "Rounds played", m.roundsTotal)}
      ${tile("bolt", "Fastest", fastest)}
      ${tile("clock", "Avg time", avg)}
      ${tile("lines", "Lyric lines", m.lyricLines)}
    </div>
    <div class="num-card num-daily">
      <div class="num-daily-item">
        <span class="num-ico num-ico-lg">${NUM_ICONS.cal}</span>
        <div><div class="num-val num-val-md">${dt.played}</div><div class="num-sub">Daily challenges</div></div>
      </div>
      <div class="num-daily-div"></div>
      <div class="num-daily-item">
        <span class="num-ico num-ico-lg num-ico-gold">${NUM_ICONS.rosette}</span>
        <div><div class="num-val num-val-md num-gold">${dt.perfect}</div><div class="num-sub">Daily perfects</div></div>
      </div>
    </div>`;
}

// Infinite runs aren't comparable to the 13-round game (scores can exceed 13 and
// the 0–13 histogram is meaningless), so the Infinite tab gets its own body: a
// pen-circled headline (your single longest run + where it came from) and a ruled
// LEDGER — difficulty down the side, the two lives-variants across the top, each cell
// the best run + games played. No relative-fill bar (it was meaningless); the number
// carries it, the ruling does the structure, and a red-pen ellipse marks the all-time
// best. Colour-coded by variant — gold for forgiving 3-lives, danger-red for sudden death.
const INF_VARIANT_STYLE = {
  "3lives": { color: "#c08a2e", beads: 3 },
  sudden:   { color: "#b23a3a", beads: 1 },
};
function infiniteTabHTML() {
  const entries = [];
  for (const variant of ["3lives", "sudden"]) {
    for (const m of MODE_ORDER) {
      const st = loadStats("inf-" + variant + "-" + m);
      if (st.played > 0) entries.push({ variant, mode: m, best: st.best, played: st.played });
    }
  }
  if (!entries.length) {
    return `<p class="stats-empty">no infinite runs yet — try Infinite mode!</p>`;
  }
  // headline = the single longest run across every combo, + total infinite games played
  let top = entries[0], totalGames = 0;
  for (const e of entries) { totalGames += e.played; if (e.best > top.best) top = e; }
  const hero = `
    <div class="inf-hero">
      <div class="inf-medallion">
        <b>${top.best}</b><span>rounds</span>
      </div>
      <div class="inf-hero-text">
        <div class="inf-hero-title">your longest run</div>
        <div class="inf-hero-sub">${VARIANT_LABELS[top.variant]} · ${MODES[top.mode].label}</div>
      </div>
    </div>`;
  // ledger: a cell per variant×difficulty; unplayed = a faint dash; the best one is circled
  const cell = (variant, m) => {
    const e = entries.find((x) => x.variant === variant && x.mode === m);
    if (!e) return `<td class="inf-cell inf-cell--empty">–</td>`;
    const circ = (e === top)
      ? `<svg class="inf-circle" viewBox="0 0 90 50" aria-hidden="true"><ellipse cx="45" cy="25" rx="40" ry="20" fill="none" stroke="#b23a3a" stroke-width="1.6"/></svg>`
      : "";
    return `<td class="inf-cell">${circ}<span class="inf-cell-num" style="color:${INF_VARIANT_STYLE[variant].color}">${e.best}</span><span class="inf-cell-sub">${e.played} game${e.played === 1 ? "" : "s"}</span></td>`;
  };
  const colHead = (variant) => {
    const sty = INF_VARIANT_STYLE[variant];
    const beads = Array.from({ length: sty.beads }, () => `<i style="background:${sty.color}"></i>`).join("");
    return `<th><span class="inf-th-beads">${beads}</span>${VARIANT_LABELS[variant]}</th>`;
  };
  const rows = MODE_ORDER.map((m) =>
    `<tr><th class="inf-row-h">${MODES[m].label}</th>${cell("3lives", m)}${cell("sudden", m)}</tr>`
  ).join("");
  return hero +
    `<table class="inf-ledger"><thead><tr><th></th>${colHead("3lives")}${colHead("sudden")}</tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    `<p class="inf-foot">${totalGames} infinite game${totalGames === 1 ? "" : "s"} played · the circle marks your all-time best</p>`;
}

// Adaptive stats: the headline is the highest level ever reached (the board metric),
// with the four-rung ladder shown so the player can see where they've topped out.
function adaptiveTabHTML() {
  const rec = adaptiveRecord();
  if (!rec.played) {
    return `<p class="stats-empty">no adaptive runs yet — try Adaptive mode!</p>`;
  }
  const peakName = ADAPTIVE_LEVELS[rec.bestPeak] || "";
  const hero = `
    <div class="inf-hero">
      <div class="inf-medallion">
        <b>${rec.bestPeak}</b><span>level</span>
      </div>
      <div class="inf-hero-text">
        <div class="inf-hero-title">highest you've climbed</div>
        <div class="inf-hero-sub">${escapeHtml(peakName)} · ${rec.bestScore}/${TOTAL_ROUNDS} that run</div>
      </div>
    </div>`;
  // The ladder: each rung lit up to the best peak, the top one circled.
  const rungs = [];
  for (let lvl = ADAPT_MAX_LEVEL; lvl >= 1; lvl--) {
    const reached = lvl <= rec.bestPeak;
    const top = lvl === rec.bestPeak;
    rungs.push(
      `<tr class="adapt-rung${reached ? " reached" : ""}${top ? " peak" : ""}">` +
      `<th class="adapt-rung-lvl">L${lvl}</th>` +
      `<td class="adapt-rung-name">${escapeHtml(ADAPTIVE_LEVELS[lvl] || "")}</td>` +
      `<td class="adapt-rung-mark">${top ? "★ your peak" : reached ? "reached" : "—"}</td></tr>`
    );
  }
  return hero +
    `<table class="adapt-ladder"><tbody>${rungs.join("")}</tbody></table>` +
    `<p class="inf-foot">${rec.played} adaptive game${rec.played === 1 ? "" : "s"} played · ranked on the level you reach, not your score</p>`;
}

/* ---------- Achievements ---------- */
let earnedAchievements = {};   // persisted: { id: "YYYY-MM-DD" }
let burnedAchIds = new Set();   // charms sacrificed for a token — permanently un-earned
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

// The challenge-progress charms (the only achievements allowed to fire while a
// challenge run is active — everything else is sandboxed out). Derived from the group
// map so future challenge charms are covered automatically.
const CHALLENGE_ACH_IDS = new Set(ACHIEVEMENTS.filter((a) => ACH_GROUP_OF[a.id] === "challenges").map((a) => a.id));
function unlock(id) {
  // Sandbox: during a live challenge run, only the challenge-progress charms unlock —
  // no game-quality achievements (streaks, speed, etc.) leak in from mid-round checks.
  // The flag is cleared before endChallenge folds, so post-run meta charms still fire.
  if (challengeRunActive && !CHALLENGE_ACH_IDS.has(id)) return;
  if (!ACH_BY_ID[id] || earnedAchievements[id] || burnedAchIds.has(id)) return; // burned = gone for good
  earnedAchievements[id] = new Date().toISOString();   // full ISO so same-day charms sort by earn time
  saveAchievements(earnedAchievements);
  newlyUnlocked.push(id);
  showToast(ACH_BY_ID[id]);
  checkMetaAchievements();
}

// Re-evaluated after every unlock (each unlock no-ops if already earned, so this is safe to
// recurse). Covers the achievements whose condition is "you've earned other achievements":
//   karma          — your 13th charm.
//   is-it-over-now — every hidden (secret) achievement, the two meta ones excepted.
//   the-lucky-one  — 100%: every achievement but itself (is-it-over-now is earnable first,
//                    so there's no circular deadlock between the two meta charms).
const META_ACH = ["is-it-over-now", "the-lucky-one"];
function checkMetaAchievements() {
  if (Object.keys(earnedAchievements).length >= 13) unlock("karma");
  const hidden = ACHIEVEMENTS.filter((a) => a.secret && !META_ACH.includes(a.id));
  if (hidden.length && hidden.every((a) => earnedAchievements[a.id])) unlock("is-it-over-now");
  const all = ACHIEVEMENTS.filter((a) => a.id !== "the-lucky-one");
  if (all.length && all.every((a) => earnedAchievements[a.id])) unlock("the-lucky-one");
}

/* ---------- Challenges mode: token wallet + progress mutators ----------
   These run OUTSIDE the per-run fold (called from the page / endChallenge), so the
   challenge achievements they unlock don't violate the run sandbox. */
function tokenBalance() { return loadChallengeTokens().balance; }

// Spend a token to unlock a challenge. Returns true on success.
function unlockChallenge(id) {
  const c = CHALLENGE_BY_ID[id];
  if (!c) return false;
  const st = loadChallengeState();
  if (st[id] && st[id].unlocked) return true;       // already open
  const wallet = loadChallengeTokens();
  const cost = c.cost || 1;
  if (wallet.balance < cost) return false;           // can't afford
  wallet.balance -= cost;
  saveChallengeTokens(wallet);
  st[id] = { ...challengeRecord(id), unlocked: true };
  saveChallengeState(st);
  // Paper Rings — every challenge in the registry is now unlocked (free ones count).
  if (CHALLENGES.every((ch) => ch.free || challengeRecord(ch.id).unlocked)) unlock("paper-rings");
  return true;
}

// True if the player can start this challenge right now (free, already unlocked, or affordable).
function challengeUnlocked(id) {
  const c = CHALLENGE_BY_ID[id];
  return !!c && (c.free || challengeRecord(id).unlocked);
}

// Bump the attempt counter (called when a challenge run starts).
function recordChallengeAttempt(id) {
  const st = loadChallengeState();
  const rec = st[id] ? { ...challengeRecord(id) } : { ...challengeRecord(id), unlocked: !!CHALLENGE_BY_ID[id].free };
  rec.attempts += 1;
  st[id] = rec;
  saveChallengeState(st);
  return rec.attempts;
}

// Record a defeat. First-ever defeat awards a token and the milestone charms.
function markChallengeDefeated(id, score) {
  const st = loadChallengeState();
  const rec = { ...challengeRecord(id) };
  const firstTime = !rec.defeated;
  rec.defeated = true;
  if (score > rec.best) rec.best = score;
  st[id] = rec;
  saveChallengeState(st);
  if (firstTime) {
    const wallet = loadChallengeTokens();
    wallet.balance += 1;                              // the self-feeding reward
    saveChallengeTokens(wallet);
    unlock("the-archer");                             // first challenge ever defeated
    if (rec.attempts === 1) unlock("state-of-grace"); // beat it on the first try
    if (rec.attempts >= 5) unlock("this-is-me-trying");
    if (CHALLENGES.every((ch) => challengeRecord(ch.id).defeated)) unlock("the-alchemy");
  }
  return firstTime;
}

// Escape valve (tightened): you can SACRIFICE a skill charm toward a challenge token,
// but the price DOUBLES each time and the charm is gone for good.
//   - Only skill/mastery charms qualify (isTradeableAch): no freebies, no secret/easter-egg
//     charms, no challenge-group charms (which would let challenges fund themselves).
//   - The k-th conversion token costs 2^(k-1) charms, so the running total of charms you must
//     burn to have minted k tokens is 2^k - 1 (1, 3, 7, 15…).
//   - A sacrificed charm is permanently un-earned: it drops off the collection %, the by-theme
//     bars and the completion metas (the-lucky-one / is-it-over-now), and can't be re-earned.
function achEarned(id) { return !!earnedAchievements[id] && !burnedAchIds.has(id); }
function isTradeableAch(a) {
  return !!a && !a.secret && achGroupOf(a.id) !== "challenges" && !ACH_NO_TRADE.has(a.id);
}
// tokens minted from `n` burned charms (cumulative cost for k tokens is 2^k - 1), and the
// running total needed for the next one. Integer loop — exact at the power-of-2 thresholds.
function tokensFromBurned(n) { let k = 0; while ((2 ** (k + 1)) - 1 <= n) k++; return k; } // 0,1,1,2,3…
function burnedNeededForNextToken(n) { return (2 ** (tokensFromBurned(n) + 1)) - 1; }

// Sacrifice one charm. Returns {minted} (a token may or may not drop this burn — higher
// tiers cost several charms), or false if the charm isn't eligible.
function sacrificeAchievement(achId) {
  const a = ACH_BY_ID[achId];
  if (!a || !achEarned(achId) || !isTradeableAch(a)) return false;
  const wallet = loadChallengeTokens();
  if (!Array.isArray(wallet.burnedAchievements)) wallet.burnedAchievements = [];
  const before = tokensFromBurned(wallet.burnedAchievements.length);
  wallet.burnedAchievements.push(achId);
  const minted = tokensFromBurned(wallet.burnedAchievements.length) - before; // 0 or 1
  wallet.balance += minted;
  saveChallengeTokens(wallet);
  // burn the charm: drop it from earned (so it stops counting) + tombstone it so it can't return.
  burnedAchIds.add(achId);
  delete earnedAchievements[achId];
  saveAchievements(earnedAchievements);
  if (minted) unlock("castles-crumbling");
  return { minted };
}

// "The Piano Was Hissing" — typing "rep tv" / "reputation tv" as an answer OR as your name.
// Letters-only so spacing/case/punctuation don't matter.
function checkPianoEgg(s) {
  const k = (s || "").toLowerCase().replace(/[^a-z]/g, "");
  if (k === "reptv" || k === "reputationtv") unlock("piano-was-hissing");
}

/* ---------- Custom tooltips (data-tip; controllable delay, no clipping) ---------- */
// A single body-level bubble shared by every [data-tip] element. Default shows
// immediately; an element can opt into a delay with data-tip-delay (ms).
let _tipEl = null, _tipTimer = null;
function ensureTipEl() {
  if (_tipEl) return _tipEl;
  _tipEl = document.createElement("div");
  _tipEl.className = "tip-pop";
  _tipEl.setAttribute("role", "tooltip");
  document.body.appendChild(_tipEl);
  return _tipEl;
}
function positionTip(el, target) {
  const r = target.getBoundingClientRect();
  el.style.left = "0px"; el.style.top = "0px";   // measure unclamped
  const tr = el.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
  let top = r.top - tr.height - 8;
  if (top < 6) top = r.bottom + 8;               // flip below if no room above
  el.style.left = left + "px";
  el.style.top = top + "px";
}
function showTip(target) {
  if (!target.isConnected) return;   // target removed before a delayed show fired
  const text = target.getAttribute("data-tip");
  if (!text) return;
  const el = ensureTipEl();
  el.textContent = text;
  el.classList.add("show");
  positionTip(el, target);
}
function hideTip() {
  clearTimeout(_tipTimer);
  if (_tipEl) _tipEl.classList.remove("show");
}
function setupTooltips() {
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-tip]");
    if (!t) return;
    clearTimeout(_tipTimer);
    const delay = parseInt(t.getAttribute("data-tip-delay") || "0", 10);
    if (delay > 0) _tipTimer = setTimeout(() => showTip(t), delay);
    else showTip(t);
  });
  document.addEventListener("mouseout", (e) => {
    const t = e.target.closest("[data-tip]");
    if (!t || t.contains(e.relatedTarget)) return;
    hideTip();
  });
  window.addEventListener("scroll", hideTip, true);
}

// A plain (non-achievement) toast — a short heading + message. Reuses the
// achievement toast stack + auto-dismiss, so failures surface instead of being silent.
function notifyNote(label, msg) {
  const layer = $("toastLayer");
  if (!layer) return;
  const t = document.createElement("div");
  t.className = "toast toast-note";
  t.innerHTML = `<div><div class="t-label">${escapeHtml(label)}</div><div class="t-name">${escapeHtml(msg)}</div></div>`;
  layer.appendChild(t);
  scheduleToastDismiss();
}

function showToast(a) {
  const layer = $("toastLayer");
  if (!layer) return;
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("data-tip", a.desc);
  t.setAttribute("data-tip-delay", "500");
  t.innerHTML = charmMarkup(a.icon) +
    `<div><div class="t-label">achievement unlocked</div><div class="t-name">${escapeHtml(a.name)}</div></div>`;
  layer.appendChild(t);
  scheduleToastDismiss();
}

// Toasts leave the stack one at a time from the bottom (not all at once when
// several unlock together): the bottom one slides out, the toasts above glide
// down into the freed slot (FLIP) and dwell ~1s, then the new bottom leaves.
let toastDismissTimer = null;
function scheduleToastDismiss() {
  if (toastDismissTimer) return;            // a dismissal cycle is already running
  const layer = $("toastLayer");
  if (!layer) return;
  const tick = () => {
    const toasts = [...layer.querySelectorAll(".toast:not(.leaving)")];
    if (!toasts.length) { toastDismissTimer = null; return; }
    const bottom = toasts[toasts.length - 1];   // last child = bottom of the stack
    const above = toasts.slice(0, -1);
    const beforeTops = above.map((el) => el.getBoundingClientRect().top);
    bottom.classList.add("leaving");
    setTimeout(() => {
      bottom.remove();
      hideTip();   // removal fires no mouseout, so a tooltip on this toast would otherwise linger

      // FLIP: the removal collapses the layout instantly, so smoothly animate the
      // toasts above from their old positions down into their new ones.
      if (!motionReduced()) {
        above.forEach((el, i) => {
          const dy = beforeTops[i] - el.getBoundingClientRect().top;   // <0: moved down
          if (!dy) return;
          el.style.transition = "none";
          el.style.transform = `translateY(${dy}px) rotate(-1deg)`;
          requestAnimationFrame(() => {
            el.style.transition = "transform 0.34s cubic-bezier(.34,1.1,.64,1)";
            el.style.transform = "rotate(-1deg)";
          });
        });
      }
    }, 420);
    toastDismissTimer = setTimeout(tick, 420 + 340 + 900);   // leave + drop + dwell
  };
  toastDismissTimer = setTimeout(tick, 3000);   // initial dwell before the first leaves
}

// The results keepsake: lines the player recalled word-for-word this run, re-written
// in faint handwriting like verses pressed into the notebook. Skipped when empty or on
// a held-back daily score (it would leak how the round went). ★ = word-perfect line,
// ★★ = a whole verse.
function renderVerseAnthology() {
  const el = $("verseAnthology");
  if (!el) return;
  if (!verseKeepsake.length || (gameType === "daily" && settings.hideDailyScore)) {
    el.style.display = "none"; el.innerHTML = ""; return;
  }
  const rows = verseKeepsake.map((k) => {
    const mark = k.tier === "verse" ? "★★" : "★";
    return `<li class="va-row"><span class="va-mark">${mark}</span>` +
      `<span class="va-text">${highlightWord(k.line, k.word)}</span></li>`;
  }).join("");
  const n = verseKeepsake.length;
  el.innerHTML = `<p class="va-caption">pages you filled in — ${n} line${n > 1 ? "s" : ""} from memory</p>` +
    `<ul class="va-list">${rows}</ul>`;
  el.style.display = "";
}

function renderResultRecap() {
  const el = $("resultAchievements");
  if (!el) return;
  const ids = [...new Set(newlyUnlocked)].filter((id) => ACH_BY_ID[id] && earnedAchievements[id]);
  if (!ids.length) { el.style.display = "none"; el.innerHTML = ""; return; }
  const chips = ids.map((id) => {
    const a = ACH_BY_ID[id];
    return `<button type="button" class="ach-chip" data-tip="${escapeHtml(a.desc)}" data-tip-delay="120">${charmMarkup(a.icon)}<span class="nm">${escapeHtml(a.name)}</span></button>`;
  }).join("");
  el.innerHTML = `<div class="ach-recap-title">newly unlocked</div><div class="ach-recap-row">${chips}</div>`;
  el.style.display = "";
  // tapping any charm jumps to the full Charm Collection (back-arrow returns here)
  el.querySelectorAll(".ach-chip").forEach((c) => c.addEventListener("click", () => openAchievements("results")));
}

// The (tightened) escape valve: a skill charm can be SACRIFICED toward a challenge
// token. Two-tap to confirm (it's permanent). Legacy cash-ins keep their ticket badge.
let armedSacrifice = null, armSacrificeTimer = null, sacrificeNote = "";
function achSacrificeMarkup(a) {
  const w = loadChallengeTokens();
  if ((w.fromAchievements || []).includes(a.id)) // grandfathered legacy cash-in
    return `<span class="ach-ticket" title="cashed in for a challenge token">🎟</span>`;
  if (!isTradeableAch(a)) return `<span class="ach-cashin ach-cashin--disabled" title="only visible non-challenge skill charms can be sacrificed">keepsake</span>`;
  if (armedSacrifice === a.id)
    return `<button type="button" class="ach-cashin is-armed" data-sacrifice="${a.id}" title="this can't be undone">give up for good?</button>`;
  return `<button type="button" class="ach-cashin" data-sacrifice="${a.id}" title="sacrifice this charm toward a challenge token — permanent">sacrifice ✦</button>`;
}

// One charm tile: earned (revealed), a sacrificed charm (given up), a still-locked
// secret (masked ???), or a visible locked target. Shared by the grid + secret section.
function achTile(a) {
  if (burnedAchIds.has(a.id)) {
    return `<div class="ach ach--given" title="sacrificed for a challenge token">${charmMarkup(a.icon)}<div class="ach-text"><div class="ach-nm">${escapeHtml(a.name)}</div><div class="ach-dc">given up for a token 🎟</div></div></div>`;
  }
  if (earnedAchievements[a.id]) {
    return `<div class="ach ach--earned">${charmMarkup(a.icon)}<div class="ach-text"><div class="ach-nm">${escapeHtml(a.name)}</div><div class="ach-dc">${escapeHtml(a.desc)}</div></div>${achSacrificeMarkup(a)}</div>`;
  }
  if (a.secret) {
    return `<div class="ach locked secret"><span class="charm-q" aria-hidden="true">?</span><div class="ach-text"><div class="ach-nm">???</div><div class="ach-dc">a secret charm</div></div></div>`;
  }
  return `<div class="ach locked">${charmMarkup(a.icon)}<div class="ach-text"><div class="ach-nm">${escapeHtml(a.name)}</div><div class="ach-dc">${escapeHtml(a.desc)}</div></div></div>`;
}

const achGroupOf = (id) => ACH_GROUP_OF[id] || "core";

function renderAchievementsPage() {
  const total = ACHIEVEMENTS.length;
  // earned, oldest → newest (the newest is the "latest charm")
  const earnedAsc = ACHIEVEMENTS.filter((a) => earnedAchievements[a.id])
    .sort((x, y) => (earnedAchievements[x.id] || "").localeCompare(earnedAchievements[y.id] || ""));
  const earnedCount = earnedAsc.length;
  const pct = Math.round((earnedCount / total) * 100);

  const wallet = loadChallengeTokens();
  const burnedCount = (wallet.burnedAchievements || []).length;
  const tradeableLeft = ACHIEVEMENTS.filter((a) => achEarned(a.id) && isTradeableAch(a)).length;
  const needNext = burnedNeededForNextToken(burnedCount) - burnedCount; // charms until the next token
  const noteLine = sacrificeNote ? `<div class="ach-sacrifice-note">${escapeHtml(sacrificeNote)}</div>` : ``;
  sacrificeNote = "";   // one-shot
  const convoLine = noteLine + `<div class="ach-page-tickets">` +
    (burnedCount ? `🎟 charms given up: ${burnedCount} · ` : ``) +
    (tradeableLeft
      ? `next challenge token after ${needNext} more sacrifice${needNext === 1 ? "" : "s"} ` +
        `<span class="ach-trade-note">(the price doubles each time, and a given-up charm is gone for good)</span>`
      : `earn a visible skill charm to sacrifice it for challenge tokens`) +
    `</div>`;
  let html = `<div class="ach-page-head"><div class="ach-page-title">Charm Collection</div>` +
    `<div class="ach-page-sub">${earnedCount} / ${total} charms collected</div>` +
    convoLine +
    `</div>`;

  // by-theme breakdown — one small colour-coded bar per group (denominators count
  // every charm in the theme, secret ones included, so the five sum to the total).
  const themeRows = ACH_GROUPS.map((g) => {
    const members = ACHIEVEMENTS.filter((a) => achGroupOf(a.id) === g.id);
    const got = members.filter((a) => earnedAchievements[a.id]).length;
    const tot = members.length;
    const col = ACH_GROUP_COLORS[g.id];
    return `<div class="ach-theme">` +
      `<div class="ach-theme-head"><span class="ach-theme-name"><span class="ach-group-dot" style="background:${col}"></span>${g.short}</span><span>${got} / ${tot}</span></div>` +
      `<div class="ach-theme-bar"><div style="width:${tot ? (got / tot) * 100 : 0}%;background:${col}"></div></div>` +
      `</div>`;
  }).join("");
  html += `<div class="ach-themes"><div class="ach-themes-label">by theme</div>` +
    `<div class="ach-themes-grid">${themeRows}</div></div>`;

  const meter = `<div class="cat-meter">` +
    `<div class="cat-meter-head"><span>charms collected</span><span>${pct}%</span></div>` +
    `<div class="cat-meter-num"><b>${earnedCount}</b> / ${total}</div>` +
    `<div class="cat-bar"><div class="cat-seg" style="width:${(earnedCount / total) * 100}%;background:var(--ink-accent)"></div></div>` +
    `</div>`;

  // newest charm as a proper keepsake — its real icon, the name (wraps), and the date.
  const latest = earnedAsc[earnedAsc.length - 1];
  const latestCard = latest ? `<div class="ach-latest">` +
    `<span class="ach-latest-charm">${charmMarkup(latest.icon)}</span>` +
    `<div class="ach-latest-text"><div class="ach-latest-label">your newest charm</div>` +
    `<div class="ach-latest-name">${escapeHtml(latest.name)}</div>` +
    `<div class="ach-latest-meta">${escapeHtml(latest.desc)} · ${recordDateLabel(earnedAchievements[latest.id])}</div></div>` +
    `</div>` :
    `<div class="ach-latest ach-latest--empty"><div class="ach-latest-text">` +
    `<div class="ach-latest-label">your newest charm</div>` +
    `<div class="ach-latest-meta">no charms yet — finish a game to earn your first</div></div></div>`;

  html += `<div class="ach-head-row">${meter}${latestCard}</div>`;

  // "The long game" — the catalogue-completion charm ("I Hate It Here") gets a pinned
  // quest card above the grid: live song-completion progress (the album-rainbow bar) and
  // a door into the songbook. It's the only charm with a browsable collection behind it,
  // so it's promoted out of its theme grid (it still counts toward Catalogue below).
  html += questCardHTML();

  // themed sections: earned (revealed, newest first) then visible locked targets.
  // Still-locked secrets are held back for the trailing Secret section.
  ACH_GROUPS.forEach((g) => {
    const members = ACHIEVEMENTS.filter((a) =>
      achGroupOf(a.id) === g.id && (earnedAchievements[a.id] || !a.secret));
    if (!members.length) return;
    const earnedM = members.filter((a) => earnedAchievements[a.id])
      .sort((x, y) => (earnedAchievements[y.id] || "").localeCompare(earnedAchievements[x.id] || ""));
    const lockedM = members.filter((a) => !earnedAchievements[a.id]);
    const tiles = [...earnedM, ...lockedM].map(achTile).join("");
    html += `<p class="histogram-label ach-section"><span class="ach-group-dot" style="background:${ACH_GROUP_COLORS[g.id]}"></span>${g.label}</p>` +
      `<div class="ach-grid">${tiles}</div>`;
  });

  const secretLocked = ACHIEVEMENTS.filter((a) => a.secret && !earnedAchievements[a.id]);
  if (secretLocked.length) {
    html += `<p class="histogram-label ach-section"><span class="ach-group-dot ach-group-dot--secret"></span>Secret charms · ${secretLocked.length}</p>` +
      `<div class="ach-grid">${secretLocked.map(achTile).join("")}</div>`;
  }

  $("achievementsBody").innerHTML = html;
  $("achievementsBody").querySelectorAll("[data-open-songbook]").forEach((b) =>
    b.addEventListener("click", () => openSongbook(b.dataset.openSongbook)));
  $("achievementsBody").querySelectorAll("[data-sacrifice]").forEach((b) =>
    b.addEventListener("click", () => onSacrificeClick(b.dataset.sacrifice)));
}

// Two-tap to confirm a permanent sacrifice (mirrors the quit button). First tap arms the
// charm (3s auto-disarm); second tap on the same charm burns it.
function onSacrificeClick(id) {
  if (armedSacrifice === id) {
    clearTimeout(armSacrificeTimer);
    armedSacrifice = null;
    const res = sacrificeAchievement(id);
    if (res) sacrificeNote = res.minted
      ? `a challenge token earned 🎟 — spend it on the Challenges page`
      : `charm given up — one more sacrifice earns the next token`;
    renderAchievementsPage();
    return;
  }
  clearTimeout(armSacrificeTimer);
  armedSacrifice = id;
  armSacrificeTimer = setTimeout(() => { armedSacrifice = null; renderAchievementsPage(); }, 3000);
  renderAchievementsPage();
}

// Shared album-rainbow segments for a {album: discoveredCount} split out of total.
// Drawn in the order albums first appear in allSongs (the catalogue rainbow).
function albumRainbowSegs(byAlbum, total) {
  const order = [];
  for (const s of allSongs) if (s.album && !order.includes(s.album)) order.push(s.album);
  return order.filter((a) => byAlbum[a]).map((a) =>
    `<div class="cat-seg" style="width:${(byAlbum[a] / total) * 100}%;background:${albumColor(a) || "var(--ink-soft)"}" title="${escapeHtml(a)}: ${byAlbum[a]}"></div>`
  ).join("");
}

// The pinned catalogue-completion quest card on the Charm Collection page.
function questCardHTML() {
  const a = ACH_BY_ID["i-hate-it-here"];
  if (!a) return "";
  const found = (loadSongTally().songs) || {};
  const total = allSongs.length || 1;
  const discovered = allSongs.filter((s) => found[s.title]).length;
  const done = discovered >= total;
  const byAlbum = {};
  for (const s of allSongs) if (found[s.title] && s.album) byAlbum[s.album] = (byAlbum[s.album] || 0) + 1;
  const note = done ? "every song found ★" : (total - discovered) + " still hiding from you";
  return `<button type="button" class="ach-quest${done ? " done" : ""}" data-open-songbook="achievements">
    <div class="ach-quest-main">
      <div class="ach-quest-eyebrow">the long game · catalogue</div>
      <div class="ach-quest-name">${escapeHtml(a.name)}</div>
      <div class="ach-quest-desc">${escapeHtml(a.desc)}</div>
      <div class="ach-quest-meterhead"><span>songs named</span><span><b>${discovered}</b> / ${total}</span></div>
      <div class="cat-bar ach-quest-bar">${albumRainbowSegs(byAlbum, total)}</div>
      <div class="ach-quest-foot">
        <span class="ach-quest-note">${note}</span>
        <span class="ach-quest-cta">see what's missing <span aria-hidden="true">→</span></span>
      </div>
    </div>
    <div class="ach-quest-aside">
      <span class="ach-quest-charm${done ? " earned" : ""}">${charmMarkup(a.icon)}</span>
      <span class="ach-quest-state">${done ? "earned" : "locked"}</span>
    </div>
  </button>`;
}

/* ---------- Songbook — the missing-songs checklist (backs "I Hate It Here") ---------- */
let songbookBackTarget = "stats";  // where the Songbook's ← back returns to
function openSongbook(from) {
  songbookBackTarget = from;
  renderSongbook();
  flipAwayToScreen("songbook");
}
// A full per-album checklist of the catalogue: which songs you've named (gold star) and
// which are still missing (hollow). Reads the lifetime tally, so it spans every mode.
function renderSongbook() {
  const found = (loadSongTally().songs) || {};
  const total = allSongs.length || 1;
  const discovered = allSongs.filter((s) => found[s.title]).length;
  const remaining = total - discovered;
  const complete = remaining <= 0;
  const pct = Math.floor((discovered / total) * 100);

  const byAlbum = {};
  for (const s of allSongs) if (found[s.title] && s.album) byAlbum[s.album] = (byAlbum[s.album] || 0) + 1;

  const sub = complete
    ? "every song found — the whole catalogue, by heart ★"
    : remaining + " song" + (remaining === 1 ? "" : "s") + " still hiding from you";

  let html = `<div class="sb-meter${complete ? " done" : ""}">
      <div class="cat-meter-head"><span>songs named correctly</span><span>${pct}%</span></div>
      <div class="cat-meter-num"><b>${discovered}</b> / ${total} songs</div>
      <div class="cat-bar">${albumRainbowSegs(byAlbum, total)}</div>
      <div class="sb-sub">${sub}</div>
    </div>`;

  // Album order = first appearance in allSongs (the catalogue order).
  const order = [];
  for (const s of allSongs) if (s.album && !order.includes(s.album)) order.push(s.album);
  html += order.map((album) => {
    const songs = allSongs.filter((s) => s.album === album);
    const got = songs.filter((s) => found[s.title]).length;
    const albDone = got === songs.length;
    const col = albumColor(album) || "var(--ink-soft)";
    const items = songs.map((s) => {
      const has = !!found[s.title];
      return `<li class="sb-song${has ? " got" : ""}">` +
        (has ? `<span class="sb-tick">${STAR_SVG}</span>` : `<span class="sb-hollow" aria-hidden="true"></span>`) +
        `<span class="sb-title">${escapeHtml(censor(s.title))}</span></li>`;
    }).join("");
    return `<section class="sb-album${albDone ? " done" : ""}">
      <div class="sb-album-head">
        <span class="sb-spine" style="background:${col}"></span>
        <span class="sb-album-name">${escapeHtml(album)}</span>
        <span class="sb-album-count">${albDone ? `<span class="sb-done-tag">all found ✓</span>` : got + " / " + songs.length}</span>
      </div>
      <ul class="sb-list">${items}</ul>
    </section>`;
  }).join("");

  $("songbookBody").innerHTML = html;
}

/* ---------- Personal records (your own best runs, per mode) ---------- */
function recordDateLabel(date) {
  // Accepts both legacy date-only ("YYYY-MM-DD") and full ISO timestamps.
  return date
    ? new Date(date.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
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
  if (token && token.startsWith("chl-")) {
    const c = CHALLENGE_BY_ID[token.slice(4)];
    return c ? "Challenge · " + c.name : "Challenge";
  }
  if (token && token.startsWith("af-")) return "Album · " + token.slice(3);
  if (token === "adaptive") return "Adaptive";
  if (token && token.startsWith("inf-")) {
    const parts = token.split("-");   // ["inf", variant, mode]
    return (VARIANT_LABELS[parts[1]] || parts[1]) + " · " + (MODES[parts[2]] ? MODES[parts[2]].label : parts[2]);
  }
  return MODES[token] ? MODES[token].label : (token || "—");
}
const isInfiniteToken = (token) => !!token && token.startsWith("inf-");
const isAdaptiveToken = (token) => token === "adaptive";
// Compact "your best" line for a single mode (start screen + results). Shows the
// mode's top personal record, or a target line if you've never finished a run in it.
function renderBestLine(el, mode) {
  let rec = loadRecords(mode)[0];
  if (!rec && !isInfiniteToken(mode) && MODES[mode]) {
    const best = loadStats(mode).best;
    if (best > 0) rec = { score: best, date: null };
  }
  if (!rec) {
    el.innerHTML = `<div class="best-empty">no runs yet — set your first record <span class="best-empty-star">${STAR_SVG}</span></div>`;
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
// Accent colour for a record tile — classic mode, infinite token (borrows its
// difficulty), or daily (the red margin rule).
function modeAccent(token) {
  if (token === "daily") return "#b23a3a";
  const base = isInfiniteToken(token) ? token.split("-")[2] : token;
  return MODE_COLORS[base] || "var(--ink-accent)";
}
function pbTile(mode, opts = {}) {
  const rec = opts.score != null ? { score: opts.score, date: null } : loadRecords(mode)[0];
  const empty = !rec || rec.score == null;
  const isInf = isInfiniteToken(mode);
  const unit = isInf ? "" : "/" + TOTAL_ROUNDS;
  // Infinite tiles split the label into a small variant kicker + the difficulty;
  // the sudden-death variant gets a distinct tape tint so the two read apart.
  let kicker = "", label = opts.label || modeLabel(mode), sudden = false;
  if (isInf) {
    const parts = mode.split("-");                 // ["inf", variant, modeid]
    kicker = VARIANT_LABELS[parts[1]] || parts[1];
    label = MODES[parts[2]] ? MODES[parts[2]].label : parts[2];
    sudden = parts[1] === "sudden";
  }
  let sub = opts.sub;
  if (!sub) {
    if (!rec) sub = "no runs yet";
    else {
      const parts = [];
      if (isInf) parts.push("rounds");
      if (rec.time != null) parts.push(fmtTime(rec.time));
      if (rec.date) parts.push(recordDateLabel(rec.date));
      sub = parts.length ? parts.join(" · ") : "—";
    }
  }
  const cls = "pb-tile" + (empty ? " pb-empty" : "") + (isInf ? " pb-inf" : "") +
    (sudden ? " pb-sudden" : "") + (mode === "daily" ? " pb-daily" : "");
  return `<div class="${cls}" style="--pb-accent:${modeAccent(mode)}">` +
    (kicker ? `<span class="pb-kicker">${escapeHtml(kicker)}</span>` : "") +
    `<span class="pb-mode">${escapeHtml(label)}</span>` +
    `<span class="pb-score">${empty ? "—" : rec.score + (unit ? `<span class="pb-unit">${unit}</span>` : "")}</span>` +
    `<span class="pb-sub">${escapeHtml(sub)}</span></div>`;
}
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
    const adaptive = isAdaptiveToken(h.m);
    const unit = (isInfiniteToken(h.m) || adaptive) ? "" : "/" + TOTAL_ROUNDS;
    const scoreText = adaptive ? `<span class="lvl-prefix">L</span>${h.s}` : "" + h.s;
    const isPB = h.s > 0 && h.s === _pbByMode[h.m];
    return `<div class="hist-row${isPB ? " hist-pb" : ""}">` +
      `<span class="hist-score">${isPB ? `<span class="hist-crown" aria-hidden="true">${ACH_ICONS.crown}</span>` : ""}${scoreText}${unit ? `<span class="hist-unit">${unit}</span>` : ""}</span>` +
      `<span class="hist-time">${h.tm != null ? fmtTime(h.tm) : "—"}</span>` +
      `<span class="hist-verse">${h.v > 0 ? `<span class="hist-verse-star" aria-hidden="true">★</span>+${h.v}` : "—"}</span>` +
      `<span class="hist-mode">${escapeHtml(modeLabel(h.m))}</span>` +
      `<span class="hist-date">${histDateLabel(h.d)}</span></div>`;
  }).join(""));
  historyShown += next.length;
  const more = $("histMore");
  if (more && historyShown >= hist.length) more.style.display = "none";
}

/* ---------- Records calendar heatmap (games played per day / per hour) ----------
   A GitHub-style contribution grid. Data comes entirely from the run history log —
   each entry's ISO datetime, bucketed by the player's active timezone so squares land
   on their local calendar day/hour (consistent with the daily challenge). Gold "ink
   density" = games played: faint = none, deepening to solid for a heavy day. The grid
   fills the full content width (JS sizes the cells from the measured width so they stay
   square and the day labels line up exactly with the rows). */
const HEAT_GAP = 3;                          // px gap between squares
const HEAT_FILL = ["rgba(43,39,34,0.09)", "rgba(200,149,31,0.30)", "rgba(200,149,31,0.56)", "rgba(200,149,31,0.80)", "#a9791f"];
const MON_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WD_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];   // indexed by getUTCDay
const HEAT_HOURS = { 0: "12a", 6: "6a", 12: "12p", 18: "6p", 23: "11p" };
let _heatView = null;            // "y1" | "ytd" | "m1" | "wk"; null until the adaptive default is picked
let _heatResizeWired = false;    // window-resize listener attached once

// An ISO datetime → the player's local calendar-day key / hour, in the active zone.
function localDayKeyOf(iso) {
  try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: activeTimeZone() }); }
  catch (e) { return String(iso).slice(0, 10); }
}
function localHourOf(iso) {
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: activeTimeZone(), hour12: false, hour: "2-digit" }).formatToParts(new Date(iso));
    return (+(p.find((x) => x.type === "hour")?.value) || 0) % 24;
  } catch (e) { return new Date(iso).getHours(); }
}
// Pure date-string math on a UTC anchor — stable, no zone drift (keys are "YYYY-MM-DD").
function keyPlus(key, n) { const d = new Date(key + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function keyMinus(key, n) { return keyPlus(key, -n); }
function keyDiff(a, b) { return Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 864e5); }
function keyDow(key) { return new Date(key + "T00:00:00Z").getUTCDay(); }      // 0=Sun..6=Sat
function keyMonth(key) { return new Date(key + "T00:00:00Z").getUTCMonth(); }
function heatPrettyDate(key) {
  try { return new Date(key + "T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }); }
  catch (e) { return key; }
}
function hourLabel(h) { const ap = h < 12 ? "am" : "pm"; let hr = h % 12; if (hr === 0) hr = 12; return hr + ap; }

// Mon-start (default) puts Monday on row 0; Sun-start puts Sunday on row 0.
function heatRow(key) { const d = keyDow(key); return settings.weekStart === "sun" ? d : (d + 6) % 7; }
function dowLabels() { return settings.weekStart === "sun" ? ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] : ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]; }
// Games played per local day, across the whole history log.
function heatDayCounts() {
  const m = Object.create(null);
  for (const h of loadHistory()) { const k = localDayKeyOf(h.d); m[k] = (m[k] || 0) + 1; }
  return m;
}
function heatLevel(c, max) { if (c <= 0) return 0; if (max <= 4) return Math.min(4, c); return Math.min(4, Math.ceil(c / (max / 4))); }
// >1 month of history → default to the year; otherwise the compact 30-day view.
function heatDefaultView() {
  const hist = loadHistory();
  if (!hist.length) return "m1";
  return keyDiff(todayKey(), localDayKeyOf(hist[hist.length - 1].d)) > 30 ? "y1" : "m1";
}

function heatSectionHTML() {
  const opts = [["y1", "last 12 months"], ["ytd", todayKey().slice(0, 4)], ["m1", "last 30 days"], ["wk", "last 7 days · by hour"]];
  const optHTML = opts.map(([v, l]) => `<option value="${v}"${v === _heatView ? " selected" : ""}>${escapeHtml(l)}</option>`).join("");
  const legend = [0, 1, 2, 3, 4].map((l) => `<i style="background:${HEAT_FILL[l]}"></i>`).join("");
  return `<p class="rec-group-label">calendar — games played</p>` +
    `<div class="heat-wrap">` +
      `<div class="heat-controls">` +
        `<select id="heatRange" class="heat-select" aria-label="calendar timeframe">${optHTML}</select>` +
        `<div class="heat-legend"><span>less</span>${legend}<span>more</span></div>` +
      `</div>` +
      `<div id="heatBody"></div>` +
      `<div id="heatFoot" class="heat-foot"></div>` +
    `</div>`;
}

function setHeatFoot(view, total, days) {
  const f = $("heatFoot"); if (!f) return;
  const g = (n) => `${n} game${n === 1 ? "" : "s"}`;
  let msg;
  if (total === 0) msg = view === "m1" ? `no games yet this month — <b>play to start filling your calendar</b>` : `nothing logged here yet — <b>play a round to begin</b>`;
  else if (view === "y1") msg = `<b>${g(total)}</b> across <b>${days} day${days === 1 ? "" : "s"}</b> — darker means more games`;
  else if (view === "ytd") msg = `<b>${g(total)}</b> so far in ${todayKey().slice(0, 4)}`;
  else msg = `<b>${g(total)}</b> over the last 30 days`;
  f.innerHTML = msg;
}

function renderDailyHeat(body, view) {
  const today = todayKey();
  const counts = heatDayCounts();
  let rangeStart;
  if (view === "y1") rangeStart = keyMinus(today, 364);
  else rangeStart = today.slice(0, 4) + "-01-01";                       // ytd: counts up from 1 Jan
  const gridStart = keyMinus(rangeStart, heatRow(rangeStart));          // back up to the week-start boundary
  const weeks = Math.floor(keyDiff(today, gridStart) / 7) + 1;

  let max = 0, total = 0, daysPlayed = 0;
  for (let w = 0; w < weeks; w++) for (let r = 0; r < 7; r++) {
    const key = keyPlus(gridStart, w * 7 + r);
    if (keyDiff(today, key) < 0 || keyDiff(key, rangeStart) < 0) continue;   // future / before range
    const c = counts[key] || 0;
    if (c > max) max = c;
    if (c > 0) { total += c; daysPlayed++; }
  }

  const cells = [], months = []; let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const topKey = keyPlus(gridStart, w * 7);
    const repKey = keyDiff(topKey, rangeStart) < 0 ? rangeStart : topKey;     // don't label a pre-range month
    const m = keyMonth(repKey);
    if (m !== lastMonth) { months.push(`<span style="left:${(w / weeks * 100).toFixed(3)}%">${MON_ABBR[m]}</span>`); lastMonth = m; }
    for (let r = 0; r < 7; r++) {
      const key = keyPlus(gridStart, w * 7 + r);
      if (keyDiff(today, key) < 0 || keyDiff(key, rangeStart) < 0) { cells.push(`<div class="heat-cell" style="background:transparent"></div>`); continue; }
      const c = counts[key] || 0;
      cells.push(`<div class="heat-cell" title="${c} game${c === 1 ? "" : "s"} · ${heatPrettyDate(key)}" style="background:${HEAT_FILL[heatLevel(c, max)]};border:0.5px solid rgba(43,39,34,0.10)"></div>`);
    }
  }

  const labels = dowLabels();
  const dayLabelHTML = [0, 2, 4].map((r) => `<span style="grid-row:${r + 1}">${labels[r]}</span>`).join("");
  const prov = 11;                                                       // provisional cell px until fitHeatGrid measures
  body.innerHTML =
    `<div class="heat-row">` +
      `<div class="heat-side"><div class="heat-corner" style="height:15px"></div>` +
        `<div class="heat-days" id="heatDays" style="grid-template-rows:repeat(7,${prov}px)">${dayLabelHTML}</div></div>` +
      `<div class="heat-main">` +
        `<div class="heat-months" style="height:15px">${months.join("")}</div>` +
        `<div class="heat-grid" id="heatGrid" data-view="${view}" data-weeks="${weeks}" style="grid-auto-flow:column;grid-template-columns:repeat(${weeks},1fr);grid-template-rows:repeat(7,${prov}px)">${cells.join("")}</div>` +
      `</div>` +
    `</div>`;
  setHeatFoot(view, total, daysPlayed);
  fitHeatGrid();
}

// The 30-day view renders as a single full-width strip (one row of 30 days, today on the
// right) rather than a 7×5 calendar block — 5 calendar columns capped to square cells left a
// lot of empty space on the right. Month markers ride the top where the month changes; the
// weekday axis is dropped (thin at this range). fitHeatGrid sizes the row to keep cells square.
function renderMonthStrip(body) {
  const today = todayKey();
  const counts = heatDayCounts();
  const DAYS = 30;
  const start = keyMinus(today, DAYS - 1);
  let max = 0, total = 0, daysPlayed = 0;
  for (let i = 0; i < DAYS; i++) {
    const c = counts[keyPlus(start, i)] || 0;
    if (c > max) max = c;
    if (c > 0) { total += c; daysPlayed++; }
  }
  const months = [], cells = []; let lastMonth = -1;
  for (let i = 0; i < DAYS; i++) {
    const key = keyPlus(start, i);
    const m = keyMonth(key);
    if (m !== lastMonth) { months.push(`<span style="left:${(i / DAYS * 100).toFixed(3)}%">${MON_ABBR[m]}</span>`); lastMonth = m; }
    const c = counts[key] || 0;
    cells.push(`<div class="heat-cell" title="${c} game${c === 1 ? "" : "s"} · ${heatPrettyDate(key)}" style="background:${HEAT_FILL[heatLevel(c, max)]};border:0.5px solid rgba(43,39,34,0.10)"></div>`);
  }
  body.innerHTML =
    `<div class="heat-strip">` +
      `<div class="heat-months" style="height:15px">${months.join("")}</div>` +
      `<div class="heat-grid" id="heatGrid" data-view="m1" data-strip="1" data-days="${DAYS}" style="grid-auto-flow:column;grid-template-columns:repeat(${DAYS},1fr);grid-template-rows:11px">${cells.join("")}</div>` +
      `<div class="heat-strip-ends"><span>${heatPrettyDate(start)}</span><span>today</span></div>` +
    `</div>`;
  setHeatFoot("m1", total, daysPlayed);
  fitHeatGrid();
}

function renderWeekHeat(body) {
  const today = todayKey();
  const nowHour = localHourOf(new Date().toISOString());
  const counts = Object.create(null);
  for (const h of loadHistory()) {
    const dk = localDayKeyOf(h.d);
    if (keyDiff(today, dk) > 6 || keyDiff(today, dk) < 0) continue;     // outside the rolling 7-day window
    const k = dk + "|" + localHourOf(h.d); counts[k] = (counts[k] || 0) + 1;
  }
  let max = 0, total = 0;
  for (let d = 0; d < 7; d++) { const dk = keyMinus(today, 6 - d); for (let h = 0; h < 24; h++) { if (dk === today && h > nowHour) continue; const c = counts[dk + "|" + h] || 0; if (c > max) max = c; total += c; } }

  const colLabels = [];
  for (let d = 0; d < 7; d++) colLabels.push(`<span>${WD_ABBR[keyDow(keyMinus(today, 6 - d))]}</span>`);
  const hourLabelHTML = [0, 6, 12, 18, 23].map((h) => `<span style="grid-row:${h + 1}">${HEAT_HOURS[h]}</span>`).join("");
  const cells = [];
  for (let d = 0; d < 7; d++) {
    const dk = keyMinus(today, 6 - d);
    for (let h = 0; h < 24; h++) {
      if (dk === today && h > nowHour) { cells.push(`<div class="heat-cell" style="background:transparent"></div>`); continue; }
      const c = counts[dk + "|" + h] || 0;
      cells.push(`<div class="heat-cell" title="${c} game${c === 1 ? "" : "s"} · ${heatPrettyDate(dk)} ${hourLabel(h)}" style="background:${HEAT_FILL[heatLevel(c, max)]};border:0.5px solid rgba(43,39,34,0.10)"></div>`);
    }
  }
  const CH = 12;
  body.innerHTML =
    `<div class="heat-row">` +
      `<div class="heat-side"><div class="heat-corner" style="height:16px"></div>` +
        `<div class="heat-hours" style="grid-template-rows:repeat(24,${CH}px);gap:${HEAT_GAP}px">${hourLabelHTML}</div></div>` +
      `<div class="heat-main">` +
        `<div class="heat-cols" style="grid-template-columns:repeat(7,1fr);gap:${HEAT_GAP}px;height:16px">${colLabels.join("")}</div>` +
        `<div class="heat-grid" id="heatGrid" data-view="wk" style="grid-auto-flow:column;grid-template-columns:repeat(7,1fr);grid-template-rows:repeat(24,${CH}px);gap:${HEAT_GAP}px">${cells.join("")}</div>` +
      `</div>` +
    `</div>`;
  const f = $("heatFoot");
  if (f) f.innerHTML = total ? `<b>${total} game${total === 1 ? "" : "s"}</b> in the last 7 days — busiest hours are darkest` : `nothing in the last 7 days — <b>play to light up your week</b>`;
}

function renderHeatBody() {
  const body = $("heatBody"); if (!body) return;
  if (_heatView === "wk") renderWeekHeat(body);
  else if (_heatView === "m1") renderMonthStrip(body);
  else renderDailyHeat(body, _heatView);
  const sel = $("heatRange"); if (sel) sel.value = _heatView;
}
// Size the daily grid to the full content width: square cells + matching day-label rows.
// Dense ranges (12 months, year) fill the width with small cells. The 30-day view is a single
// full-width strip (data-strip) — its one row is sized square from the column width. Any range
// wide enough to exceed HEAT_CELL_MAX is capped+left-aligned so squares don't balloon. The
// month-label strip is pinned to the grid's actual width either way so labels stay aligned.
// Retries on rAF while the width reads 0 (the records screen is hidden during the initial
// render, so the first measurement after showScreen can still be mid-layout).
const HEAT_CELL_MAX = 30;   // sparse ranges cap here (left-aligned)
const HEAT_CELL_MIN = 6;    // dense ranges on a narrow screen floor here (row scrolls)
function fitHeatGrid(retries = 10) {
  const grid = $("heatGrid"); if (!grid || grid.dataset.view === "wk") return;
  const w = grid.clientWidth;
  if (!w) { if (retries > 0) requestAnimationFrame(() => fitHeatGrid(retries - 1)); return; }
  if (grid.dataset.strip) {                                            // 30-day strip: square the single row to the 1fr column width
    const days = +grid.dataset.days || 30;
    grid.style.gridTemplateRows = `${(w - (days - 1) * HEAT_GAP) / days}px`;
    return;
  }
  const weeks = +grid.dataset.weeks || 1;
  const full = (w - (weeks - 1) * HEAT_GAP) / weeks;
  // Three regimes: cap big (sparse → left-aligned), floor small (dense+narrow → fixed px, the
  // row scrolls), else fill the width exactly with 1fr columns. Fixed-width keeps cells square.
  let cell, fixed;
  if (full > HEAT_CELL_MAX) { cell = HEAT_CELL_MAX; fixed = true; }
  else if (full < HEAT_CELL_MIN) { cell = HEAT_CELL_MIN; fixed = true; }
  else { cell = full; fixed = false; }
  grid.style.gridTemplateColumns = fixed ? `repeat(${weeks},${cell}px)` : `repeat(${weeks},1fr)`;
  grid.style.gridTemplateRows = `repeat(7,${cell}px)`;
  const days = $("heatDays"); if (days) days.style.gridTemplateRows = `repeat(7,${cell}px)`;
  const months = grid.parentElement.querySelector(".heat-months");
  if (months) months.style.width = fixed ? `${weeks * cell + (weeks - 1) * HEAT_GAP}px` : "";
}

/* ---------- Profile polaroid (a photo tucked into the notebook) ---------- */
const POL_CAMERA_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h3l1.4-2h5.2L16 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.2"/></svg>`;
const POL_CLIP_SVG = `<svg class="pol-clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 7.5l-6.8 6.8a2.4 2.4 0 0 0 3.4 3.4l7.1-7.1a4 4 0 0 0-5.66-5.66l-7.1 7.1"/></svg>`;

// One polaroid — a photo (data-URL) clipped to the page, or the empty
// "add a photo" slot when `photo` is "". `caption` rides the white lip;
// `tilt`/`small` tune the look. The washi tape colour is era-tinted in CSS.
function polaroidHTML(photo, caption, opts = {}) {
  const tilt = opts.tilt != null ? opts.tilt : -4;
  const cls = "polaroid" + (photo ? "" : " is-empty") + (opts.small ? " polaroid-sm" : "");
  const cap = (caption || "").trim();
  if (photo) {
    return `<span class="${cls}" style="--tilt:${tilt}deg">` +
      `<span class="pol-tape" aria-hidden="true"></span>` +
      `<span class="pol-photo" style="background-image:url('${photo}')"></span>` +
      `<span class="pol-lip">${escapeHtml(cap)}</span></span>`;
  }
  return `<span class="${cls}" style="--tilt:${tilt}deg">${POL_CLIP_SVG}` +
    `<span class="pol-photo pol-add">${POL_CAMERA_SVG}</span>` +
    `<span class="pol-lip">add a photo</span></span>`;
}

// Read a chosen image file, center-crop it to a square and downscale it to a
// small JPEG data-URL (~kBs) so it sits comfortably in localStorage. No crop UI.
const AVATAR_SIZE = 240;
// `cb(url)` on success; `done()` always fires (success or failure) so the caller
// can tear down the file input only after the read finishes.
function processAvatarFile(file, cb, done) {
  const finish = () => { if (done) done(); };
  const fail = (msg) => { console.warn("avatar:", msg); notifyNote("couldn’t add that photo", "try a JPG or PNG image"); finish(); };
  if (!file) return fail("no file");
  // Don't hard-gate on file.type — Safari/iCloud sometimes report "" for a real
  // image. The picker's accept="image/*" already filters; let decode be the judge.
  if (file.type && !/^image\//.test(file.type)) return fail("not an image (" + file.type + ")");
  const reader = new FileReader();
  reader.onerror = () => fail("could not read the file");
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => fail("could not decode the image");
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      if (!side) return fail("image has no dimensions");
      const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
      const c = document.createElement("canvas");
      c.width = c.height = AVATAR_SIZE;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      let url;
      try { url = c.toDataURL("image/jpeg", 0.82); } catch (e) { return fail("encode failed: " + e); }
      cb(url);
      finish();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// Pop the native file picker, process the pick, hand the data-URL back.
// WebKit gotchas this avoids: a `display:none` (or fully off-screen) file input
// may not fire `change`, and removing the input before the async read finishes
// can invalidate the File. So the input is kept rendered (visually-hidden but
// in-viewport) and only removed once reading is done.
function chooseAvatar(cb) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  inp.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(inp);
  let picked = false;
  const cleanup = () => { if (inp.parentNode) inp.remove(); };
  inp.addEventListener("change", () => {
    picked = true;
    const f = inp.files && inp.files[0];
    if (!f) { cleanup(); return; }
    processAvatarFile(f, cb, cleanup);
  });
  // If the dialog is cancelled, no `change` fires — tidy up once focus returns.
  window.addEventListener("focus", () => setTimeout(() => { if (!picked) cleanup(); }, 500), { once: true });
  inp.click();
}

// Persist a new (or cleared) photo and refresh wherever it shows.
function applyAvatar(url) {
  settings.avatar = setAvatar(url);
  if (screens.records.classList.contains("active")) renderRecordsPage();
  if ($("settingsModal").classList.contains("open")) renderSettingsBody();
}

function renderRecordsPage() {
  if (_heatView === null) _heatView = heatDefaultView();
  const name = getPlayerName();
  const avatar = getAvatar();
  const sigText = name
    ? `<span class="rec-sig-name">${escapeHtml(name)}’s notebook</span><span class="rec-sig-sub">best scores &amp; history</span>`
    : `<div class="rec-sign-row"><input id="recSignInput" class="set-text" maxlength="20" placeholder="sign your notebook" /><button id="recSignSave" class="btn-ghost">sign</button></div>`;
  const sig =
    `<button type="button" id="recPolBtn" class="rec-pol-btn" aria-label="${avatar ? "change your photo" : "add a photo"}">${polaroidHTML(avatar, name)}</button>` +
    `<div class="rec-sig-text">${sigText}</div>`;

  // Personal bests — classic difficulties always shown; infinite/daily only if played.
  const classicTiles = MODE_ORDER.map((m) => pbTile(m)).join("");
  const infTokens = [];
  for (const v of ["3lives", "sudden"]) for (const m of MODE_ORDER) {
    const tok = "inf-" + v + "-" + m;
    if (loadRecords(tok).length) infTokens.push(tok);
  }
  const infBlock = infTokens.length
    ? `<p class="rec-group-label">infinite — rounds survived</p><div class="pb-grid pb-grid-inf">${infTokens.map((t) => pbTile(t)).join("")}</div>`
    : "";
  const db = dailyBest();
  const streak = effectiveDailyStreak(todayKey());
  const dailyBlock = (db > 0 || streak.best > 0)
    ? `<p class="rec-group-label">daily</p><div class="pb-grid">` +
        pbTile("daily", { label: "Daily best", score: db, sub: `🔥 ${streak.current} day streak · best ${streak.best}` }) +
      `</div>`
    : "";

  // Verse bonus — the prestige metric's lifetime keepsake (best run + word-perfect totals).
  const vm = loadMetrics();
  const verseBlock = vm.bestVerseBonus > 0
    ? `<p class="rec-group-label">verse bonus</p><div class="pb-grid">` +
        `<div class="pb-tile pb-verse" style="--pb-accent:var(--bead)">` +
          `<span class="pb-mode">Best in a game</span>` +
          `<span class="pb-score">+${vm.bestVerseBonus}</span>` +
          `<span class="pb-sub">${vm.versePerfect} word-perfect · ${vm.wholeVerses} whole verse${vm.wholeVerses === 1 ? "" : "s"}</span>` +
        `</div></div>`
    : "";

  const hist = loadHistory();
  _pbByMode = {};
  for (const h of hist) if (!(h.m in _pbByMode)) _pbByMode[h.m] = h.m === "daily" ? db : h.m === "adaptive" ? (adaptiveRecord().bestPeak || -1) : (loadRecords(h.m)[0] ? loadRecords(h.m)[0].score : -1);
  const histBlock = hist.length
    ? `<p class="rec-group-label">history — ${hist.length} run${hist.length === 1 ? "" : "s"}</p>` +
      `<div class="hist-head"><span>score</span><span>time</span><span>verse</span><span>mode</span><span>date</span></div>` +
      `<div id="histRows" class="hist-rows"></div>` +
      (hist.length > HISTORY_PAGE ? `<button id="histMore" class="btn-ghost">load more</button>` : "")
    : `<p class="rec-group-label">history</p><p class="stats-empty">no runs yet — finish a game to start your log.</p>`;

  $("recordsBody").innerHTML =
    `<div class="rec-sig">${sig}</div>` +
    `<p class="rec-group-label">personal bests</p><div class="pb-grid">${classicTiles}</div>` +
    infBlock + dailyBlock + verseBlock + heatSectionHTML() + histBlock;

  renderHeatBody();
  const heatSel = $("heatRange");
  if (heatSel) heatSel.addEventListener("change", () => { _heatView = heatSel.value; renderHeatBody(); });
  if (!_heatResizeWired) { _heatResizeWired = true; window.addEventListener("resize", () => { if ($("heatGrid")) fitHeatGrid(); }); }

  const saveBtn = $("recSignSave");
  if (saveBtn) saveBtn.addEventListener("click", () => {
    const v = ($("recSignInput").value || "").trim().slice(0, 20);
    if (v) { settings.playerName = setPlayerName(v); checkPianoEgg(v); refreshStartBoard(); renderRecordsPage(); }
  });
  const signInput = $("recSignInput");
  if (signInput) signInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveBtn.click(); });

  const polBtn = $("recPolBtn");
  if (polBtn) polBtn.addEventListener("click", () => chooseAvatar((url) => applyAvatar(url)));

  historyShown = 0;
  if (hist.length) appendHistoryRows(hist);
  const more = $("histMore");
  if (more) more.addEventListener("click", () => appendHistoryRows(hist));
}
function openRecords(from) {
  recordsBackTarget = from;
  renderRecordsPage();
  flipAwayToScreen("records");
  fitHeatGrid();                                   // now visible (display:block) → size to the real width
  requestAnimationFrame(() => fitHeatGrid());      // and again next frame, in case layout wasn't flushed
}
let achievementsBackTarget = "start";  // where the Charm Collection's ← back returns to
function openAchievements(from) {
  achievementsBackTarget = from;
  renderAchievementsPage();
  flipAwayToScreen("achievements");
}

/* ---------- Challenges page ---------- */
let challengesBackTarget = "start";  // where the Challenges' back link returns to
let challSelectedId = null;          // which challenge the detail panel is showing

// Status marks for the contents list (gold tick = defeated, hollow ring = open, lock = locked).
const CHALL_TICK = `<svg viewBox="0 0 20 20" class="chall-mark-svg" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="#d8a32f" stroke-width="1.6"/><path d="M5.5 10.2 L8.7 13.4 L14.5 6.4" fill="none" stroke="#d8a32f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHALL_RING = `<svg viewBox="0 0 20 20" class="chall-mark-svg" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="#b6a98d" stroke-width="1.6"/></svg>`;
const CHALL_LOCK = `<svg viewBox="0 0 20 20" class="chall-mark-svg" aria-hidden="true"><rect x="4.5" y="9" width="11" height="8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.8 9 V6.7 a3.2 3.2 0 0 1 6.4 0 V9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
const CHALL_STAR = `<svg viewBox="0 0 24 24" class="chall-star-svg" aria-hidden="true"><path d="M12 2.3 L14.94 7.96 L21.22 9 L16.76 13.55 L17.7 19.85 L12 17 L6.3 19.85 L7.24 13.55 L2.78 9 L9.06 7.96 Z" fill="#e0a32f" stroke="#b9821f" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

// Difficulty rating — cassette tapes (1 easy → 3 hard). Echoes the dark-shell +
// cream-label cassette desk prop; the shell is recoloured per tier by the
// wrapper's t1/t2/t3 class (green → orange → red, set in CSS).
const TAPE_GLYPH = `<svg viewBox="0 0 24 16" class="tape-glyph" aria-hidden="true"><rect class="tape-shell" x="1" y="1.6" width="22" height="12.8" rx="2.2"/><rect class="tape-label" x="5" y="3.3" width="14" height="3.2" rx="0.7"/><circle class="tape-reel" cx="8.5" cy="10.2" r="2.4"/><circle class="tape-reel" cx="15.5" cy="10.2" r="2.4"/></svg>`;
const TAPE_WORD = { 1: "easy", 2: "tricky", 3: "tough" };

// `n` tapes (clamped 1–3); the wrapper's t<n> class colours them by tier.
function tapesMarkup(n) {
  const t = Math.max(1, Math.min(3, n || 1));
  return `<span class="chall-tapes t${t}" aria-label="difficulty ${t} of 3">${TAPE_GLYPH.repeat(t)}</span>`;
}

function openChallenges(from) {
  challengesBackTarget = from;
  renderChallengesPage();
  flipAwayToScreen("challenges");
}

function renderChallengesPage() {
  const tk = loadChallengeTokens().balance;
  const defeated = CHALLENGES.filter((c) => challengeRecord(c.id).defeated).length;

  // Default selection: keep the current pick if still valid, else the first
  // not-yet-defeated challenge, else the very first.
  if (!challSelectedId || !CHALLENGE_BY_ID[challSelectedId]) {
    const firstOpen = CHALLENGES.find((c) => !challengeRecord(c.id).defeated);
    challSelectedId = (firstOpen || CHALLENGES[0]).id;
  }

  // Grouped by difficulty: three tape tiers (easy → tough), each a coloured
  // header over its challenges (kept in registry order within the tier).
  let list = "";
  [1, 2, 3].forEach((tier) => {
    const inTier = CHALLENGES.filter((c) => (c.tapes || 1) === tier);
    if (!inTier.length) return;
    list += `<div class="chall-group">` +
      `<div class="chall-group-head t${tier}">` +
        `${tapesMarkup(tier)}` +
        `<span class="chall-group-label">${TAPE_WORD[tier]}</span>` +
        `<span class="chall-group-count">${inTier.length}</span>` +
      `</div>`;
    inTier.forEach((c) => {
      const rec = challengeRecord(c.id);
      const open = c.free || rec.unlocked;
      let mark, stateCls;
      if (rec.defeated)   { mark = CHALL_TICK; stateCls = "is-defeated"; }
      else if (open)      { mark = CHALL_RING; stateCls = "is-open"; }
      else                { mark = CHALL_LOCK; stateCls = "is-locked"; }
      list += `<button type="button" class="chall-item ${stateCls}" data-id="${c.id}">` +
        `<span class="chall-item-name">${escapeHtml(c.name)}</span>` +
        `<span class="chall-item-mark">${mark}</span></button>`;
    });
    list += `</div>`;
  });

  const html =
    `<div class="chall-head">` +
      `<div class="chall-head-sub">spend a token · defeat the rule</div>` +
      `<span class="chall-tokens" title="spend a token to unlock a challenge">` +
        `🎟 <b>${tk}</b> token${tk === 1 ? "" : "s"}</span>` +
    `</div>` +
    `<div class="chall-layout">` +
      `<div class="chall-list">${list}` +
        `<div class="chall-tally">${defeated} of ${CHALLENGES.length} defeated</div>` +
      `</div>` +
      `<div class="chall-detail" id="challDetail"></div>` +
    `</div>`;

  const el = $("challengesBody");
  el.innerHTML = html;
  el.querySelectorAll(".chall-item").forEach((b) =>
    b.addEventListener("click", () => selectChallenge(b.dataset.id)));
  selectChallenge(challSelectedId);
}

function selectChallenge(id) {
  challSelectedId = id;
  const body = $("challengesBody");
  if (!body) return;
  body.querySelectorAll(".chall-item").forEach((b) =>
    b.classList.toggle("selected", b.dataset.id === id));
  renderChallengeDetail(id);
}

function renderChallengeDetail(id) {
  const el = $("challDetail");
  if (!el) return;
  const c = CHALLENGE_BY_ID[id];
  const rec = challengeRecord(id);
  const open = c.free || rec.unlocked;
  const cost = c.cost || 1;
  const tk = loadChallengeTokens().balance;
  const mode = MODES[c.mode];

  let action;
  if (!open) {
    action = tk >= cost
      ? `<button type="button" class="chall-go is-unlock" data-unlock="${id}">unlock · 🎟 ${cost}</button>`
      : `<div class="chall-need">need a token · 🎟 ${cost}</div>` +
        `<button type="button" class="chall-token-link" data-open-charms>get tokens from charms</button>`;
  } else {
    action = `<button type="button" class="chall-go" data-play="${id}">${rec.defeated ? "Play again" : "Play"}</button>`;
  }

  let meta = "";
  if (rec.defeated) meta = `best ${rec.best}/${TOTAL_ROUNDS} · ${rec.attempts} attempt${rec.attempts === 1 ? "" : "s"}`;
  else if (rec.attempts) meta = `${rec.attempts} attempt${rec.attempts === 1 ? "" : "s"} · not yet beaten`;

  el.innerHTML =
    `<div class="chall-detail-head">` +
      `<span class="chall-detail-charm">${charmMarkup(c.icon)}</span>` +
      `<span class="chall-detail-name">${escapeHtml(c.name)}</span>` +
      (rec.defeated ? `<span class="chall-detail-star">${CHALL_STAR}</span><span class="chall-detail-stamp">defeated</span>` : "") +
    `</div>` +
    `<div class="chall-diff">` +
      `<span class="chall-eyebrow">Difficulty</span>` +
      `${tapesMarkup(c.tapes)}` +
      `<span class="chall-diff-word">${TAPE_WORD[Math.max(1, Math.min(3, c.tapes || 1))]}</span>` +
    `</div>` +
    `<div class="chall-sec">` +
      `<div class="chall-eyebrow">The rule</div>` +
      `<div class="chall-rule">${escapeHtml(c.desc)}</div>` +
    `</div>` +
    `<div class="chall-sec chall-sec--beat">` +
      `<div class="chall-eyebrow">To beat it</div>` +
      `<div class="chall-goal">${escapeHtml(c.win)}</div>` +
      `<div class="chall-mods">${escapeHtml(c.blurb || mode.blurb)}</div>` +
    `</div>` +
    `<div class="chall-act">` +
      `<span class="chall-meta">${meta}</span>${action}` +
    `</div>`;

  const ub = el.querySelector("[data-unlock]");
  if (ub) ub.addEventListener("click", () => { if (unlockChallenge(ub.dataset.unlock)) renderChallengesPage(); });
  const cb = el.querySelector("[data-open-charms]");
  if (cb) cb.addEventListener("click", () => openAchievements("challenges"));
  const pb = el.querySelector("[data-play]");
  if (pb) pb.addEventListener("click", () => startChallenge(pb.dataset.play));
}

/* ---------- Album Focus page (master/detail; the 12-album completion board) ---------- */
let albumFocusBackTarget = "start";   // where the Album Focus back link returns to
let afSelectedAlbum = null;           // which album the detail panel is showing
let afSelectedDiff = "medium";        // the difficulty tab the detail panel has picked

// Status mark for an album row, scaling with how hard it was beaten/perfected. The exact
// visual tiers are styling — the data (beatenDiff/perfectedDiff) drives which one shows.
function afStatusMark(rec) {
  if (rec.perfected) return `<span class="af-mark af-mark--perfect" data-diff="${rec.perfectedDiff || ""}">${CHALL_STAR}</span>`;
  if (rec.beaten)    return `<span class="af-mark af-mark--beaten" data-diff="${rec.beatenDiff || ""}">${CHALL_TICK}</span>`;
  if (rec.best > 0)  return `<span class="af-mark af-mark--played">${CHALL_RING}</span>`;
  return `<span class="af-mark af-mark--none">—</span>`;
}

function openAlbumFocus(from) {
  albumFocusBackTarget = from;
  renderAlbumFocusPage();
  flipAwayToScreen("albumfocus");
}

function renderAlbumFocusPage() {
  const board = loadAlbumFocus();
  const beaten = STUDIO_ALBUMS.filter((a) => board[a] && board[a].beaten).length;
  const perfected = STUDIO_ALBUMS.filter((a) => board[a] && board[a].perfected).length;

  // Default selection: keep the current pick if valid, else the first not-yet-beaten album.
  if (!afSelectedAlbum || !STUDIO_ALBUMS.includes(afSelectedAlbum)) {
    afSelectedAlbum = STUDIO_ALBUMS.find((a) => !(board[a] && board[a].beaten)) || STUDIO_ALBUMS[0];
  }

  let list = "";
  STUDIO_ALBUMS.forEach((a, idx) => {
    const rec = albumFocusRecord(a);
    const stateCls = rec.perfected ? "is-perfect" : rec.beaten ? "is-beaten" : rec.best > 0 ? "is-played" : "is-fresh";
    const best = rec.best > 0 ? `<span class="af-item-best">${rec.best}/${TOTAL_ROUNDS}</span>` : "";
    list += `<button type="button" class="chall-item af-item ${stateCls}" data-album="${escapeHtml(a)}">` +
      `<span class="af-item-dot" style="background:${albumColor(a) || "#999"}"></span>` +
      `<span class="chall-item-name">${escapeHtml(a)}</span>` +
      `${best}<span class="chall-item-mark">${afStatusMark(rec)}</span></button>`;
  });

  const perfectLine = perfected ? ` · perfected <b>${perfected}</b>/${STUDIO_ALBUMS.length}` : "";
  const html =
    `<div class="chall-head">` +
      `<div class="chall-head-sub">pick an album · beat all 12</div>` +
      `<span class="chall-tokens">beaten <b>${beaten}</b>/${STUDIO_ALBUMS.length}${perfectLine}</span>` +
    `</div>` +
    `<div class="chall-layout">` +
      `<div class="chall-list">${list}</div>` +
      `<div class="chall-detail" id="afDetail"></div>` +
    `</div>`;

  const el = $("albumFocusBody");
  el.innerHTML = html;
  el.querySelectorAll(".af-item").forEach((b) =>
    b.addEventListener("click", () => selectAlbum(b.dataset.album)));
  selectAlbum(afSelectedAlbum);
}

function selectAlbum(album) {
  afSelectedAlbum = album;
  const body = $("albumFocusBody");
  if (!body) return;
  body.querySelectorAll(".af-item").forEach((b) =>
    b.classList.toggle("selected", b.dataset.album === album));
  renderAlbumDetail(album);
}

function renderAlbumDetail(album) {
  const el = $("afDetail");
  if (!el) return;
  const rec = albumFocusRecord(album);
  const col = albumColor(album) || "#999";

  const tabs = ALBUM_FOCUS_DIFFS.map((d) =>
    `<button type="button" class="af-diff${d === afSelectedDiff ? " is-on" : ""}" data-diff="${d}">${escapeHtml(MODES[d].label)}</button>`
  ).join("");

  const stamp = rec.perfected
    ? `<span class="chall-detail-star">${CHALL_STAR}</span><span class="chall-detail-stamp af-stamp">perfected</span>`
    : rec.beaten ? `<span class="chall-detail-stamp af-stamp">beaten</span>` : "";

  let meta = "";
  if (rec.best > 0) {
    meta = `best ${rec.best}/${TOTAL_ROUNDS}`;
    if (rec.beatenDiff) meta += ` · beaten on ${(MODES[rec.beatenDiff] || {}).label || rec.beatenDiff}`;
  } else {
    meta = "not played yet";
  }

  el.innerHTML =
    `<div class="chall-detail-head">` +
      `<span class="af-detail-spine" style="background:${col}"></span>` +
      `<span class="chall-detail-name">${escapeHtml(album)}</span>${stamp}` +
    `</div>` +
    `<div class="chall-sec">` +
      `<div class="chall-eyebrow">The rule</div>` +
      `<div class="chall-rule">Every word and every answer comes from <b>${escapeHtml(album)}</b>.</div>` +
    `</div>` +
    `<div class="chall-sec chall-sec--beat">` +
      `<div class="chall-eyebrow">To beat it</div>` +
      `<div class="chall-goal">Score ${ALBUM_FOCUS_TARGET}/${TOTAL_ROUNDS} — a perfect 13/13 completes it in style.</div>` +
      `<div class="af-diffs">${tabs}</div>` +
    `</div>` +
    `<div class="chall-act">` +
      `<span class="chall-meta">${escapeHtml(meta)}</span>` +
      `<button type="button" class="chall-go" data-play="${escapeHtml(album)}">${rec.beaten ? "Play again" : "Start writing"}</button>` +
    `</div>`;

  el.querySelectorAll(".af-diff").forEach((b) =>
    b.addEventListener("click", () => { afSelectedDiff = b.dataset.diff; renderAlbumDetail(album); }));
  const pb = el.querySelector("[data-play]");
  if (pb) pb.addEventListener("click", () => startAlbumFocus(pb.dataset.play, afSelectedDiff));
}

/* ---------- Bracelet (hand-strung SVG) ---------- */
let justEarnedIndex = -1; // bead that just became a charm, for the swing-in

function renderBracelet() {
  const opts = gameType === "infinite"
    ? { total: Math.max(round, 1), letterBead: false, colors: albumPalette(), hinted: roundHinted, verseTiers: roundVerseTier }
    : { colors: albumPalette(), hinted: roundHinted, verseTiers: roundVerseTier };
  $("bracelet").innerHTML = buildBraceletSVG(roundResults, round, justEarnedIndex, roundAlbums, opts);
  const correct = roundResults.filter(Boolean).length;
  $("charmCount").textContent = correct;
  const pg = gameType === "infinite"
    ? Math.max(round, 1)
    : Math.min(Math.max(round, 1), TOTAL_ROUNDS);
  $("pageNum").textContent = pg;
  // Voice the progress the bracelet shows visually (the SVG is aria-hidden). Only
  // re-announces when the text changes, so it fires on round advance and after a verdict.
  const sr = $("srStatus");
  if (sr) {
    sr.textContent = (gameType === "infinite" ? `Round ${pg}. ` : `Page ${pg} of ${TOTAL_ROUNDS}. `)
      + `${correct} correct so far.`;
  }
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

/* ---------- Adaptive level ---------- */
// Move the rarity level after a verdict: promote-slow (ADAPT_PROMO_STREAK correct at a
// level climbs one), demote-fast (any miss/timeout drops one). The visible level maps
// exactly onto the bucket in play; the promo sub-meter shows progress toward the next.
function adaptiveAdjust(correct) {
  if (correct) {
    adaptivePromo++;
    if (adaptivePromo >= ADAPT_PROMO_STREAK && adaptiveLevel < ADAPT_MAX_LEVEL) {
      adaptiveLevel++;
      adaptivePromo = 0;
    } else if (adaptiveLevel >= ADAPT_MAX_LEVEL) {
      adaptivePromo = 0;   // already at the ceiling — keep the meter empty, no overflow
    }
  } else {
    adaptivePromo = 0;
    if (adaptiveLevel > 1) adaptiveLevel--;
  }
  adaptivePeak = Math.max(adaptivePeak, adaptiveLevel);
  // Adaptive charms: The Lakes the moment you touch the Rarest tier; Stay Stay Stay stays
  // alive only while no miss has landed since reaching the top (judged at endAdaptive).
  if (adaptiveLevel >= ADAPT_MAX_LEVEL) { adaptiveReachedTop = true; unlock("the-lakes"); }
  if (!correct && adaptiveReachedTop) adaptiveHeldTop = false;
  renderAdaptiveGauge();
}

// The visible rarity gauge: four tier pips lit up to the current level, with a promo
// sub-meter filling toward the next. Only shown in Adaptive; every other mode hides it.
function renderAdaptiveGauge() {
  const el = $("adaptiveGauge");
  if (!el) return;
  if (gameType !== "adaptive") { el.classList.remove("show"); el.innerHTML = ""; return; }
  const atTop = adaptiveLevel >= ADAPT_MAX_LEVEL;
  const pips = [];
  for (let lvl = 1; lvl <= ADAPT_MAX_LEVEL; lvl++) {
    const on = lvl <= adaptiveLevel ? " on" : "";
    const cur = lvl === adaptiveLevel ? " cur" : "";
    pips.push(`<span class="adapt-pip${on}${cur}" aria-hidden="true"></span>`);
  }
  // Promo meter: fraction of the way to the next level (hidden at the ceiling).
  const frac = atTop ? 1 : Math.min(1, adaptivePromo / ADAPT_PROMO_STREAK);
  const meter = atTop
    ? `<span class="adapt-meter adapt-meter--top" aria-hidden="true"></span>`
    : `<span class="adapt-meter" aria-hidden="true"><i style="width:${Math.round(frac * 100)}%"></i></span>`;
  const name = ADAPTIVE_LEVELS[adaptiveLevel] || "";
  el.innerHTML =
    `<span class="adapt-label">Level ${adaptiveLevel} · ${name}</span>` +
    `<span class="adapt-pips">${pips.join("")}</span>` +
    meter;
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
  // songs.json stores lyrics as structured sections ([{label, lines}]); the game
  // works off a flat newline-joined `lyrics` string, so derive it here once. The
  // `sections` stay on the song object (line numbers + verse/chorus/bridge) for the
  // lyrics searcher. The flatten is byte-identical to the old flat `lyrics` field.
  allSongs = grouped.flatMap(({ album, songs }) =>
    songs.map((s) => ({
      ...s,
      album,
      lyrics: Array.isArray(s.sections)
        ? s.sections.flatMap((sec) => sec.lines || []).join("\n")
        : (s.lyrics || ""),
    }))
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
  // Spaceless fallback: forgive misplaced spaces ("all to owell" -> "all too well") by
  // indexing each title/alias with its spaces stripped. Only kept when unambiguous — if
  // two distinct songs collapse to the same spaceless key, we drop it rather than guess.
  spacelessIndex = new Map();
  const spaceClash = new Set();
  for (const [key, song] of titleIndex) {
    const sp = key.replace(/ /g, "");
    if (!sp || sp === key) continue;          // no spaces -> the normal index already covers it
    const existing = spacelessIndex.get(sp);
    if (existing && existing !== song) { spaceClash.add(sp); continue; }
    spacelessIndex.set(sp, song);
  }
  for (const sp of spaceClash) spacelessIndex.delete(sp);
  // Lenient playability (Easy/Medium/Hard use derived forms).
  playableWords = words.filter((w) => songsContainingWord(w, false).length >= 1);
  if (!playableWords.length) throw new Error("No playable words found in data");
  // Title...? challenge pool: words that appear in at least one song title (so every
  // round can be won by naming a title that holds the word).
  titleWordList = playableWords.filter((w) => titleSongsForWord(w, false).length >= 1);
  // Short n' Sweet pool: words with at least one valid (lyrics) song whose title is ≤2 words,
  // so every round can be won with a one- or two-word title.
  shortTitleWordList = playableWords.filter((w) =>
    validSongs(w, false, false).some((s) => titleWordCount(s.title) <= 2));
  // On Tour! pools: for each album, the playable words that have a valid (lyrics) song
  // in it, so each tour stop can be handed a winnable word. Plus the canonical album order.
  albumOrder = grouped.map((g) => g.album);
  albumWordMap = {};
  for (const w of playableWords) {
    for (const a of new Set(validSongs(w, false, false).map((s) => s.album)))
      (albumWordMap[a] = albumWordMap[a] || []).push(w);
  }
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
const GAMETYPE_LABELS = { classic: "Classic", infinite: "Infinite", adaptive: "Adaptive" };
const GAME_TYPES = ["classic", "infinite", "adaptive"];
const VARIANT_LABELS = { "3lives": "3 lives", sudden: "Sudden death" };

// The start-screen "your best" line follows the selected mode (+ infinite variant).
function refreshStartBoard() {
  const t = $("startPodiumTitle");
  if (t) t.textContent = "Your best";
  if (gameType === "adaptive") { renderAdaptiveBest($("startBest")); return; }
  renderBestLine($("startBest"), boardMode());
}
// Adaptive's "your best" line — the highest level ever reached (its board metric),
// with the score on that run as the tie-break detail.
function renderAdaptiveBest(el) {
  const rec = adaptiveRecord();
  if (!rec.played) {
    el.innerHTML = `<div class="best-empty">no climbs yet — see how high you reach <span class="best-empty-star">${STAR_SVG}</span></div>`;
    return;
  }
  const name = ADAPTIVE_LEVELS[rec.bestPeak] || "";
  el.innerHTML =
    `<div class="best-line"><span class="best-num"><span class="lvl-prefix">L</span>${rec.bestPeak}<span class="best-unit"> · ${escapeHtml(name)}</span></span>` +
    `<span class="best-meta">★ highest level · ${rec.bestScore}/${TOTAL_ROUNDS} that run${rec.date ? " · " + recordDateLabel(rec.date) : ""}</span></div>`;
}
// Show/hide the start-screen rows that only apply to a particular game type:
// the lives variant row (Infinite only) and the difficulty picker vs the Adaptive
// explainer (difficulty floats in Adaptive, so its picker is meaningless).
function applyTypeLayout() {
  const isAdaptive = gameType === "adaptive";
  const vr = $("variantRow"); if (vr) vr.style.display = gameType === "infinite" ? "" : "none";
  const dr = $("difficultyRow"); if (dr) dr.style.display = isAdaptive ? "none" : "";
  const an = $("adaptiveNote"); if (an) an.style.display = isAdaptive ? "" : "none";
}
function updateBlurb() {
  if (gameType === "adaptive") {
    const an = $("adaptiveNote");
    if (an) an.textContent = "Start in the middle. Every right answer climbs you toward rarer words; a miss drops you back. Your level is shown as you play.";
  } else {
    const b = $("modeBlurb");
    if (b) {
      if (gameType === "infinite") {
        const v = infiniteVariant === "sudden" ? "one miss ends it" : "three lives";
        b.textContent = v + " · " + currentMode.blurb;
      } else {
        b.textContent = currentMode.blurb;
      }
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
    : gameType === "adaptive"
    ? `${TOTAL_ROUNDS} pages · difficulty that climbs with you`
    : `${TOTAL_ROUNDS} pages · ${clock}`;
}
function renderModePicker() {
  const tabs = $("modeTabs");
  if (!tabs) return;
  const tab = (m, extra) =>
    `<button type="button" class="mode-tab${extra || ""}${m === currentMode.id ? " active" : ""}" data-mode="${m}">${MODES[m].label}</button>`;
  // The relaxed→ultra ladder is one axis; lyricist is a separate modality, so it sits past a
  // divider with its own "by heart" caption rather than reading as a sixth difficulty rung.
  const ladder = DIFFICULTY_LADDER.map((m) => tab(m)).join("");
  const modality = MODALITY_MODES.length
    ? `<span class="mode-tab-sep" aria-hidden="true"></span>` +
      MODALITY_MODES.map((m) => tab(m, " mode-tab--modality")).join("")
    : "";
  tabs.innerHTML = ladder + modality;
  tabs.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));
  updateBlurb();
}
function renderTypePicker() {
  const tabs = $("typeTabs");
  if (!tabs) return;
  tabs.innerHTML = GAME_TYPES.map((g) =>
    `<button type="button" class="mode-tab${g === gameType ? " active" : ""}" data-type="${g}">${g === "infinite" ? `<span class="inf-glyph" aria-hidden="true">∞</span>` : ""}${GAMETYPE_LABELS[g]}</button>`
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
  if (!GAME_TYPES.includes(gameType)) gameType = "classic";
  // A daily game forces currentMode to Normal without persisting; restore the
  // player's preference (a fixed default-difficulty setting, else their last pick).
  currentMode = (settings.defaultDifficulty !== "last" && MODES[settings.defaultDifficulty])
    ? MODES[settings.defaultDifficulty]
    : loadMode();
  renderTypePicker();
  renderVariantPicker();
  applyTypeLayout();
  renderModePicker();
  refreshStartBoard();
  renderDailyButtonState();
  renderAnniversaryNote();
}
// Dated marginalia at the top of today's page: on a real Taylor milestone (an album
// release or her birthday) a warm handwritten note appears, tinted to that era. Most
// days it's silent (hidden). Keyed on todayKey() so it flips on the player's local day.
function renderAnniversaryNote() {
  const el = $("anniversaryNote");
  if (!el) return;
  const note = anniversaryNote(todayKey(), TS_MILESTONES);
  if (!note) { el.hidden = true; el.textContent = ""; el.style.color = ""; return; }
  el.textContent = note.text;
  const colors = settings.colorBlindAlbums ? CB_ALBUM_COLORS : ALBUM_COLORS;
  el.style.color = (note.album && colors[note.album]) || "";
  el.hidden = false;
}
// The Daily Challenge button wears an obvious "not done yet" coat (a sketchy dashed
// ink border, a pinned "today!" sticky note, and 13 twinkling margin stars — Taylor's
// number) until today's puzzle is played; once played it falls back to its quiet denim
// resting state, so the difference reads at a glance.
// Scatter spots ([left%, top%]) hug the button's edges, clear of the centred label.
const DAILY_STAR_SPOTS = [
  [5, 24], [10, 64], [15, 32], [21, 72], [27, 18],
  [50, 14], [50, 84], [36, 80], [64, 80],
  [73, 22], [80, 66], [88, 30], [93, 70],
];
function renderDailyButtonState() {
  const btn = $("dailyBtn");
  if (!btn) return;
  const undone = !loadDailyResult(todayKey());
  btn.classList.toggle("undone", undone);
  // Played today: a quieter, slightly muted "done" coat (it's still clickable to
  // re-open today's result, so it dims rather than disabling).
  btn.classList.toggle("done", !undone);
  // Wrap the label once so it always stacks above the decorative stars.
  let label = btn.querySelector(".daily-label");
  if (!label) {
    const text = btn.textContent.trim() || "Daily Challenge";
    btn.textContent = "";
    label = document.createElement("span");
    label.className = "daily-label";
    label.textContent = text;
    btn.appendChild(label);
  }
  // Sticky note: "today!" while unplayed, "✓ done" once today's puzzle is in.
  let tab = btn.querySelector(".daily-tab");
  if (!tab) {
    tab = document.createElement("span");
    tab.className = "daily-tab";
    btn.appendChild(tab);
  }
  tab.textContent = undone ? "today!" : "✓ done";
  const hasStars = btn.querySelector(".daily-star");
  if (undone && !hasStars) {
    DAILY_STAR_SPOTS.forEach((p) => {
      const s = document.createElement("span");
      s.className = "daily-star";
      s.textContent = "✦";
      s.style.left = p[0] + "%";
      s.style.top = p[1] + "%";
      // Randomise each star's phase + speed so they sparkle independently rather
      // than rippling left-to-right. Negative delay starts them mid-twinkle.
      s.style.animationDelay = (-Math.random() * 3).toFixed(2) + "s";
      s.style.animationDuration = (1.5 + Math.random() * 1.6).toFixed(2) + "s";
      btn.appendChild(s);
    });
  } else if (!undone && hasStars) {
    btn.querySelectorAll(".daily-star").forEach((s) => s.remove());
  }
  // Inline streak under the label once played (matches the "🔥 N day streak" phrasing
  // used on the Stats and Records pages).
  let streak = btn.querySelector(".daily-streak-inline");
  const d = !undone ? effectiveDailyStreak(todayKey()) : null;
  if (d && d.current > 0) {
    if (!streak) {
      streak = document.createElement("span");
      streak.className = "daily-streak-inline";
      label.insertAdjacentElement("afterend", streak);
    }
    streak.textContent = `🔥 ${d.current}-day streak`;
  } else if (streak) {
    streak.remove();
  }
  // Left sticky note: a live "next in …" countdown to the reset, shown only once
  // today's puzzle is played (the right note answers "done?", this one "when's next?").
  let cd = btn.querySelector(".daily-countdown");
  if (!undone) {
    if (!cd) {
      cd = document.createElement("span");
      cd.className = "daily-countdown";
      btn.appendChild(cd);
    }
    startResetCountdown();
  } else {
    if (cd) cd.remove();
    stopResetCountdown();
  }
}
let dailyCountdownTimer = null;
function startResetCountdown() {
  stopResetCountdown();
  const tick = () => {
    const note = document.querySelector("#dailyBtn .daily-countdown");
    if (!note) { stopResetCountdown(); return; }
    const ms = msUntilDailyReset();
    if (ms <= 1000) { renderDailyButtonState(); return; }   // rolled into a new local day → flip to undone
    note.textContent = "next in " + formatResetCountdown(ms);
  };
  tick();
  dailyCountdownTimer = setInterval(tick, 1000);
}
function stopResetCountdown() {
  if (dailyCountdownTimer) { clearInterval(dailyCountdownTimer); dailyCountdownTimer = null; }
}
function setGameType(g) {
  gameType = GAME_TYPES.includes(g) ? g : "classic";
  rememberGameType(gameType);   // "last" tracks the last type clicked, not the last played
  applyTypeLayout();
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
// The zone the daily resets in: the player's Settings override, else their detected
// local zone. A bad stored id (e.g. after an Intl data change) falls back to auto.
function activeTimeZone() {
  const tz = settings.timezone;
  try {
    if (tz && tz !== "auto") { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return tz; }
  } catch (e) { /* invalid stored zone — fall through to auto */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
// Today's date key, "YYYY-MM-DD" in the active zone (en-CA renders ISO order). The
// daily gate, puzzle seed, streak, share, and button state all route through this.
function todayKey() {
  if (typeof window !== "undefined" && window.__devDate) return window.__devDate;   // dev date override
  try { return new Date().toLocaleDateString("en-CA", { timeZone: activeTimeZone() }); }
  catch (e) { return new Date().toLocaleDateString("en-CA"); }
}
// ms until the next local midnight in the active zone (seconds-of-day from the wall
// clock, subtracted from a full day). Good enough for a countdown — ignores the rare
// DST-transition day where a day isn't exactly 86400s.
function msUntilDailyReset() {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: activeTimeZone(), hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date());
  const g = (t) => +(p.find((x) => x.type === t)?.value || 0);
  const into = (g("hour") % 24) * 3600 + g("minute") * 60 + g("second");
  return (86400 - into) * 1000;
}
// "7h 02m" when an hour or more remains, "42m 10s" under an hour.
function formatResetCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = String(sec).padStart(2, "0");
  // Seconds always show so the note visibly ticks every second; hours appear only when
  // they're nonzero (≥1h: "7h 02m 33s", under: "42m 10s").
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m ${ss}s`
              : `${m}m ${ss}s`;
}

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
  if (gameType === "adaptive") return null;   // Adaptive has its own board (peak level), not a per-difficulty one
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
  gameVersePerfect = 0;
  gameWholeVerses = 0;
  verseKeepsake = [];
  roundVerseTier = [];
  lyricAnswerSongs = [];
  gameTimeSum = 0;
  gameHitRedZone = false;
  rareStreak = 0;
  gameFuzzyMatches = 0;
  gameTimedRounds = 0;
  gameFastestMs = null;
  newlyUnlocked = [];
  usedWords = [];
  recentEras = [];
  roundResults = [];
  roundAlbums = [];
  roundWords = [];
  roundSongs = [];
  roundHinted = [];
  hintsUsed = 0;
  runFolded = false;
  adaptiveLevel = ADAPT_START_LEVEL;
  adaptivePeak = ADAPT_START_LEVEL;
  adaptivePromo = 0;
  adaptiveReachedTop = false;
  adaptiveHeldTop = true;
  adaptiveDropAnnounced = ADAPT_START_LEVEL < ADAPT_NODROP_LEVEL;   // suggestions on at the start level
  dailyRng = null;
  currentChallenge = null;
  challengeRunActive = false;
  focusAlbum = null;
  focusDifficulty = null;
  lastAlphaLetter = "";
  roundSecondsOverride = null;
  chainLetter = "";
  tourSetlist = [];
  comboClock = 0;
  challengeTargetSong = null;
  challengeForcedRound = 0;
  challengeForcedWordVal = "";
  forcedFirstWord = "";
  newSongLives = 0;
  extraSecondsPerRound = 0;
  skipTokens = 0;
  pathForksTaken = [];
  perksTaken = [];
  pathMulligans = 0;
  perkReveals = new Set();
  perkPoolOverride = null;
  perkNoTitleOff = false;
  perkCalm = false;
  roundLyricOnly = false;
  roundNamed = [];
  devilCursesTaken = [];
  devilDropOff = false;
  devilVanish = false;
  devilFx = null;
  devilNoTitle = false;
  devilShortOnly = false;
  devilBannedAlbums = [];
  devilBannedInitials = [];
  devilPoolHard = false;
  roundWildcard = null;
  lastWildcardId = "";
  clearTimeout(vanishTimer);
  if (revolveId) { clearInterval(revolveId); revolveId = null; }
  revolveIndex = 0;
  clearCurtain();
  const skipBtn = $("pathSkipBtn");
  if (skipBtn) skipBtn.remove();
  const banner = $("challBanner");
  if (banner) banner.remove();
  const wrap = $("wordDisplay") && $("wordDisplay").parentNode;
  if (wrap) wrap.classList.remove("vanished");
}

// Fold the rounds completed so far into the lifetime stats (songs/words
// discovered, played count, score distribution). Shared by quitGame and the
// page-unload handler so leaving mid-game never throws away progress. An
// abandoned run can't set a personal best (countBest = false) or hit the
// history. Idempotent per run via runFolded.
function foldRunProgress() {
  if (runFolded || roundResults.length === 0) return;
  // Sandboxed modes never fold into difficulty stats. Daily is also skipped: it resumes
  // after a refresh/exit and folds its tally in full at completion (endGame), so folding
  // a partial here would double-count the same rounds once the run is finished.
  if (gameType === "challenge" || gameType === "album" || gameType === "adaptive" || gameType === "daily") { runFolded = true; return; }
  runFolded = true;
  const partialScore = gameType === "infinite" ? roundResults.length : score;
  updateStats(partialScore, boardMode(), gameMaxStreak, false);
  recordGameTally(roundResults.map((correct, i) => ({
    correct,
    title: roundSongs[i] || null,
    album: roundAlbums[i] || null,
    word: roundWords[i] || null,
  })));
}
function applyInputHints() {
  const input = $("songInput");
  const hint = $("gameHint");
  if (currentMode.lyricOnly) {
    input.placeholder = "type the lyric line…";
    hint.textContent = "write more of the line for a bigger verse bonus — Enter to answer";
    return;
  }
  const suggesting = effectiveDropdown();
  input.placeholder = suggesting ? "a title… or sing me a line" : "the full title… or a lyric line";
  hint.textContent = suggesting ? "Enter accepts the top match — or write a lyric line for a verse bonus" : "no suggestions — type the full title or a real lyric line, then Enter";
  if (settings.enableHints !== false && currentMode.hint && gameType !== "daily") {
    hint.textContent += " · Tab for a hint";
  }
}

/* ---------- Hints (progressive ladder, Easy/Relaxed only) ---------- */
// All tiers derive from currentSongs — nothing is handwritten. A hinted run still
// plays/scores/logs to history but can't set a personal best (see endGame).
function hintsAllowed() {
  return settings.enableHints !== false && !!currentMode.hint &&
    gameType !== "daily" && !roundLocked;
}

// Reset the hint UI for a fresh round; show the affordance only when hints apply.
function renderHintAffordance() {
  clearTimeout(hintUrgeTimer);
  const btn = $("hintBtn");
  const box = $("hintBox");
  box.innerHTML = "";
  hintTier = 0;
  applyInputHints();   // restore the default placeholder/hint (a prior round's tier-3 may have changed it)
  if (!btn) return;
  btn.classList.remove("urge");
  if (hintsAllowed() && roundHintSong) {
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = "need a hint?";
    // Relaxed has no clock — nudge after a few idle seconds instead of at half-time.
    if (!(currentMode.seconds > 0) && !motionReduced()) {
      hintUrgeTimer = setTimeout(() => {
        if (hintsAllowed() && hintTier === 0) btn.classList.add("urge");
      }, 6000);
    }
  } else {
    btn.hidden = true;
  }
}

// Reveal the next hint tier (1 = count + album, 2 = title shape, 3 = lyric line).
function useHint() {
  if (!hintsAllowed() || hintTier >= 3 || !roundHintSong) return;
  if (hintTier === 0 && !roundHinted[round - 1]) {
    roundHinted[round - 1] = true;
    hintsUsed++;
  }
  hintTier++;
  const btn = $("hintBtn");
  clearTimeout(hintUrgeTimer);
  if (btn) btn.classList.remove("urge");

  const box = $("hintBox");
  const tiers = [];
  // Tier 1 — how many songs, and the album of one of them (era/album-coloured chip).
  if (hintTier >= 1) {
    const n = currentSongs.length;
    const album = roundHintSong.album || "";
    const color = albumColor(album) || "var(--bead)";
    const chip = album
      ? ` · one's from <span class="hint-chip" style="--chip:${color}">${escapeHtml(album)}</span>`
      : "";
    tiers.push(`<p class="hint-tier">in <b>${n}</b> song${n === 1 ? "" : "s"}${chip}</p>`);
  }
  // Tier 2 — the title's shape: first letter + word count.
  if (hintTier >= 2) {
    const title = roundHintSong.title || "";
    const letter = (title.match(/[a-z]/i) || ["?"])[0].toUpperCase();
    const words = title.trim().split(/\s+/).filter(Boolean).length;
    tiers.push(`<p class="hint-tier">starts with “<b>${escapeHtml(letter)}</b>” · ${words} word${words === 1 ? "" : "s"}</p>`);
  }
  // Tier 3 — the actual lyric line, prompt word highlighted.
  if (hintTier >= 3) {
    const line = extractLineWithWord(roundHintSong.lyrics, currentWord, effectiveStrict());
    tiers.push(`<blockquote class="hint-tier hint-line">${highlightWord(line, currentWord)}</blockquote>`);
  }
  box.innerHTML = tiers.join("");

  if (btn && hintTier >= 3) {
    btn.textContent = "no more hints";
    btn.disabled = true;
    // The line is now on screen, so lyric-line answering is off (see submitAnswer) —
    // tell the player to name the song instead of typing back what they're reading.
    const input = $("songInput");
    input.placeholder = "now name the song…";
    $("gameHint").textContent = "type the song title — the line below is your clue";
  } else if (btn) {
    btn.textContent = "another hint?";
  }
}

function startGame(opts) {
  gameType = "classic";
  resetRunState();
  if (opts && opts.word) forcedFirstWord = opts.word;   // "Play this word" from the searcher
  applyInputHints();
  updateTagline();
  $("pageTotalWrap").style.display = "";
  $("pageTotal").textContent = TOTAL_ROUNDS;
  showScreen("game");
  nextRound();
}

// "Play this word" from the searcher (search/?word=…). Starts a normal classic run
// with round 1 forced to the requested word, if it's a real playable prompt word.
// Returns true if it took. Matching is case-insensitive against the playable pool.
function startFromWord(raw) {
  const want = String(raw || "").trim().toLowerCase();
  if (!want) return false;
  const match = playableWords.find((w) => w.toLowerCase() === want);
  if (!match) return false;
  startGame({ word: match });
  return true;
}

// Read a `?word=` deep-link (from the searcher's "play this word"), strip it from the
// URL so a refresh won't restart the round, then launch a forced classic run. Silently
// ignores an unknown/empty word, leaving the player on the start screen.
function maybeStartFromWordParam() {
  try {
    const params = new URLSearchParams(location.search);
    if (!params.has("word")) return;
    const word = params.get("word");
    params.delete("word");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    if (word && word.trim()) startFromWord(word);
  } catch (e) { /* malformed URL — ignore */ }
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

// Adaptive mode: a fixed 13-round run where the word-rarity level floats with the
// player's live performance, on a visible gauge. Levers stay at Normal's baseline
// (clone so the shared MODES object is never mutated); only the draw pool moves with
// the level. Sandboxed in its own board (peak level), never the difficulty records.
function startAdaptive() {
  gameType = "adaptive";
  currentMode = { ...MODES.medium };   // baseline levers (10s · suggestions · not-in-title), not persisted via DIFF_KEY
  resetRunState();                     // sets adaptiveLevel/Peak = ADAPT_START_LEVEL, promo = 0
  applyInputHints();
  updateTagline();
  $("pageTotalWrap").style.display = "";
  $("pageTotal").textContent = TOTAL_ROUNDS;
  showScreen("game");
  renderAdaptiveGauge();
  nextRound();
}

// Snapshot of the daily run's accumulators, persisted after each completed round so a
// refresh/exit resumes a faithful run (same score, streaks, verse bonus, timing) rather
// than a fresh restart. Daily forces Normal and disables hints, so none of the broader
// challenge/path/adaptive run state applies here. rngState pins the seeded PRNG position
// so the remaining words match what everyone else gets on the date.
function dailyProgressSnapshot(dateStr) {
  return {
    startDate: dateStr,
    round, score,
    rngState: dailyRng ? dailyRng.state() : null,
    roundResults: roundResults.slice(),
    roundAlbums: roundAlbums.slice(),
    roundWords: roundWords.slice(),
    roundSongs: roundSongs.slice(),
    roundVerseTier: roundVerseTier.slice(),
    usedWords: usedWords.slice(),
    recentEras: recentEras.slice(),
    correctStreak, gameMaxStreak, gameTimeouts,
    gameTimeSum, gameTimedRounds, gameFastestMs, gameHitRedZone,
    lyricLineAnswers, verseBonus, gameVersePerfect, gameWholeVerses, gameFuzzyMatches,
    rareStreak,
    verseKeepsake: verseKeepsake.slice(),
    lyricAnswerSongs: lyricAnswerSongs.slice(),
  };
}

// Restore a daily run from a saved snapshot (see dailyProgressSnapshot). The PRNG is
// re-seeded from the date then seeked to the saved position by the caller.
function restoreDailyProgress(p) {
  round = p.round || 0;
  score = p.score || 0;
  roundResults = Array.isArray(p.roundResults) ? p.roundResults.slice() : [];
  roundAlbums = Array.isArray(p.roundAlbums) ? p.roundAlbums.slice() : [];
  roundWords = Array.isArray(p.roundWords) ? p.roundWords.slice() : [];
  roundSongs = Array.isArray(p.roundSongs) ? p.roundSongs.slice() : [];
  roundVerseTier = Array.isArray(p.roundVerseTier) ? p.roundVerseTier.slice() : [];
  usedWords = Array.isArray(p.usedWords) ? p.usedWords.slice() : [];
  recentEras = Array.isArray(p.recentEras) ? p.recentEras.slice() : [];
  correctStreak = p.correctStreak || 0;
  gameMaxStreak = p.gameMaxStreak || 0;
  gameTimeouts = p.gameTimeouts || 0;
  gameTimeSum = p.gameTimeSum || 0;
  gameTimedRounds = p.gameTimedRounds || 0;
  gameFastestMs = p.gameFastestMs != null ? p.gameFastestMs : null;
  gameHitRedZone = !!p.gameHitRedZone;
  lyricLineAnswers = p.lyricLineAnswers || 0;
  verseBonus = p.verseBonus || 0;
  gameVersePerfect = p.gameVersePerfect || 0;
  gameWholeVerses = p.gameWholeVerses || 0;
  gameFuzzyMatches = p.gameFuzzyMatches || 0;
  rareStreak = p.rareStreak || 0;
  verseKeepsake = Array.isArray(p.verseKeepsake) ? p.verseKeepsake.slice() : [];
  lyricAnswerSongs = Array.isArray(p.lyricAnswerSongs) ? p.lyricAnswerSongs.slice() : [];
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
  // Resume an in-progress run from earlier today (a refresh or exit mid-daily) instead
  // of restarting — this is what closes the replay loophole. Restore the accumulators and
  // seek the PRNG to the saved position so the remaining words are deterministic. Stale
  // progress from another day is ignored (resetDaily / the date guard handle cleanup).
  const progress = loadDailyProgress(dateStr);
  const resuming = progress && progress.startDate === dateStr
    && progress.round > 0 && progress.round < TOTAL_ROUNDS;
  if (resuming) {
    restoreDailyProgress(progress);
    if (typeof progress.rngState === "number") dailyRng.seek(progress.rngState);
  }
  applyInputHints();
  updateTagline();
  $("pageTotalWrap").style.display = "";
  $("pageTotal").textContent = TOTAL_ROUNDS;
  showScreen("game");
  // On resume, advance straight into the next unplayed round (no page-flip from a blank
  // page); a fresh run goes through nextRound's round-0 instant path.
  if (resuming) { advanceRound(); beginRoundClock(); }
  else nextRound();
}

// A Challenge run: a fixed-13 game with a rule modifier, sandboxed like daily (no
// stats/records/history/tally/global achievements). The mode is fixed by the challenge.
function startChallenge(id) {
  const c = CHALLENGE_BY_ID[id];
  if (!c || !challengeUnlocked(id)) return;
  gameType = "challenge";
  currentMode = MODES[c.mode] || MODES.medium;   // fixed by the challenge, not persisted via DIFF_KEY
  // Some challenges override a single lever of the borrowed mode (Revolving Door wants a
  // 20s clock; Shrinking Timer hides suggestions). Clone so the shared MODES object is
  // never mutated; id stays the same so id-based achievement/label checks are unaffected.
  const lever = {};
  if (c.seconds != null) lever.seconds = c.seconds;
  if (c.dropdown != null) lever.dropdown = c.dropdown;
  if (Object.keys(lever).length) currentMode = { ...currentMode, ...lever };
  resetRunState();
  currentChallenge = c;                          // set AFTER resetRunState (which nulls it)
  challengeRunActive = true;                     // start the achievement sandbox
  if (c.rule === "newsong") setupNewSongChallenge();
  if (c.rule === "setlist") buildTourSetlist();
  if (c.rule === "combo") comboClock = COMBO_START;
  recordChallengeAttempt(id);
  applyInputHints();
  updateTagline();
  $("pageTotalWrap").style.display = "";
  $("pageTotal").textContent = TOTAL_ROUNDS;
  showScreen("game");
  nextRound();
}

// An Album Focus run: a fixed-13 game where every prompt word and valid answer come from
// ONE studio album, at a chosen difficulty. Sandboxed like challenges/daily — folds into the
// global catalogue tally + history + metrics, but never the difficulty boards/records.
function startAlbumFocus(album, diffId) {
  if (!STUDIO_ALBUMS.includes(album)) return;
  const mode = MODES[ALBUM_FOCUS_DIFFS.includes(diffId) ? diffId : "medium"];
  gameType = "album";
  currentMode = { ...mode };               // clone — never mutate the shared MODES object
  resetRunState();
  focusAlbum = album;                      // set AFTER resetRunState (which nulls them)
  focusDifficulty = currentMode.id;
  applyInputHints();
  updateTagline();
  $("pageTotalWrap").style.display = "";
  $("pageTotal").textContent = TOTAL_ROUNDS;
  showScreen("game");
  nextRound();
}

// One Of A Kind setup: pick a song the player has never answered, then a prompt word
// that surfaces it as NARROWLY as possible (fewest valid songs), so naming the target
// is actually achievable, and a round to force it on. Pre-seed usedWords so the word
// can't surface earlier by chance. New players (empty tally) → any song.
function setupNewSongChallenge() {
  challengeTargetSong = null; challengeForcedRound = 0; challengeForcedWordVal = "";
  const found = (loadSongTally().songs) || {};
  const unseen = allSongs.filter((s) => !found[s.title]);
  const target = shuffle((unseen.length ? unseen : allSongs).slice())[0];
  if (!target) return;
  const candidates = playableWords.filter((w) => wordRegex(w, false).test(target.lyrics));
  if (!candidates.length) return;                         // can't surface it — leave disabled
  const scored = candidates.map((w) => ({ w, n: validSongs(w, false, false).length }));
  const minN = Math.min(...scored.map((s) => s.n));
  challengeForcedWordVal = shuffle(scored.filter((s) => s.n === minN))[0].w;
  challengeTargetSong = target;
  newSongLives = NEW_SONG_LIVES;                             // wrong-guess budget for this run
  challengeForcedRound = 3 + Math.floor(Math.random() * 9);  // rounds 3..11
  if (!usedWords.includes(challengeForcedWordVal)) usedWords.push(challengeForcedWordVal);
}
// One Of A Kind: the prompt word forced on the target round (null otherwise / for
// every other challenge, since challengeTargetSong is only set for this rule).
function challengeForcedWord(r) {
  return (challengeTargetSong && r === challengeForcedRound) ? challengeForcedWordVal : null;
}

// On Tour!: a setlist of one album per round. Cycle through albums with enough candidate
// words (so each stop can be handed a winnable word), in shuffled canonical order — with
// 16 album groups this almost always yields 13 distinct stops. Degenerate data falls back
// to any album that has a candidate word.
const TOUR_MIN_WORDS = 3;
function buildTourSetlist() {
  tourSetlist = [];
  let eligible = albumOrder.filter((a) => (albumWordMap[a] || []).length >= TOUR_MIN_WORDS);
  if (!eligible.length) eligible = albumOrder.filter((a) => (albumWordMap[a] || []).length);
  if (!eligible.length) return;
  eligible = shuffle(eligible.slice());
  for (let i = 0; i < TOTAL_ROUNDS; i++) tourSetlist.push(eligible[i % eligible.length]);
}
// On Tour!: a winnable word for this round's scheduled album (one with a valid song in it).
function pickTourWord() {
  const album = tourSetlist[round - 1];
  if (!album) return null;
  const all = albumWordMap[album] || [];
  const pool = all.filter((w) => !usedWords.includes(w));
  const choices = pool.length ? pool : all;
  if (!choices.length) return null;                 // degenerate — let pickWord fall back
  const w = choices[Math.floor(Math.random() * choices.length)];
  usedWords.push(w);
  return w;
}
// Wrapped Like A Chain: a word whose valid set holds a song starting with the required
// chain letter, so the chain can always be extended. Round 1 (chainLetter "") returns
// null → the normal pool path runs. A true dead-end resets the chain to a free choice.
function pickChainWord() {
  if (!chainLetter) return null;
  const bucket = wordBuckets[effectivePool()] || playableWords;
  const fresh = shuffle(bucket.filter((w) => !usedWords.includes(w)));
  for (const w of fresh) {
    if (validSongs(w, effectiveStrict(), effectiveNoTitle())
        .some((s) => firstAlphaLetter(s.title) === chainLetter)) {
      usedWords.push(w);
      return w;
    }
  }
  chainLetter = "";   // no word can extend this letter — let the chain restart free
  return null;
}
// It's A Clock!: one shared run clock. COMBO_START seconds to begin, +COMBO_BONUS per
// correct answer, capped at COMBO_CAP. Hitting zero ends the run.
const COMBO_START = 20, COMBO_BONUS = 5, COMBO_CAP = 30;
function comboRuleActive() {
  return gameType === "challenge" && currentChallenge && currentChallenge.rule === "combo";
}
// Seconds left on the shared clock right now, derived from the running timer (total is
// scaled to COMBO_CAP, so remaining == the shared clock). Valid while/just after a combo
// round's timer ran.
function comboRemaining() {
  return Math.max(0, COMBO_CAP - (performance.now() - timerStart) / 1000);
}

// Per-round modifier for the active challenge (called from advanceRound after the
// word is written). Vanishing Word hides the prompt after a beat; matching is
// unaffected (currentWord/currentSongs live in state, not the DOM).
function applyChallengeRound(wrap) {
  if (gameType !== "challenge" || !currentChallenge || !wrap) return;
  if (currentChallenge.rule === "vanishing") {
    return;
  } else if (currentChallenge.rule === "wordfx") {
    renderWordFx(wrap, currentWord, round);
  } else if (currentChallenge.rule === "revolving") {
    renderRevolveCounter();
  } else if (currentChallenge.rule === "wildcard") {
    applyWildcardRound(wrap);
  } else if (currentChallenge.rule === "album5") {
    renderDeepCutCounter();
  } else if (currentChallenge.rule === "newsong") {
    renderNewSongBanner();
  } else if (currentChallenge.rule === "path") {
    renderPerkReveals();
  } else if (currentChallenge.rule === "accelerate") {
    roundSecondsOverride = accelSeconds(round);   // Shrinking Timer: shrink this page's clock
    renderAccelBanner();
  } else if (currentChallenge.rule === "titleHas" || currentChallenge.rule === "shorttitle") {
    renderTitleRuleBanner();
  } else if (currentChallenge.rule === "chain") {
    renderChainBanner();
  } else if (currentChallenge.rule === "setlist") {
    renderTourBanner();
  } else if (currentChallenge.rule === "combo") {
    renderComboBanner();
  } else if (currentChallenge.rule === "switchup") {
    // The page's answer type was decided in advanceRound (before the word was drawn); just
    // surface it in the banner.
    renderSwitchBanner();
  } else if (currentChallenge.rule === "multi") {
    renderMultiBanner();
  } else if (currentChallenge.rule === "devil") {
    if (devilVanish) vanishTimer = setTimeout(() => { wrap.classList.add("vanished"); }, 1500);
    if (devilFx) renderDevilFx(wrap, currentWord, devilFx);
    renderDevilBanner();
  }
}

// Switch-Up: which answer type this page wants + the running score.
function renderSwitchBanner() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "switchup") return;
  const el = ensureChallBanner();
  el.innerHTML =
    `<span class="chall-prog-name">${roundLyricOnly ? "sing a lyric line" : "name a title"}</span>` +
    `<span class="chall-prog-count">${score} / ${currentChallenge.target || 9}</span>`;
}
// Double Trouble: how many of the two needed songs have been named this page.
function renderMultiBanner() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "multi") return;
  const el = ensureChallBanner();
  const need = currentChallenge.need || 2;
  el.innerHTML =
    `<span class="chall-prog-name">name ${need} different songs</span>` +
    `<span class="chall-prog-count">${roundNamed.length} / ${need} this page · ${score} / ${currentChallenge.target || 8}</span>`;
}
// Devil's Path: distort the prompt word display-only (matching reads currentWord from
// state, never the DOM), at a FIXED effect for the run — unlike Word Games' escalating tiers.
function renderDevilFx(wrap, word, fx) {
  let text = fx === "scramble" ? scrambleWord(word)
    : fx === "drop" ? dropLetters(word)
    : word.split("").reverse().join("");
  if (text === word && word.length > 1) text = word.split("").reverse().join("");  // never show un-warped
  wrap.dataset.fx = fx === "drop" ? "2" : fx === "reverse" ? "3" : "1";
  $("wordDisplay").innerHTML = text.split("").map((ch) => `<span class="fx-ch">${escapeHtml(ch)}</span>`).join("");
}
// Devil's Path: the running score + every curse currently in effect, in the shared banner.
function renderDevilBanner() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "devil") return;
  const el = ensureChallBanner();
  const parts = [];
  if (extraSecondsPerRound < 0) parts.push(`${extraSecondsPerRound}s`);
  if (devilDropOff) parts.push("no suggestions");
  if (devilVanish) parts.push("vanishing");
  if (devilFx) parts.push(devilFx === "scramble" ? "scrambled" : devilFx === "drop" ? "redacted" : "reversed");
  if (devilNoTitle) parts.push("not in title");
  if (devilShortOnly) parts.push("short titles");
  devilBannedAlbums.forEach((a) => parts.push(`no ${a}`));
  if (devilBannedInitials.length) parts.push(`no ${devilBannedInitials.join("/")}`);
  if (devilPoolHard) parts.push("rarer words");
  el.innerHTML =
    `<span class="chall-prog-name">devil's path · ${score} / ${currentChallenge.target || 9}</span>` +
    (parts.length
      ? `<span class="chall-prog-count">${parts.map(escapeHtml).join(" · ")}</span>`
      : `<span class="chall-prog-count">no curses… yet</span>`);
}

// Shrinking Timer: this round's clock, shrinking linearly from ACCEL_FROM (round 1)
// down to ACCEL_TO (the final round). Per-round, applied via roundSecondsOverride and
// read by baseSeconds(); the shared MODES object is never touched.
const ACCEL_FROM = 16, ACCEL_TO = 5;
function accelSeconds(r) {
  const span = TOTAL_ROUNDS - 1;
  const t = span > 0 ? Math.min(1, Math.max(0, (r - 1) / span)) : 1;
  return Math.max(ACCEL_TO, Math.round(ACCEL_FROM - t * (ACCEL_FROM - ACCEL_TO)));
}
function renderAccelBanner() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "accelerate") return;
  const el = ensureChallBanner();
  el.innerHTML =
    `<span class="chall-prog-name">shrinking clock</span>` +
    `<span class="chall-prog-count">${accelSeconds(round)}s this page</span>`;
}
// Title...? / Short n' Sweet: a fixed reminder of the standing title rule.
function renderTitleRuleBanner() {
  if (gameType !== "challenge" || !currentChallenge) return;
  const el = ensureChallBanner();
  const msg = currentChallenge.rule === "titleHas"
    ? "the word must be in the title"
    : "one- or two-word titles only";
  el.innerHTML = `<span class="chall-prog-name">${msg}</span>`;
}
// Wrapped Like A Chain: chain length so far + the letter the next title must start with.
function renderChainBanner() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "chain") return;
  const el = ensureChallBanner();
  const target = currentChallenge.target || 8;
  const link = chainLetter ? `start with <b>${escapeHtml(chainLetter)}</b>` : "start anywhere";
  el.innerHTML =
    `<span class="chall-prog-name">chain ${score} / ${target}</span>` +
    `<span class="chall-prog-count">${link}</span>`;
}
// On Tour!: tonight's album (in its colour) + which stop on the setlist this is.
function renderTourBanner() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "setlist") return;
  const el = ensureChallBanner();
  const album = tourSetlist[round - 1] || "";
  const col = (album && albumColor(album)) || "var(--ink-soft)";
  el.innerHTML =
    `<span class="chall-prog-name" style="color:${col}">${escapeHtml(album)}</span>` +
    `<span class="chall-prog-count">stop ${Math.min(round, TOTAL_ROUNDS)} / ${TOTAL_ROUNDS}</span>`;
}
// It's A Clock!: the shared clock's current reading + the per-correct bonus.
function renderComboBanner() {
  if (!comboRuleActive()) return;
  const el = ensureChallBanner();
  el.innerHTML =
    `<span class="chall-prog-name">shared clock</span>` +
    `<span class="chall-prog-count">${Math.max(0, comboClock).toFixed(0)}s · +${COMBO_BONUS}s per correct</span>`;
}

// The shared challenge-banner element above the word (reused across rules; cleaned
// up by resetRunState, which removes #challBanner between runs).
function ensureChallBanner() {
  let el = $("challBanner");
  if (!el) {
    el = document.createElement("div");
    el.id = "challBanner";
    el.className = "chall-banner";
    const anchor = document.querySelector("#screen-game .word-label");
    anchor.parentNode.insertBefore(el, anchor);
  }
  return el;
}

// Deep Cut: the album you've pulled the most correct songs from so far (the one the
// win check rewards), with a 5-pip tally in that album's colour. Live — re-rendered
// each round and the moment a correct answer lands.
function deepCutLeader() {
  const counts = {};
  let album = null, best = 0;
  roundResults.forEach((ok, i) => {
    if (!ok) return;
    const a = roundAlbums[i];
    if (!a || (currentChallenge.album && a !== currentChallenge.album)) return;
    counts[a] = (counts[a] || 0) + 1;
    if (counts[a] > best) { best = counts[a]; album = a; }
  });
  return { album, count: best };
}
function renderDeepCutCounter() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "album5") return;
  const el = ensureChallBanner();
  const { album, count } = deepCutLeader();
  const target = 5;
  const col = (album && albumColor(album)) || "var(--ink-soft)";
  const label = album || "your best album";
  let pips = "";
  for (let i = 0; i < target; i++) {
    pips += `<span class="chall-pip${i < count ? " on" : ""}" style="${i < count ? `background:${col};border-color:${col}` : ""}"></span>`;
  }
  el.innerHTML =
    `<span class="chall-prog-name" style="color:${col}">${escapeHtml(label)}</span>` +
    `<span class="chall-pips">${pips}</span>` +
    `<span class="chall-prog-count">${count} / ${target}</span>`;
}

// One Of A Kind: name the target song the player is hunting for, written as a
// persistent margin banner so the mission is explicit (not a hidden surprise word).
function renderNewSongBanner() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "newsong") return;
  const el = ensureChallBanner();
  if (!challengeTargetSong) { el.remove(); return; }
  const got = roundSongs.includes(challengeTargetSong.title);
  const col = albumColor(challengeTargetSong.album) || "var(--ink-soft)";
  const livesPips = `<span class="chall-pips" title="${newSongLives} guess` +
    `${newSongLives === 1 ? "" : "es"} left">` +
    Array.from({ length: NEW_SONG_LIVES }, (_, i) =>
      `<span class="chall-pip${i < newSongLives ? " filled" : ""}"></span>`).join("") +
    `</span>`;
  el.innerHTML = got
    ? `<span class="chall-banner-tag" style="border-color:${col};color:${col}">found</span> ` +
      `<span style="text-decoration:line-through;opacity:0.7">${escapeHtml(challengeTargetSong.title)}</span> ✓`
    : `<span class="chall-banner-tag">find</span> ` +
      `<span class="chall-prog-name" style="color:${col}">${escapeHtml(challengeTargetSong.title)}</span>` +
      livesPips;
}

// Revolving Door: how many words a single round will cycle through (one per rotateMs
// slot across the round's clock), e.g. 20s / 5s = 4.
function revolveSlots() {
  const ms = (currentChallenge && currentChallenge.rotateMs) || 5000;
  return Math.max(1, Math.ceil((currentMode.seconds * 1000) / ms));
}
// Revolving Door: a margin banner of one pip per word-slot, the current slot lit, so the
// player can see how many revolutions are left this page. Re-rendered on each swap.
function renderRevolveCounter() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "revolving") return;
  const el = ensureChallBanner();
  const slots = revolveSlots();
  let pips = "";
  for (let i = 0; i < slots; i++) {
    pips += `<span class="chall-pip${i === revolveIndex ? " on" : ""}"` +
      `${i === revolveIndex ? ` style="background:var(--ink-accent);border-color:var(--ink-accent)"` : ""}></span>`;
  }
  el.innerHTML =
    `<span class="chall-banner-tag">revolving</span> ` +
    `<span class="chall-pips">${pips}</span>` +
    `<span class="chall-prog-count">word ${Math.min(revolveIndex + 1, slots)} / ${slots}</span>`;
}

// Revolving Door: swap to a fresh word mid-round WITHOUT touching the round clock. Fired
// by the rotation interval every rotateMs. Re-derives the round's valid-answer set, hint
// song and rarity from the new word, clears any stale input/dropdown (the old word is gone),
// and animates the swap. Guarded so a stray late tick after an answer is a no-op.
function revolveWord() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "revolving") return;
  if (roundLocked) return;
  if (revolveIndex + 1 >= revolveSlots()) return;   // already on the last slot — keep it (round will time out)
  revolveIndex++;
  currentWord = pickWord();
  currentSongs = validSongs(currentWord, effectiveStrict(), effectiveNoTitle());
  roundHintSong = pickHintSong();

  const wrap = $("wordDisplay").parentNode;   // .word-wrap
  const rar = rarityTier(currentSongs.length);
  wrap.dataset.rarity = rar.name;
  wrap.style.setProperty("--rarity", rar.t);
  $("wordDisplay").textContent = currentWord;
  // re-fire the swap animation (motion-safe)
  wrap.classList.remove("revolve-in");
  if (!motionReduced()) { void wrap.offsetWidth; wrap.classList.add("revolve-in"); }

  const input = $("songInput");
  input.value = "";
  input.classList.remove("reject-pulse");
  hideDropdown();
  renderVerseMeter("");
  renderRevolveCounter();
  input.focus();
}

// Wildcard's rotating sub-constraints, rebuilt each round against the round's word /
// valid songs so every choice is guaranteed solvable (e.g. album-only only picks an
// album that actually appears in currentSongs). accepts(song) → false soft-rejects;
// display(wrap) layers a visual gimmick (reusing the vanish modifier).
function buildWildcardConstraints() {
  const rx = wordRegex(currentWord, false);
  const words = (s) => s.title.trim().split(/\s+/).length;
  const firstCh = (s) => ((s.title || "").toUpperCase().match(/[A-Z]/) || [""])[0];
  const isVowel = (c) => "AEIOU".includes(c);
  const albums = [...new Set(currentSongs.map((s) => s.album).filter(Boolean))];
  const album = albums.length ? shuffle(albums.slice())[0] : null;
  const cons = [
    { id: "oneword",   label: "only one-word titles",            accepts: (s) => words(s) === 1 },
    { id: "twoword",   label: "only two-word titles",            accepts: (s) => words(s) === 2 },
    { id: "long",      label: "only titles of 3+ words",         accepts: (s) => words(s) >= 3 },
    { id: "vowel",     label: "title must start with a vowel",   accepts: (s) => isVowel(firstCh(s)) },
    { id: "consonant", label: "title must start with a consonant", accepts: (s) => { const c = firstCh(s); return !!c && !isVowel(c); } },
    { id: "notitle",   label: "the word can't be in the title",  accepts: (s) => !rx.test(s.title) },
    { id: "titleword", label: "the word must be in the title",   accepts: (s) => rx.test(s.title) },
    { id: "vanish",    label: "the word vanishes",               accepts: null,
      display: (w) => { vanishTimer = setTimeout(() => w.classList.add("vanished"), 1500); } },
    { id: "scramble",  label: "the word is scrambled",           accepts: null,
      display: (w) => renderWordFx(w, currentWord, 1) },
  ];
  if (album) cons.push({ id: "album", label: `only from ${album}`, accepts: (s) => s.album === album });
  return cons;
}
// Pick this round's Wildcard rule (solvable, no immediate repeat), show its banner,
// and run any visual gimmick.
function applyWildcardRound(wrap) {
  const cons = buildWildcardConstraints();
  const usable = cons.filter((c) => !c.accepts || currentSongs.some(c.accepts));
  let pool = usable.filter((c) => c.id !== lastWildcardId);
  if (!pool.length) pool = usable.length ? usable : cons;
  roundWildcard = pool[Math.floor(Math.random() * pool.length)];
  lastWildcardId = roundWildcard.id;
  renderWildcardBanner(roundWildcard.label);
  // NOTE: the visual gimmick (vanish/scramble) is NOT run here — it's deferred to
  // beginRoundClock so its countdown doesn't burn behind the full-screen rule intro.
}
// The margin banner naming the current Wildcard rule (created lazily above the word).
function renderWildcardBanner(label) {
  ensureChallBanner().innerHTML = `<span class="chall-banner-tag">rule</span> ${escapeHtml(label)}`;
}
// Soft reject for an answer that breaks the round's Wildcard rule — no burned round,
// same flash vocabulary as the alphabetical / off-limits rejects.
function rejectWildcard(label) {
  softRejectFlash(`breaks the rule — <b>${escapeHtml(label)}</b>`);
}

// Word Games (escalating distortion). DISPLAY-ONLY — matching reads currentWord from
// state, never the DOM, so the warping never affects correctness. The level climbs by
// round; rendered once per round (stable, so a reflow won't re-shuffle).
function wordFxLevel(r) {
  if (r <= 3) return 1;   // scramble interior letters
  if (r <= 6) return 2;   // drop ~a third of the letters
  if (r <= 9) return 3;   // reverse
  return 4;               // scramble + drop + reverse + wobble
}
function scrambleWord(w) {
  if (w.length < 4) return w;                 // too short to disguise — leave it
  const interior = w.slice(1, -1);
  // Shuffle the interior, retrying so the result is never identical to the original
  // (a Fisher-Yates can legally produce the identity permutation, which read as "not
  // jumbled at all" — the bug). After a few tries, force a swap of two interior chars.
  for (let attempt = 0; attempt < 6; attempt++) {
    const a = interior.split("");
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    const out = a.join("");
    if (out !== interior) return w[0] + out + w[w.length - 1];
  }
  if (interior.length >= 2) {                 // last resort: swap first two interior chars
    const a = interior.split("");
    [a[0], a[1]] = [a[1], a[0]];
    return w[0] + a.join("") + w[w.length - 1];
  }
  return w;
}
function dropLetters(w) {
  // Eligible interior positions (skip first/last char and spaces). Drop ~a third,
  // but always at least one so the word is visibly altered (a 0-drop pass read as
  // "not jumbled" — the round-4 bug).
  const eligible = [];
  for (let i = 1; i < w.length - 1; i++) if (w[i] !== " ") eligible.push(i);
  if (!eligible.length) return w;
  const drop = new Set(eligible.filter(() => Math.random() < 0.35));
  if (!drop.size) drop.add(eligible[Math.floor(Math.random() * eligible.length)]);
  return w.split("").map((ch, i) => (drop.has(i) ? "_" : ch)).join("");
}
function renderWordFx(wrap, word, r) {
  const level = wordFxLevel(r);
  let text = word;
  if (level === 1) text = scrambleWord(word);
  else if (level === 2) text = dropLetters(word);
  else if (level === 3) text = word.split("").reverse().join("");
  else text = dropLetters(scrambleWord(word)).split("").reverse().join("");
  // Safety net: if a short word slipped through unchanged (e.g. a 3-letter word at the
  // scramble tier can't be shuffled), at least reverse it so it never shows un-warped.
  if (text === word && word.length > 1) text = word.split("").reverse().join("");
  wrap.dataset.fx = String(level);
  const wobble = level === 4 && !prefersReducedMotion();
  $("wordDisplay").innerHTML = text.split("").map((ch, i) => {
    const rot = wobble ? (((i * 37) % 11) - 5) : 0;   // deterministic small per-letter tilt
    const style = rot ? ` style="--fx-rot:${rot}deg"` : "";
    return `<span class="fx-ch"${style}>${escapeHtml(ch)}</span>`;
  }).join("");
}

// Did the finished run defeat the challenge?
function challengeWinCheck(c) {
  if (!c) return false;
  if (c.rule === "newsong") {
    return !!challengeTargetSong && roundSongs.includes(challengeTargetSong.title);
  }
  if (c.rule === "album5") {
    const counts = {};
    let best = 0;
    roundResults.forEach((ok, i) => {
      if (!ok) return;
      const a = roundAlbums[i];
      if (!a || (c.album && a !== c.album)) return;
      counts[a] = (counts[a] || 0) + 1;
      if (counts[a] > best) best = counts[a];
    });
    return best >= 5;
  }
  // Lyric Lover: recall a target number of word-perfect-or-better lines this run.
  if (c.rule === "verse") return gameVersePerfect >= (c.target || 4);
  // Score-target rules: vanishing / alphabetical / accelerate / titleHas / shorttitle /
  // chain (chain length == score) / setlist / combo (reach the target before the clock dies).
  return score >= (c.target || TOTAL_ROUNDS);
}

// Sandboxed results path for a challenge run (mirrors showDailyResult — no board,
// no stats; its own win panel). Reached only via endGame's challenge short-circuit.
function endChallenge() {
  const c = currentChallenge;
  challengeRunActive = false;   // run is over — let defeat/meta charms fire normally

  // Challenges count toward the GLOBAL/catalogue stores only — the chronological
  // history log, the lifetime catalogue tally (Songs/Words Discovered, Favourite,
  // Nemesis), and the cross-game lifetime metrics. They deliberately do NOT touch
  // any per-mode difficulty board (updateStats), personal records (insertRecord),
  // or play-count totals: a challenge bends the rules and borrows a mode, so folding
  // it into normal difficulty stats would pollute them. (devNoLog skips it all.)
  if (!devNoLog) {
    const runTime = currentMode.seconds > 0 ? gameTimeSum : null;
    appendHistory({
      s: score, c: score, n: roundResults.length,
      m: "chl-" + c.id, t: "challenge",
      d: new Date().toISOString(), tm: runTime,
      ...(verseBonus > 0 ? { v: verseBonus } : {}),
      ...(hintsUsed > 0 ? { h: 1 } : {}),
    });
    const tally = recordGameTally(roundResults.map((correct, i) => ({
      correct,
      title: roundSongs[i] || null,
      album: roundAlbums[i] || null,
      word: roundWords[i] || null,
    })));
    // "I Hate It Here" — every catalogue song answered correctly at least once.
    // challengeRunActive is already false above, so this unlock fires normally.
    if (allSongs.length && allSongs.every((s) => tally.songs[s.title])) unlock("i-hate-it-here");
    recordGameMetrics({
      rounds: roundResults.length, correct: score,
      timeSumMs: gameTimeSum * 1000, timedRounds: gameTimedRounds,
      fastestMs: gameFastestMs, lyricLines: lyricLineAnswers,
      versePerfect: gameVersePerfect, wholeVerses: gameWholeVerses, verseBonus,
      isDaily: false, dailyPerfect: false,
      isInfinite: false, timeouts: gameTimeouts,
    });
  }

  showScreen("results");
  $("resultBracelet").innerHTML = buildBraceletSVG(roundResults, 0, -1, roundAlbums,
    { colors: albumPalette(), hinted: roundHinted, verseTiers: roundVerseTier });
  $("finalScore").textContent = score;
  $("finalSub").textContent = "out of " + TOTAL_ROUNDS;
  $("keepGoingBtn").style.display = "none";
  $("namePrompt").style.display = "none";
  $("verseAnthology").style.display = "none";
  hideNewBestBanner();

  const won = challengeWinCheck(c);
  const firstTime = won ? markChallengeDefeated(c.id, score) : false;
  const rec = challengeRecord(c.id);

  document.querySelector("#screen-results .podium-title").textContent = c.name;
  const outOfGuesses = c.rule === "newsong" && challengeTargetSong && newSongLives <= 0;
  const status = won
    ? `<div class="chall-result-status win">challenge defeated!</div>`
    : outOfGuesses
      ? `<div class="chall-result-status">out of guesses — the song got away</div>`
      : `<div class="chall-result-status">not yet — ${escapeHtml(c.win)}</div>`;
  const tokenLine = firstTime ? `<div class="chall-result-token">🎟 +1 token earned</div>` : "";
  // Lyric Lover is judged on word-perfect recall, not the 0–13 score — surface that count.
  const verseLine = c.rule === "verse"
    ? `<div class="chall-result-meta">${gameVersePerfect} line${gameVersePerfect === 1 ? "" : "s"} recalled word-for-word</div>`
    : "";
  const meta = `<div class="chall-result-meta">${rec.attempts} attempt${rec.attempts === 1 ? "" : "s"}` +
    `${rec.best ? ` · best ${rec.best}/${TOTAL_ROUNDS}` : ""}</div>`;
  $("resultPodium").innerHTML = status + tokenLine + verseLine + meta +
    `<button id="backToChallenges" class="btn-ghost">back to challenges</button>`;
  $("backToChallenges").addEventListener("click", () => openChallenges("start"));

  renderResultRecap();   // surface any challenge achievements just earned
  if (won && score === TOTAL_ROUNDS) celebratePerfect();
}

// Sandboxed results path for an Album Focus run (mirrors endChallenge). Folds into the
// global catalogue stores only; the per-album board (beaten/perfected) is its own store.
function endAlbumFocus() {
  const album = focusAlbum, diff = focusDifficulty;
  const hintFree = hintsUsed === 0;
  let rec = albumFocusRecord(album);
  if (!devNoLog) {
    const runTime = currentMode.seconds > 0 ? gameTimeSum : null;
    appendHistory({
      s: score, c: score, n: roundResults.length,
      m: "af-" + album, t: "album",
      d: new Date().toISOString(), tm: runTime,
      ...(verseBonus > 0 ? { v: verseBonus } : {}),
      ...(hintsUsed > 0 ? { h: 1 } : {}),
    });
    const tally = recordGameTally(roundResults.map((correct, i) => ({
      correct,
      title: roundSongs[i] || null,
      album: roundAlbums[i] || null,
      word: roundWords[i] || null,
    })));
    if (allSongs.length && allSongs.every((s) => tally.songs[s.title])) unlock("i-hate-it-here");
    recordGameMetrics({
      rounds: roundResults.length, correct: score,
      timeSumMs: gameTimeSum * 1000, timedRounds: gameTimedRounds,
      fastestMs: gameFastestMs, lyricLines: lyricLineAnswers,
      versePerfect: gameVersePerfect, wholeVerses: gameWholeVerses, verseBonus,
      isDaily: false, dailyPerfect: false,
      isInfinite: false, timeouts: gameTimeouts,
    });
    // The board only counts hint-free runs toward beating/perfecting (mirrors the
    // "a hinted run can't set a personal best" rule); best score still updates.
    rec = recordAlbumFocusRun(album, score, diff, hintFree);
  }

  // Album Focus achievements (post-run, off the updated board — not sandbox-gated).
  const board = loadAlbumFocus();
  const beatenCount = STUDIO_ALBUMS.filter((a) => board[a] && board[a].beaten).length;
  const perfectedCount = STUDIO_ALBUMS.filter((a) => board[a] && board[a].perfected).length;
  if (rec.beaten) unlock("a-place-in-this-world");
  if (rec.perfected) unlock("gold-rush");
  if (beatenCount >= STUDIO_ALBUMS.length) unlock("change");
  if (perfectedCount >= STUDIO_ALBUMS.length) unlock("starlight");

  showScreen("results");
  $("resultBracelet").innerHTML = buildBraceletSVG(roundResults, 0, -1, roundAlbums,
    { colors: albumPalette(), hinted: roundHinted, verseTiers: roundVerseTier });
  $("finalScore").textContent = score;
  $("finalSub").textContent = "out of " + TOTAL_ROUNDS;
  $("keepGoingBtn").style.display = "none";
  $("namePrompt").style.display = "none";
  $("verseAnthology").style.display = "none";
  hideNewBestBanner();

  const beat = score >= ALBUM_FOCUS_TARGET;
  const perfect = score >= TOTAL_ROUNDS;
  document.querySelector("#screen-results .podium-title").textContent = album;
  let status;
  if (beat && hintFree) {
    status = perfect
      ? `<div class="chall-result-status win">perfect — album complete ★</div>`
      : `<div class="chall-result-status win">album beaten!</div>`;
  } else if (beat && !hintFree) {
    status = `<div class="chall-result-status">beaten — but hinted runs don't count toward completion</div>`;
  } else {
    status = `<div class="chall-result-status">not yet — score ${ALBUM_FOCUS_TARGET}/${TOTAL_ROUNDS} to beat it</div>`;
  }
  const diffLabel = (MODES[diff] && MODES[diff].label) || diff;
  const meta = `<div class="chall-result-meta">${escapeHtml(diffLabel)} · best ${rec.best}/${TOTAL_ROUNDS}` +
    ` · beaten ${beatenCount}/${STUDIO_ALBUMS.length}` +
    `${perfectedCount ? ` · perfected ${perfectedCount}/${STUDIO_ALBUMS.length}` : ""}</div>`;
  $("resultPodium").innerHTML = status + meta +
    `<button id="backToAlbumFocus" class="btn-ghost">back to album focus</button>`;
  $("backToAlbumFocus").addEventListener("click", () => openAlbumFocus("start"));

  renderResultRecap();   // surface any album-focus achievements just earned
  if (perfect) celebratePerfect();
}

// Adaptive results: sandboxed like Album Focus. Folds into the lifetime catalogue
// tally + cross-game metrics (real play), but its own board is the PEAK LEVEL reached,
// never the difficulty records. The headline is "how high you climbed", not a 0-13 score.
function endAdaptive() {
  const peak = adaptivePeak;
  const name = ADAPTIVE_LEVELS[peak] || "";
  const reachedTop = peak >= ADAPT_MAX_LEVEL;
  const prev = adaptiveRecord();                       // before this run folds in
  const isBest = !prev.played || peak > prev.bestPeak || (peak === prev.bestPeak && score > prev.bestScore);
  let rec = prev;
  if (!devNoLog) {
    const runTime = currentMode.seconds > 0 ? gameTimeSum : null;
    appendHistory({
      s: peak, c: score, n: roundResults.length,
      m: "adaptive", t: "adaptive",
      d: new Date().toISOString(), tm: runTime,
      ...(verseBonus > 0 ? { v: verseBonus } : {}),
      ...(hintsUsed > 0 ? { h: 1 } : {}),
    });
    const tally = recordGameTally(roundResults.map((correct, i) => ({
      correct,
      title: roundSongs[i] || null,
      album: roundAlbums[i] || null,
      word: roundWords[i] || null,
    })));
    if (allSongs.length && allSongs.every((s) => tally.songs[s.title])) unlock("i-hate-it-here");
    recordGameMetrics({
      rounds: roundResults.length, correct: score,
      timeSumMs: gameTimeSum * 1000, timedRounds: gameTimedRounds,
      fastestMs: gameFastestMs, lyricLines: lyricLineAnswers,
      versePerfect: gameVersePerfect, wholeVerses: gameWholeVerses, verseBonus,
      isDaily: false, dailyPerfect: false,
      isInfinite: false, timeouts: gameTimeouts,
    });
    // Stay Stay Stay: reached the Rarest tier and finished there without ever slipping off it.
    if (adaptiveReachedTop && adaptiveHeldTop && adaptiveLevel >= ADAPT_MAX_LEVEL) unlock("stay-stay-stay");
    rec = recordAdaptiveRun(peak, score, todayKey());
  }

  showScreen("results");
  $("resultBracelet").innerHTML = buildBraceletSVG(roundResults, 0, -1, roundAlbums,
    { colors: albumPalette(), hinted: roundHinted, verseTiers: roundVerseTier });
  $("finalScore").textContent = "L" + peak;
  $("finalSub").textContent = name + " · " + score + "/" + TOTAL_ROUNDS + " correct";
  $("keepGoingBtn").style.display = "none";
  $("namePrompt").style.display = "none";
  hideNewBestBanner();
  renderVerseAnthology();

  document.querySelector("#screen-results .podium-title").textContent = "Adaptive";
  const status = reachedTop
    ? `<div class="chall-result-status win">you climbed all the way to ${escapeHtml(name)} ★</div>`
    : `<div class="chall-result-status">peaked at level ${peak} · ${escapeHtml(name)}</div>`;
  const meta = `<div class="chall-result-meta">highest level reached · best L${rec.bestPeak} ${escapeHtml(ADAPTIVE_LEVELS[rec.bestPeak] || "")}</div>`;
  $("resultPodium").innerHTML = status + meta;
  if (isBest && !devNoLog) showNewBestBanner("a new height ★ · level " + peak + " " + name);

  renderResultRecap();
}

// Re-render the results screen from a previously saved daily result (the
// already-played path). Reuses the regular results layout + daily board + share.
function showDailyResult(data, dateStr) {
  gameType = "daily";
  currentMode = MODES.medium;
  roundResults = data.roundResults;
  roundAlbums = data.roundAlbums;
  score = data.score;
  dailyShareTime = typeof data.tm === "number" ? data.tm : null;   // restore completion time for the share (older saves lack it)
  showScreen("results");
  $("resultBracelet").innerHTML = buildBraceletSVG(roundResults, 0, -1, roundAlbums, { colors: albumPalette() });
  $("finalScore").textContent = settings.hideDailyScore ? "?" : score;
  $("finalSub").textContent = "out of " + TOTAL_ROUNDS;
  $("keepGoingBtn").style.display = "none";
  $("resultAchievements").style.display = "none";
  $("verseAnthology").style.display = "none";   // saved daily snapshot has no recalled-lines list
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
  // Active solving time (sum of per-round answer seconds, capped per round) rides on the
  // score line — a fair, comparable number since everyone gets the same words. m:ss so
  // pasted results sort and compare cleanly.
  const time = fmtTime(dailyShareTime);
  const scoreLine = time ? `${score}/${TOTAL_ROUNDS} · ${time}` : `${score}/${TOTAL_ROUNDS}`;
  return `Swift Song Association 🎵\nDaily Challenge · ${label}\n${emoji}\n${scoreLine}`;
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
  // Some challenges force the word so the round is winnable within their rule (and push
  // it onto usedWords themselves). A null return means "fall back to the normal pool".
  if (gameType === "challenge" && currentChallenge) {
    if (currentChallenge.rule === "setlist") { const w = pickTourWord(); if (w) return w; }
    if (currentChallenge.rule === "chain") { const w = pickChainWord(); if (w) return w; }
  }
  // Album Focus draws only words with a valid in-album answer (honouring the difficulty's
  // title rule), so every round is winnable from the chosen album.
  if (gameType === "album" && focusAlbum) { const w = pickAlbumWord(); if (w) return w; }
  // Title...? draws only from words that appear in some song title, so each round is winnable.
  let bucket;
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "titleHas"
      && titleWordList.length) {
    bucket = titleWordList;
  } else if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "shorttitle"
      && shortTitleWordList.length) {
    // Short n' Sweet: keep the easy-pool feel but guarantee a ≤2-word title exists.
    const poolBucket = wordBuckets[effectivePool()] || playableWords;
    const set = new Set(shortTitleWordList);
    const narrowed = poolBucket.filter((w) => set.has(w));
    bucket = narrowed.length >= TOTAL_ROUNDS ? narrowed : shortTitleWordList;
  } else {
    bucket = wordBuckets[effectivePool()] || playableWords;
  }
  // No-repeat within a game: exclude every word already used this run. Buckets
  // are guaranteed ≥ TOTAL_ROUNDS words (see buildWordBuckets' MIN), so the pool
  // only empties on a degenerate list — fall back to the full bucket if so.
  const pool = bucket.filter((w) => !usedWords.includes(w));
  let choices = pool.length ? pool : bucket;
  // Double Trouble: a page is only winnable if the word has at least `need` valid
  // songs (after the no-title rule). Keep only such words; fall back if none remain.
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "multi") {
    const need = currentChallenge.need || 2;
    const enough = choices.filter((w) => validSongs(w, effectiveStrict(), effectiveNoTitle()).length >= need);
    if (enough.length) choices = enough;
  }
  // Switch-Up: on a lyric page, avoid words that sit in any song title — singing a line
  // shouldn't have to compete with an obvious title answer for the same word. The page type
  // is decided before this draw (see advanceRound). Fall back if none survive.
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "switchup" && roundLyricOnly) {
    const noTitleWords = choices.filter((w) => titleSongsForWord(w, effectiveStrict()).length === 0);
    if (noTitleWords.length) choices = noTitleWords;
  }
  // Devil's Path: keep only words that still have a valid answer after the active curses
  // (banned albums / forbidden initials / short-title-only). Fall back if none survive.
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "devil") {
    const winnable = choices.filter((w) =>
      validSongs(w, effectiveStrict(), effectiveNoTitle()).some(devilAllowsSong));
    if (winnable.length) choices = winnable;
  }
  const rng = dailyRng || Math.random;
  const word = choices[Math.floor(rng() * choices.length)];
  usedWords.push(word);
  return word;
}

// Album Focus: a word whose chosen-album valid set is non-empty under the active difficulty's
// title rule. Start from the album's playable words intersected with the rarity bucket (so the
// difficulty still shapes the pool), falling back to the full album list when that's too thin
// (the buildWordBuckets safe() pattern). Then verify an in-album song survives effectiveNoTitle
// (Hard can title-filter a word's only album song) — skip the word if not. null → normal pool.
function pickAlbumWord() {
  const albumWords = albumWordMap[focusAlbum] || [];
  if (!albumWords.length) return null;
  const bucketSet = new Set(wordBuckets[effectivePool()] || playableWords);
  const narrowed = albumWords.filter((w) => bucketSet.has(w));
  const base = narrowed.length >= TOTAL_ROUNDS ? narrowed : albumWords;
  const fresh = shuffle(base.filter((w) => !usedWords.includes(w)));
  const pool = fresh.length ? fresh : shuffle(base.slice());
  for (const w of pool) {
    if (validSongs(w, effectiveStrict(), effectiveNoTitle()).some((s) => s.album === focusAlbum)) {
      usedWords.push(w);
      return w;
    }
  }
  return null;   // degenerate — let the normal pool path run
}

function nextRound() {
  // Choose Your Path / Devil's Path: pause at a fork (after rounds 4 / 8) to pick a
  // perk (good) or a curse (evil) before advancing. The overlay resumes nextRound
  // once a card is chosen.
  if (gameType === "challenge" && currentChallenge
      && (currentChallenge.rule === "path" || currentChallenge.rule === "devil")
      && (currentChallenge.forks || []).includes(round) && !pathForksTaken.includes(round)) {
    (currentChallenge.rule === "devil" ? showDevilFork : showPathFork)(round);
    return;
  }
  if (isGameOver()) { endGame(); return; }
  // First round (from the start screen) advances instantly; so do reduced motion,
  // "instant" animation speed, and the page-turn setting being off.
  if (round === 0 || motionReduced() || animInstant() || !settings.pageTurn) {
    advanceRound();
    beginRoundClock();
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
  // Decorative clone of the game card — hide from the a11y tree so the duplicated
  // #wordDisplay/#feedback live regions in it aren't re-announced during the page turn.
  flip.setAttribute("aria-hidden", "true");
  flip.classList.add("page-flip-sheet");
  flip.style.top = card.offsetTop + "px";
  flip.style.left = card.offsetLeft + "px";
  flip.style.width = card.offsetWidth + "px";
  const shade = document.createElement("div");
  shade.className = "flip-shade";
  flip.appendChild(shade);
  card.parentNode.appendChild(flip);

  advanceRound();             // the next page is now in place under the flipping sheet
  // Mount this round's curtain (Wildcard's per-round rule) NOW, hidden beneath the flip
  // sheet, so the new word is already covered the instant the sheet rotates away (no
  // flash of the round). Once-per-run intros only show on round 1, which has no flip.
  const preHTML = roundCurtainHTML();
  // Mount only the first card under the flip (round-1 multi-card queues never take the
  // page-flip path); beginRoundClock re-derives the full queue and reuses this mount.
  if (preHTML) mountCurtain(Array.isArray(preHTML) ? preHTML[0] : preHTML);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    flip.remove();
    beginRoundClock();        // start the clock only after the page has turned
  };
  // Primary trigger is a timeout matched to the 0.5s flip (CSS .page-flip-sheet),
  // with animationend as a fast-path; whichever lands first wins.
  flip.addEventListener("animationend", (e) => { if (e.target === flip) finish(); });
  setTimeout(finish, 500 * animScale() || 250);
}

// Whether this round wants the Wildcard rule curtain (per-round, so it pre-mounts under
// the page-flip — unlike the once-per-run intros, which only show on round 1).
function isWildcardRound() {
  return gameType === "challenge" && currentChallenge
    && currentChallenge.rule === "wildcard" && !!roundWildcard;
}

// The inner card markup for a curtain. `o.headline` is the big handwritten line; the
// optional `o.sub` is trusted HTML (callers build it with escaped pieces) so it can carry
// album-colour spans / bold.
function curtainCardHTML(o) {
  const ruleStyle = o.headlineColor ? ` style="color:${o.headlineColor}"` : "";
  return `<div class="chall-curtain-card">` +
    `<div class="chall-curtain-kicker">${escapeHtml(o.kicker)}</div>` +
    `<div class="chall-curtain-tag">${escapeHtml(o.tag)}</div>` +
    `<div class="chall-curtain-rule"${ruleStyle}>${escapeHtml(o.headline)}</div>` +
    (o.sub ? `<div class="chall-curtain-sub">${o.sub}</div>` : "") +
    `<div class="chall-curtain-cue">${escapeHtml(o.cue || "the word is coming…")}</div>` +
    (o.button ? `<button type="button" class="chall-curtain-next">${escapeHtml(o.button)}</button>` : "") +
    `</div>`;
}

// The per-page Switch-Up curtain card — announces whether this page wants a title or a
// sung lyric line. Shown on every page (and, on round 1, right after the rules intro).
function switchPageCardHTML() {
  return curtainCardHTML({ kicker: `page ${round} · switch-up`, tag: "this page",
    headline: roundLyricOnly ? "sing me a line" : "name the title",
    sub: roundLyricOnly
      ? "type a real lyric line — a title won't count"
      : "name any song that uses the word" });
}

// The curtain content for THIS round: null for no curtain, a single card's HTML, or an
// array of cards shown in sequence (Switch-Up's round 1 = rules intro then page type):
//  • EVERY challenge — round 1 only, a "here's what you're doing" intro (challengeIntroHTML).
//  • Wildcard — every later round, naming the active rule.
//  • On Tour! — every later round, announcing tonight's album.
function roundCurtainHTML() {
  if (gameType === "adaptive") return adaptiveCurtainHTML();
  if (gameType !== "challenge" || !currentChallenge) return null;
  const c = currentChallenge;
  // Round 1 of any challenge opens with an explanatory intro (button-gated — see
  // beginRoundClock). The per-round curtains below take over from round 2 onward.
  if (round === 1) {
    const intro = challengeIntroHTML(c);
    // Switch-Up: follow the rules intro with the page-type card, so the very first page
    // also says whether it wants a title or a lyric (always a title here — round 1 is a
    // gentle open). A queue the curtain player shows in sequence.
    if (c.rule === "switchup") return [intro, switchPageCardHTML()];
    return intro;
  }
  if (c.rule === "wildcard" && roundWildcard) {
    return curtainCardHTML({ kicker: `page ${round} · wildcard`, tag: "the rule",
      headline: roundWildcard.label });
  }
  // Switch-Up — every page flashes whether it wants a title or a sung lyric line.
  if (c.rule === "switchup") return switchPageCardHTML();
  // On Tour! — every page announces tonight's album (the only acceptable source).
  if (c.rule === "setlist") {
    const album = tourSetlist[round - 1] || "";
    const col = (album && albumColor(album)) || "var(--ink-soft)";
    return curtainCardHTML({ kicker: `stop ${Math.min(round, TOTAL_ROUNDS)} / ${TOTAL_ROUNDS} · on tour`,
      tag: "tonight's album", headline: album || "any album", headlineColor: col,
      sub: album ? `name a song from <b style="color:${col}">${escapeHtml(album)}</b>` : "" });
  }
  return null;
}

// Adaptive's curtain: shown only on the round where the suggestions dropdown flips state
// (off as you climb into the rarest tiers, back on if you slip below them). Acknowledged
// with a tap so the rule change is never a silent surprise. No change means no curtain.
function adaptiveCurtainHTML() {
  const live = effectiveDropdown();
  if (live === adaptiveDropAnnounced) return null;
  const name = (ADAPTIVE_LEVELS[adaptiveLevel] || "").toLowerCase();
  if (!live) {
    return curtainCardHTML({ kicker: `level ${adaptiveLevel} · ${name}`, tag: "suggestions off",
      headline: "type the full title now",
      sub: "these words are rare enough that the dropdown comes down. Type the whole title, or sing a real lyric line.",
      cue: "you know these", button: "got it" });
  }
  return curtainCardHTML({ kicker: `level ${adaptiveLevel} · ${name}`, tag: "suggestions back",
    headline: "the dropdown returns",
    sub: "back to a gentler tier. Pick from the suggestions again, or sing a line.",
    cue: "carry on", button: "got it" });
}

// The round-1 intro curtain for a challenge: names it, restates the rule + win condition,
// and waits for a "let's go" tap before the first word and the clock. A couple of rules
// carry extra setup that has to be shown up front (the song to smuggle in / the perk forks),
// so they get bespoke copy; everything else uses the registry's `desc` + `win`.
function challengeIntroHTML(c) {
  // One Of A Kind — reveal the specific song to slip in on a fitting page.
  if (c.rule === "newsong" && challengeTargetSong) {
    const col = albumColor(challengeTargetSong.album) || "var(--ink-soft)";
    return curtainCardHTML({ kicker: "one of a kind", tag: "find this song",
      headline: challengeTargetSong.title, headlineColor: col,
      sub: challengeTargetSong.album
        ? `from <b style="color:${col}">${escapeHtml(challengeTargetSong.album)}</b> — it's hiding somewhere in the next 13 pages`
        : `it's hiding somewhere in the next 13 pages`,
      cue: `name it on the right page — you get ${NEW_SONG_LIVES} guesses`, button: "start the hunt" });
  }
  // Choose Your Path — explain the perk forks.
  if (c.rule === "path") {
    const forks = (c.forks || []).map((f) => `<b>${f}</b>`).join(" & ");
    return curtainCardHTML({ kicker: "choose your path", tag: "how it works",
      headline: "forge your own run",
      sub: `clear pages to reach <b>${c.target}/13</b>` +
        (forks ? ` — and at pages ${forks} you'll pick a perk for the rest of the way` : ""),
      cue: "choose wisely", button: "let's go" });
  }
  // Devil's Path — warn that the forks hand you curses, not perks.
  if (c.rule === "devil") {
    const forks = (c.forks || []).map((f) => `<b>${f}</b>`).join(" & ");
    return curtainCardHTML({ kicker: "devil's path", tag: "the bargain",
      headline: "choose your curses",
      sub: `reach <b>${c.target}/13</b>` +
        (forks ? ` — but at pages ${forks} you must take the lesser of two evils` : ""),
      cue: "no way out but through", button: "make the deal" });
  }
  // Every other challenge — name it, restate the rule and the win condition.
  return curtainCardHTML({ kicker: "challenge", tag: "the rule", headline: c.name,
    sub: `${escapeHtml(c.desc)}<span class="chall-curtain-win">${escapeHtml(c.win)}</span>`,
    cue: "ready when you are", button: "let's go" });
}

let curtainTimers = [];
// Tear down any live challenge curtain + its timers (called on quit/reset so an abandoned
// run never leaves the curtain up or fires a stale onDone).
function clearCurtain() {
  curtainTimers.forEach(clearTimeout);
  curtainTimers = [];
  const ov = document.querySelector(".chall-curtain");
  if (ov) ov.remove();
}

// Build the challenge curtain over the game card (idempotent — reuses an already mounted
// one). The curtain is OPAQUE from its first painted frame (no fade-in), so the round
// beneath it is never glimpsed; only the card's own contents animate in. In the page-turn
// path this is mounted UNDER the flip sheet so the new word is already covered when the
// sheet rotates away.
function mountCurtain(innerHTML) {
  let ov = document.querySelector(".chall-curtain");
  if (ov) return ov;
  ov = document.createElement("div");
  ov.className = "chall-curtain";
  ov.innerHTML = innerHTML;
  $("screen-game").appendChild(ov);
  return ov;
}

// Gate between a round being set up and its clock starting. When the round has a curtain
// (see roundCurtainHTML), hold the already-mounted curtain a beat — announcing the rule /
// the target song / how the run works — then lift it to reveal the word. onDone (the
// Wildcard visual gimmick + the timer) fires only once the curtain is gone, so none of the
// clock is spent reading it. Tap to skip ahead. Reduced motion shows it briefly without
// animation. Every other path starts the clock immediately.
function beginRoundClock() {
  let queue = roundCurtainHTML();
  // Adaptive: remember the dropdown state we've now surfaced, so the curtain only fires
  // again on the next genuine flip. Committed after roundCurtainHTML so the pre-flip mount
  // (nextRound) and this call agree on the same round's curtain.
  if (gameType === "adaptive") adaptiveDropAnnounced = effectiveDropdown();
  const wrap = $("wordDisplay").parentNode;
  const beginTimedRoundEffects = () => {
    if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "vanishing") {
      clearTimeout(vanishTimer);
      const ms = currentChallenge.revealMs || 1500;
      vanishTimer = setTimeout(() => { wrap.classList.add("vanished"); }, ms);
    }
  };
  if (!queue) { beginTimedRoundEffects(); startTimer(); return; }
  if (!Array.isArray(queue)) queue = [queue];
  showTimerFull();   // pin the clock at a paused full bar beneath the curtain — no leftover time shows through the lift
  const onDone = () => {
    beginTimedRoundEffects();
    if (isWildcardRound() && roundWildcard.display) roundWildcard.display(wrap);
    startTimer();
  };
  const reduced = motionReduced();
  let i = 0;
  // Show queue[i]. Acknowledging a card either swaps in the next one (the overlay stays
  // opaque, so the word never flashes between cards) or, on the last card, lifts the whole
  // curtain to reveal the word and start the clock.
  const showCard = () => {
    const html = queue[i];
    const last = i === queue.length - 1;
    // The first card is usually pre-mounted under the page-flip sheet (nextRound) already
    // showing this same html — reuse it untouched (no needless re-animation on reveal). Only
    // a later card in the queue swaps fresh HTML into the same opaque overlay.
    let ov = document.querySelector(".chall-curtain");
    if (ov) {
      ov.classList.remove("swapping");
      if (i > 0 || !ov.querySelector(".chall-curtain-card")) ov.innerHTML = html;
    } else ov = mountCurtain(html);
    let acted = false;
    const next = () => {
      if (acted) return;
      acted = true;
      i++;
      if (last) {
        ov.classList.add("leaving");
        curtainTimers.push(setTimeout(() => { clearCurtain(); onDone(); }, reduced ? 0 : 360));
      } else if (reduced) {
        showCard();
      } else {
        // animate the current card out (overlay stays opaque), then drop the next one in
        ov.classList.add("swapping");
        curtainTimers.push(setTimeout(showCard, 240));
      }
    };
    const nextBtn = ov.querySelector(".chall-curtain-next");
    if (nextBtn) {
      // Button-gated cards (every challenge's round-1 intro; Adaptive's suggestions-toggle
      // notice) wait for an explicit tap — the whole-overlay tap is intentionally NOT wired
      // so a stray click can't skip the notice unread.
      nextBtn.addEventListener("click", next);
    } else {
      // Auto-lifting cards (per-page Wildcard / Switch-Up): advance after a beat, tap
      // anywhere to skip ahead.
      ov.addEventListener("click", next);
      curtainTimers.push(setTimeout(next, reduced ? 1100 : 1750));
    }
  };
  showCard();
}

// Choose Your Path perk registry. Each perk's apply() mutates run state (time/swaps/
// mulligans/reveals/pool/title/calm); at a fork the player is offered a random TWO of
// the perks they haven't already taken, and picks one. 13 perks total, deliberately
// spanning time, retries, reveals, and rule-relaxers so the two on offer feel distinct.
const PERKS = [
  { id: "slow",     icon: "+2s",  name: "Slow Down Time", desc: "two extra seconds on every remaining word", apply: () => { extraSecondsPerRound += 2; } },
  { id: "encore",   icon: "+4s",  name: "Encore",          desc: "four extra seconds on every remaining word", apply: () => { extraSecondsPerRound += 4; } },
  { id: "swap",     icon: "↻",    name: "Word Swap",       desc: "swap one word you don't know for a fresh one", apply: () => { skipTokens += 1; } },
  { id: "doovers",  icon: "↻↻",   name: "Do-Overs",        desc: "swap two words you don't know for fresh ones", apply: () => { skipTokens += 2; } },
  { id: "second",   icon: "♡",    name: "Second Chance",   desc: "a wrong answer can be retried once", apply: () => { pathMulligans += 1; } },
  { id: "ninelives", icon: "♡♡",  name: "Nine Lives",      desc: "two wrong answers can be retried", apply: () => { pathMulligans += 2; } },
  { id: "openbook", icon: "A·",   name: "Open Book",       desc: "see the first letter of a song that fits, every round", apply: () => { perkReveals.add("letter"); } },
  { id: "liner",    icon: "♪",    name: "Liner Notes",     desc: "see the album of a song that fits, every round", apply: () => { perkReveals.add("album"); } },
  { id: "tongue",   icon: "№",    name: "Tip Of My Tongue", desc: "see how many songs fit, every round", apply: () => { perkReveals.add("count"); } },
  { id: "cheat",    icon: "👁",   name: "Cheat Sheet",     desc: "see one song that fits, every round", apply: () => { perkReveals.add("example"); } },
  { id: "crowd",    icon: "★",    name: "Crowd Pleaser",   desc: "the rest of the words come from popular songs", apply: () => { perkPoolOverride = "easy"; } },
  { id: "offrec",   icon: "✎",    name: "Off The Record",  desc: "the word is allowed to be in the title now", apply: () => { perkNoTitleOff = true; } },
  { id: "steady",   icon: "≈",    name: "Steady Hands",    desc: "the page stops shaking as the clock runs down", apply: () => { perkCalm = true; } },
];
const PERK_BY_ID = Object.fromEntries(PERKS.map((p) => [p.id, p]));

// Choose Your Path: a mid-run perk fork. Covers the answered page with a random two of
// the not-yet-taken perks; the pick applies a run-modifier for the rest of the run, then
// resumes the page-turn. No scoring change — the win is still the score target.
function showPathFork(forkRound) {
  if (document.querySelector(".chall-path-overlay")) return;   // never stack two forks
  // Offer two distinct perks the player hasn't taken yet (fall back to the full set if
  // somehow exhausted — there are 13, far more than the two forks need).
  let pool = PERKS.filter((p) => !perksTaken.includes(p.id));
  if (pool.length < 2) pool = PERKS.slice();
  const offer = shuffle(pool.slice()).slice(0, 2);

  const card = $("screen-game");
  const ov = document.createElement("div");
  ov.className = "chall-path-overlay";
  ov.innerHTML =
    `<div class="chall-path-panel">` +
    `<h3 class="chall-path-title">choose your path</h3>` +
    `<p class="chall-path-sub">page ${forkRound} cleared — pick a perk for the rest of the run</p>` +
    `<div class="chall-path-cards">` +
    offer.map((p) =>
      `<button class="chall-path-card" data-perk="${p.id}"><span class="cpc-icon">${escapeHtml(p.icon)}</span>` +
      `<span class="cpc-name">${escapeHtml(p.name)}</span><span class="cpc-desc">${escapeHtml(p.desc)}</span></button>`).join("") +
    `</div></div>`;
  card.appendChild(ov);
  ov.querySelectorAll("[data-perk]").forEach((b) => b.addEventListener("click", () => {
    const perk = PERK_BY_ID[b.dataset.perk];
    if (perk) { perk.apply(); perksTaken.push(perk.id); }
    pathForksTaken.push(forkRound);
    ov.remove();
    renderPathSkip();
    nextRound();   // fork is taken now — fall through to the normal advance
  }, { once: true }));
}

// Choose Your Path reveals (Open Book / Liner Notes / Tip Of My Tongue / Cheat Sheet):
// a non-scoring hint line in the shared banner, derived from a fitting song. Re-rendered
// each round; absent when no reveal perk is active.
function renderPerkReveals() {
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "path") return;
  if (!perkReveals.size) { const b = $("challBanner"); if (b) b.remove(); return; }
  const el = ensureChallBanner();
  if (!currentSongs.length) { el.innerHTML = `<span class="chall-banner-tag">help</span> no song fits — swap it`; return; }
  const sample = roundHintSong || currentSongs[0];
  const parts = [];
  if (perkReveals.has("count"))   parts.push(`${currentSongs.length} song${currentSongs.length === 1 ? "" : "s"} fit`);
  if (perkReveals.has("letter"))  parts.push(`starts with “${escapeHtml((sample.title.match(/[A-Za-z]/) || ["?"])[0].toUpperCase())}”`);
  if (perkReveals.has("album") && sample.album) {
    const col = albumColor(sample.album) || "var(--ink-soft)";
    parts.push(`from <span style="color:${col};font-weight:700">${escapeHtml(sample.album)}</span>`);
  }
  if (perkReveals.has("example")) parts.push(`e.g. <b>${escapeHtml(censor(sample.title))}</b>`);
  el.innerHTML = `<span class="chall-banner-tag">help</span> ${parts.join(" · ")}`;
}

// Choose Your Path: spend a Mulligan to swap this round's word for a fresh one —
// the round is NOT consumed (re-rolls in place with a new clock), so it's a true
// "I don't know this one" escape, not a forfeit.
function usePathSkip() {
  if (skipTokens <= 0 || roundLocked) return;
  skipTokens -= 1;
  round -= 1;            // advanceRound bumps it straight back to the same round number
  clearTimer();
  advanceRound();
  startTimer();
}

// Show/refresh the Mulligan button during a Choose Your Path run (only while swaps remain).
function renderPathSkip() {
  let btn = $("pathSkipBtn");
  const show = gameType === "challenge" && currentChallenge && currentChallenge.rule === "path" && skipTokens > 0;
  if (!show) { if (btn) btn.remove(); return; }
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "pathSkipBtn";
    btn.type = "button";
    btn.className = "path-skip-btn";
    btn.addEventListener("click", usePathSkip);
    const hintBtn = $("hintBtn");
    hintBtn.parentNode.insertBefore(btn, hintBtn);
  }
  btn.textContent = `↻ swap this word (${skipTokens} left)`;
}

/* ---------- Devil's Path: choose the lesser of two evils ---------- */
// A studio album that still has playable words and isn't already banned (nor reserved
// by the other card being offered at the same fork). null if none is available.
function pickDevilAlbum(exclude) {
  const banned = devilBannedAlbums.concat(exclude || []);
  const opts = STUDIO_ALBUMS.filter((a) => (albumWordMap[a] || []).length && !banned.includes(a));
  return opts.length ? shuffle(opts.slice())[0] : null;
}
// Whether a song clears the active answer-restriction curses (No Giveaways is handled
// upstream by effectiveNoTitle). Shared by advanceRound's narrowing, the dropdown gate,
// the per-answer soft-reject and pickWord's winnability guard.
function devilAllowsSong(song) {
  if (devilShortOnly && titleWordCount(song.title) > 2) return false;
  if (devilBannedAlbums.includes(song.album)) return false;
  if (devilBannedInitials.length && devilBannedInitials.includes(firstAlphaLetter(song.title))) return false;
  return true;
}
// Soft-reject a curse-breaking pick with a message naming the curse it broke.
function rejectDevil(song) {
  if (devilShortOnly && titleWordCount(song.title) > 2) {
    softRejectFlash(`too long — one- or two-word titles only`);
  } else if (devilBannedAlbums.includes(song.album)) {
    softRejectFlash(`<b>${escapeHtml(song.album)}</b> is off-limits`);
  } else {
    softRejectFlash(`no titles starting with <b>${escapeHtml(firstAlphaLetter(song.title))}</b>`);
  }
}

// The 13 curses, mirroring PERKS — but each is a handicap you're forced to accept.
// `build(reserved)` resolves any per-pick randomness (which album to ban) so the offered
// card can name specifics; it returns the display + an apply() that mutates run state,
// plus an optional `album` the fork reserves so two album-bans never collide.
const DEVIL_CURSES = [
  { id: "crunch",  build: () => ({ icon: "−2s", name: "Time Crunch", desc: "two fewer seconds on every remaining page", apply: () => { extraSecondsPerRound -= 2; } }) },
  { id: "drain",   build: () => ({ icon: "−4s", name: "Time Drain",  desc: "four fewer seconds on every remaining page", apply: () => { extraSecondsPerRound -= 4; } }) },
  { id: "dark",    build: () => ({ icon: "◐",   name: "In The Dark", desc: "no more suggestions for the rest of the run", apply: () => { devilDropOff = true; } }) },
  { id: "vanish",  build: () => ({ icon: "…",   name: "Disappearing Ink", desc: "the word fades away after a moment each page", apply: () => { devilVanish = true; } }) },
  { id: "scramble",build: () => ({ icon: "⤮",   name: "Word Salad",  desc: "the word's letters are scrambled each page", apply: () => { devilFx = "scramble"; } }) },
  { id: "drop",    build: () => ({ icon: "_",   name: "Redacted",    desc: "some of the word's letters go missing each page", apply: () => { devilFx = "drop"; } }) },
  { id: "reverse", build: () => ({ icon: "↔",   name: "Backwards",   desc: "the word is shown reversed each page", apply: () => { devilFx = "reverse"; } }) },
  { id: "notitle", build: () => ({ icon: "✎",   name: "No Giveaways", desc: "the word can no longer be in your answer's title", apply: () => { devilNoTitle = true; } }) },
  { id: "short",   build: () => ({ icon: "≤2",  name: "Keep It Short", desc: "only one- or two-word titles count", apply: () => { devilShortOnly = true; } }) },
  { id: "ban1",    build: (reserved) => { const a = pickDevilAlbum(reserved); return { icon: "⊘", name: "Off Limits", desc: a ? `no answers from ${a}` : "an album is off-limits", album: a, apply: () => { if (a) devilBannedAlbums.push(a); } }; } },
  { id: "ban2",    build: (reserved) => { const a = pickDevilAlbum(reserved); return { icon: "⊘", name: "Locked Out", desc: a ? `no answers from ${a}` : "an album is off-limits", album: a, apply: () => { if (a) devilBannedAlbums.push(a); } }; } },
  { id: "initials",build: () => ({ icon: "T/S", name: "Forbidden Letters", desc: "no title that starts with T or S", apply: () => { devilBannedInitials = ["T", "S"]; } }) },
  { id: "rarer",   build: () => ({ icon: "◆",   name: "Rarer Air",   desc: "the rest of the words get rarer", apply: () => { devilPoolHard = true; } }) },
];

// Devil's Path: a mid-run curse fork. Offers two not-yet-taken curses; the player MUST
// take one (no escape) — it applies a permanent handicap, then resumes the page-turn.
function showDevilFork(forkRound) {
  if (document.querySelector(".chall-path-overlay")) return;   // never stack two forks
  let pool = DEVIL_CURSES.filter((c) => !devilCursesTaken.includes(c.id));
  if (pool.length < 2) pool = DEVIL_CURSES.slice();
  const picks = shuffle(pool.slice()).slice(0, 2);
  const reserved = [];                          // albums claimed by an already-built card
  const offers = picks.map((c) => {
    const built = c.build(reserved);
    if (built.album) reserved.push(built.album);
    return built;
  });

  const ov = document.createElement("div");
  ov.className = "chall-path-overlay is-devil";
  ov.innerHTML =
    `<div class="chall-path-panel">` +
    `<h3 class="chall-path-title">the devil's bargain</h3>` +
    `<p class="chall-path-sub">page ${forkRound} cleared — take the lesser of two evils</p>` +
    `<div class="chall-path-cards">` +
    offers.map((o, i) =>
      `<button class="chall-path-card" data-i="${i}"><span class="cpc-icon">${escapeHtml(o.icon)}</span>` +
      `<span class="cpc-name">${escapeHtml(o.name)}</span><span class="cpc-desc">${escapeHtml(o.desc)}</span></button>`).join("") +
    `</div></div>`;
  $("screen-game").appendChild(ov);
  ov.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => {
    const o = offers[Number(b.dataset.i)];
    o.apply();
    devilCursesTaken.push(picks[Number(b.dataset.i)].id);
    pathForksTaken.push(forkRound);
    ov.remove();
    nextRound();                                // curse taken — fall through to the normal advance
  }, { once: true }));
}

// How rare the round's word is, from its number of valid answers. Returns a
// name (for data-rarity) and t in 0..1 (common→scarce) used to scale the
// highlighter swipe's weight, so rarer words *feel* rarer without touching the
// era engine's hue.
function rarityTier(n) {
  if (n >= 12) return { name: "common",   t: 0,    stamp: "" };
  if (n >= 6)  return { name: "uncommon", t: 0.4,  stamp: "uncommon" };
  if (n >= 3)  return { name: "rare",     t: 0.75, stamp: "rare find" };
  if (n >= 2)  return { name: "scarce",   t: 0.9,  stamp: "scarce" };
  // Lives in exactly one song — the rarest a prompt word can be.
  return { name: "singular", t: 1, stamp: "one of one" };
}

// The valid song this round's hints zoom in on. Prefer one whose lyrics hold the
// EXACT prompt word so the revealed line/affordance never leans on a looser stem
// variant ("babe" should point at a "babe" line, not a "baby" one).
function pickHintSong() {
  if (!currentSongs.length) return null;
  const exactRx = new RegExp("\\b" + escapeRegExp(currentWord) + "\\b", "i");
  const pool = currentSongs.filter((s) => exactRx.test(s.lyrics));
  const from = pool.length ? pool : currentSongs;
  return from[Math.floor(Math.random() * from.length)];
}

function advanceRound() {
  round++;
  roundLocked = false;
  justEarnedIndex = -1;
  // Switch-Up decides this page's answer type up front — BEFORE the word is drawn — so the
  // word pool can honour the "lyric pages avoid title words" rule (see pickWord). Round 1
  // always opens on a title, a gentle start. applyChallengeRound just renders the banner.
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "switchup")
    roundLyricOnly = round === 1 ? false : Math.random() < 0.5;
  // "Play this word" deep-link forces round 1's word; every later round draws normally.
  if (round === 1 && forcedFirstWord) {
    currentWord = forcedFirstWord;
    if (!usedWords.includes(currentWord)) usedWords.push(currentWord);
    forcedFirstWord = "";
  } else {
    currentWord = challengeForcedWord(round) || pickWord();   // One Of A Kind forces its target word
  }
  currentSongs = validSongs(currentWord, effectiveStrict(), effectiveNoTitle());
  currentLyricSongs = currentSongs;   // full lyrics-valid set (soft-rejects judge near-misses off this)
  // Title...?: flip the rule — the only valid answers are songs whose TITLE holds the word.
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "titleHas")
    currentSongs = titleSongsForWord(currentWord, effectiveStrict());
  // Short n' Sweet: only one- or two-word titles are acceptable answers — so the rarity
  // count, the suggestion pool and the example pool all reflect the SHORT-title subset.
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "shorttitle")
    currentSongs = currentSongs.filter((s) => titleWordCount(s.title) <= 2);
  // Wrapped Like A Chain: once a chain letter is set, only songs whose title starts with it
  // are acceptable — narrow the valid set so the rarity count and examples agree.
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "chain" && chainLetter)
    currentSongs = currentSongs.filter((s) => firstAlphaLetter(s.title) === chainLetter);
  // On Tour!: only songs from tonight's album are acceptable answers.
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "setlist")
    currentSongs = currentSongs.filter((s) => s.album === tourSetlist[round - 1]);
  // Album Focus: the only valid answers are songs from the chosen album.
  if (gameType === "album" && focusAlbum)
    currentSongs = currentSongs.filter((s) => s.album === focusAlbum);
  // Devil's Path: answer-restriction curses narrow the valid set so the rarity count,
  // examples and dropdown all reflect what the curses actually allow. (No Giveaways is
  // already folded in via effectiveNoTitle above.) currentLyricSongs keeps the broader
  // lyrics-valid set so a curse-breaking pick can be soft-rejected rather than scored wrong.
  if (gameType === "challenge" && currentChallenge && currentChallenge.rule === "devil")
    currentSongs = currentSongs.filter(devilAllowsSong);
  roundHintSong = pickHintSong();
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
  wrap.classList.remove("vanished");          // clear any prior round's vanish
  wrap.removeAttribute("data-fx");            // clear any prior round's Word Games distortion
  wrap.classList.remove("revolve-in");        // clear any prior round's revolve swap
  clearTimeout(vanishTimer);
  if (revolveId) { clearInterval(revolveId); revolveId = null; }   // stop the prior round's rotation
  revolveIndex = 0;                            // Revolving Door: this round's word is slot 0
  roundNamed = [];                             // Double Trouble: no songs named on the fresh page yet
  applyChallengeRound(wrap);                   // challenge per-round modifier (e.g. Vanishing Word)
  renderExcludedNote();
  $("feedback").innerHTML = "";
  $("playArea").style.display = "";
  renderBracelet();
  renderLives();
  renderAdaptiveGauge();
  const input = $("songInput");
  input.value = "";
  input.disabled = false;
  input.classList.remove("reject-pulse");
  clearTimeout(rejectFlashTimer);
  $("rejectFlash").classList.remove("show");
  hideDropdown();
  renderVerseMeter("");                 // reset the live verse gauge for the new round
  input.focus();

  resetTension();
  renderHintAffordance();
  renderPathSkip();
  runRoundEggs();
  // Note: the timer is started by the caller (nextRound) — for a page turn it
  // only starts once the flip finishes, so no time is lost during the animation.
}

// The base clock for the current round: the active mode's seconds, unless a challenge
// has set a per-round override (Shrinking Timer). Perk bonus seconds are added on top
// by the callers (startTimer/showTimerFull).
function baseSeconds() {
  return roundSecondsOverride != null ? roundSecondsOverride : currentMode.seconds;
}

// Paint the round's clock at full WITHOUT starting it — a paused, full-bar "10.0"
// look. Used while a challenge curtain holds the round, so the previous round's
// leftover time never shows through (or beneath) the lifting curtain; the live
// countdown only begins once startTimer fires as the curtain clears.
function showTimerFull() {
  const fill = $("timerFill");
  const label = $("timerLabel");
  const wrap = document.querySelector(".timer-wrap");
  // It's A Clock! uses one shared clock — paint it at its current reading, not "full".
  const base = comboRuleActive() ? Math.max(0, comboClock) : baseSeconds();
  // Floor a clocked page at 3s so stacked time penalties (Devil's Path) can't zero it.
  const total = base > 0 ? Math.max(3, base + (comboRuleActive() ? 0 : (extraSecondsPerRound || 0))) : base;
  if (!(total > 0)) { if (wrap) wrap.style.display = "none"; return; }
  if (wrap) wrap.style.display = "";
  fill.style.width = "100%";
  fill.classList.remove("low");
  label.textContent = total.toFixed(1);
}

/* ---------- Timer sparkler (a lit-fuse flourish at the draining edge) ---------- */
// A small overlay canvas of additive light: tiny era-tinted sparks crackle off the
// leading edge of the draining timer bar, growing from a faint flicker at full to a
// busy sparkler as the clock runs out. The era hue is read live from `--bead`, the
// emitter tracks the fill's right edge, and intensity ramps with the time elapsed.
// Gated like the tension vignette (timerTension + motion). Purely decorative — it
// never touches timing. The additive blending is *within* the canvas (so overlapping
// sparks brighten each other); the canvas then composites over the paper normally,
// which is what keeps the era colour readable on the cream background.
const timerSpark = (() => {
  let canvas, ctx, raf = 0, last = 0, burst = 0;
  let W = 0, H = 0, dpr = 1, running = false;
  const parts = [], MAX = 240, WHITE = [255, 255, 255];
  let core = [255, 250, 242], body = [212, 114, 166], ember = [120, 70, 90];
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t | 0, a[1] + (b[1] - a[1]) * t | 0, a[2] + (b[2] - a[2]) * t | 0];
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function readEra() {
    const v = getComputedStyle(document.body).getPropertyValue("--bead").trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(v);
    const b = m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)] : [200, 149, 31];
    body = b; core = mix(b, [255, 252, 242], 0.72); ember = mix(b, [60, 40, 30], 0.45);
  }
  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function add(x, y, vx, vy, ttl, size, crackle) {
    if (parts.length >= MAX) return;
    parts.push({ x, y, vx, vy, age: 0, ttl, seed: Math.random() * 6.28, size, crackle, forked: false });
  }
  function emit(ex, ey, n, inten, boost) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const sp = (0.7 + Math.random() * (1.4 + inten * 1.8)) * (boost || 1);
      add(ex, ey, Math.cos(a) * sp, Math.sin(a) * sp,
        (12 + inten * 22) + Math.random() * 16, 0.7 + Math.random() * 0.6 * (0.6 + inten),
        Math.random() < 0.22);
    }
  }
  function frame(now) {
    if (!running) return;
    // toggling tension off (or the calm perk / reduced motion) stops it promptly
    if (!settings.timerTension || perkCalm || motionReduced()) { stop(); return; }
    const dt = Math.min(2.5, Math.max(0.5, (now - (last || now)) / 16.67)); last = now;
    // keep the backing store in sync with layout — self-heals if the bar wasn't laid
    // out (width 0) the instant start() ran, or after a resize/orientation change
    if (canvas.clientWidth !== W || canvas.clientHeight !== H) resize();
    if (!W || !H) { raf = requestAnimationFrame(frame); return; }
    // locate the draining edge in the canvas's CSS-px space
    const fill = $("timerFill"), cr = canvas.getBoundingClientRect();
    let ex = W * 0.5, ey = H - 6, frac = 1;
    if (fill && cr.width) {
      const fr = fill.getBoundingClientRect();
      ex = fr.right - cr.left; ey = (fr.top + fr.height / 2) - cr.top;
      frac = Math.max(0, Math.min(1, ex / cr.width));
    }
    const inten = 0.16 + 0.84 * Math.pow(1 - frac, 1.45);  // small at full → big near zero

    if (frac > 0.001) {
      emit(ex, ey, Math.round((0.5 + inten * 3.2) * dt), inten);
      burst -= dt;
      if (burst <= 0) { burst = (26 - inten * 16) + Math.random() * 22; emit(ex, ey, 2 + (inten * 5 | 0), inten, 1.5); }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]; p.age += dt;
      if (p.age >= p.ttl) { parts.splice(i, 1); continue; }
      p.vy += 0.07 * dt; p.vx *= Math.pow(0.965, dt); p.vy *= Math.pow(0.985, dt);
      p.x += p.vx * dt; p.y += p.vy * dt;
      const n = p.age / p.ttl;
      if (p.crackle && !p.forked && n > 0.55 + Math.random() * 0.2) {  // the sparkler "pop"
        p.forked = true;
        const k = 2 + (Math.random() * 2 | 0);
        for (let j = 0; j < k; j++) { const aa = Math.random() * 6.28, s = 0.5 + Math.random(); add(p.x, p.y, Math.cos(aa) * s, Math.sin(aa) * s - 0.3, 8 + Math.random() * 10, 0.7, false); }
      }
    }
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
    if (frac > 0.001) {
      const fl = 0.7 + 0.16 * Math.sin(now * 0.021) + 0.1 * Math.sin(now * 0.057 + 1.3) + 0.04 * Math.sin(now * 0.13);
      const R = 5 + 11 * inten;
      const rg = ctx.createRadialGradient(ex, ey, 0, ex, ey, R);
      rg.addColorStop(0, rgba(core, 0.55 * fl)); rg.addColorStop(0.45, rgba(body, 0.3 * fl)); rg.addColorStop(1, rgba(body, 0));
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(ex, ey, R, 0, 6.29); ctx.fill();
      ctx.fillStyle = rgba(mix(core, WHITE, 0.55), 0.95 * fl);
      ctx.beginPath(); ctx.arc(ex, ey, 1.5 + inten, 0, 6.29); ctx.fill();
    }
    for (const p of parts) {
      const n = p.age / p.ttl;
      let tw = 0.5 + 0.5 * Math.sin(now * 0.045 + p.seed * 11);
      if (p.crackle && n > 0.6) tw = Math.max(tw, 0.4 + 0.6 * Math.abs(Math.sin(now * 0.09 + p.seed * 7)));
      const bright = Math.max(0, 1 - n * n) * tw;
      const col = n < 0.6 ? mix(core, body, n / 0.6) : mix(body, ember, (n - 0.6) / 0.4);
      const tx = p.x - p.vx * 1.9, ty = p.y - p.vy * 1.9, mx = (p.x + tx) / 2, my = (p.y + ty) / 2;
      ctx.strokeStyle = rgba(col, bright * 0.28); ctx.lineWidth = 0.7 * p.size;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(mx, my); ctx.stroke();
      ctx.strokeStyle = rgba(mix(col, WHITE, 0.25), bright * 0.8); ctx.lineWidth = 1.05 * p.size;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.fillStyle = rgba(mix(col, WHITE, 0.5), bright);
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.95 * p.size, 0, 6.29); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (motionReduced() || !settings.timerTension || perkCalm) { stop(); return; }
    canvas = $("timerSpark"); if (!canvas) return;
    ctx = canvas.getContext("2d"); if (!ctx) return;
    readEra(); resize();                       // refresh era colour + size each round
    if (!running) { running = true; last = 0; burst = 0; raf = requestAnimationFrame(frame); }
  }
  function stop() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    parts.length = 0;
    if (ctx && W && H) ctx.clearRect(0, 0, W, H);
  }
  window.addEventListener("resize", () => { if (running) resize(); });
  return { start, stop };
})();

// `resume` (seconds remaining) restarts a paused round mid-count instead of from
// the full clock — used when closing the settings modal during play.
function startTimer(resume) {
  clearTimer();
  const fill = $("timerFill");
  const label = $("timerLabel");
  // Choose Your Path's "Slow Down Time" perk adds seconds, but only where there's
  // already a clock (Relaxed stays clock-less). baseSeconds() applies Shrinking Timer's
  // per-round override.
  const wrap = document.querySelector(".timer-wrap");
  let total, begin;
  if (comboRuleActive()) {
    // It's A Clock!: one shared budget across the whole run. The bar is scaled to
    // COMBO_CAP and begins wherever the shared clock stands; it never resets per round.
    total = COMBO_CAP;
    begin = Math.max(0, Math.min(COMBO_CAP, comboClock));
    if (wrap) wrap.style.display = "";
    if (begin <= 0) { comboClock = 0; roundLocked = true; resetTension(); endGame(); return; }
  } else {
    const base = baseSeconds();
    // Floor a clocked page at 3s so stacked time penalties (Devil's Path) can't zero it.
    total = base > 0 ? Math.max(3, base + (extraSecondsPerRound || 0)) : base;
    // Relaxed mode (seconds <= 0): no clock at all — hide the bar and never time out.
    if (!(total > 0)) {
      if (wrap) wrap.style.display = "none";
      return;
    }
    if (wrap) wrap.style.display = "";
    begin = (resume != null && resume > 0 && resume < total) ? resume : total;
  }
  timerStart = performance.now() - (total - begin) * 1000;
  fill.style.width = (begin / total * 100) + "%";
  fill.classList.remove("low");
  label.textContent = begin.toFixed(1);
  // Reset the screen-reader low-time cue for this round (cleared so the same words
  // re-announce next round) — the per-tick label is silent to AT; this is the one cue.
  let lowAnnounced = false;
  const srTimer = $("srTimer");
  if (srTimer) srTimer.textContent = "";
  timerSpark.start();
  startRevolve();   // Revolving Door: begin (or restart) the per-round word rotation, in sync with the clock

  timerId = setInterval(() => {
    const elapsed = (performance.now() - timerStart) / 1000;
    const remaining = Math.max(0, total - elapsed);
    const pct = (remaining / total) * 100;
    fill.style.width = pct + "%";
    label.textContent = remaining.toFixed(1);
    fill.classList.toggle("low", remaining <= 3);
    // One spoken cue when the clock runs low (Relaxed has no clock and never reaches here).
    if (!lowAnnounced && remaining <= 3 && total > 3) {
      lowAnnounced = true;
      if (srTimer) srTimer.textContent = "3 seconds left";
    }
    // the bridge build: ramp tension over the final 4 seconds
    setTension(remaining >= 4 ? 0 : (4 - remaining) / 4);
    updateTally(remaining);
    // past half-time, if no hint taken yet, nudge the hint affordance
    if (elapsed / total >= 0.5 && hintTier === 0 && hintsAllowed() && !motionReduced()) {
      const hb = $("hintBtn");
      if (hb && !hb.hidden) hb.classList.add("urge");
    }
    if (remaining <= 0) {
      label.textContent = "0.0";
      // It's A Clock!: the shared clock running out ends the whole run, not just a round.
      if (comboRuleActive()) { comboClock = 0; clearTimer(); resetTension(); roundLocked = true; endGame(); }
      else submitAnswer(null, true);
    }
  }, 100);
}
function clearTimer() {
  if (timerId) { clearInterval(timerId); timerId = null; }
  if (revolveId) { clearInterval(revolveId); revolveId = null; }   // stop Revolving Door's word rotation alongside the clock
  timerSpark.stop();
}

// Revolving Door only: start the interval that swaps the word every rotateMs. The round
// clock keeps draining underneath — this just changes which word is in play. No-op for
// every other game type/challenge. Cleared by clearTimer with the round clock.
function startRevolve() {
  if (revolveId) { clearInterval(revolveId); revolveId = null; }
  if (gameType !== "challenge" || !currentChallenge || currentChallenge.rule !== "revolving") return;
  const ms = currentChallenge.rotateMs || 5000;
  revolveId = setInterval(revolveWord, ms);
}

/* ---------- Timer tension ---------- */
function setTension(t) {
  // Timer-tension setting off (or Choose Your Path's Steady Hands perk) → keep the
  // vignette/tremor at rest.
  document.body.style.setProperty("--tension", (settings.timerTension && !perkCalm) ? String(t) : "0");
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

// Whether a song satisfies the active challenge's per-round constraint — so the
// suggestions never reveal an answer the rule would soft-reject (e.g. a multi-word
// title under "only one-word titles", or an out-of-order title in From A to Z).
// Non-constraint rules (and non-challenge play) accept everything.
function roundAcceptsSong(song) {
  // Album Focus: only ever suggest songs from the locked album.
  if (gameType === "album" && focusAlbum) return song.album === focusAlbum;
  if (gameType !== "challenge" || !currentChallenge) return true;
  // noTitle challenges (e.g. Revolving Door): never suggest a song whose title
  // contains the prompt word — the round would reject it.
  if (effectiveNoTitle() && currentWord &&
      wordRegex(currentWord, effectiveStrict()).test(song.title)) return false;
  if (currentChallenge.rule === "wildcard") {
    return !roundWildcard || !roundWildcard.accepts || roundWildcard.accepts(song);
  }
  if (currentChallenge.rule === "alphabetical") {
    if (!lastAlphaLetter) return true;
    const L = firstAlphaLetter(song.title);
    return !L || L >= lastAlphaLetter;
  }
  if (currentChallenge.rule === "titleHas")
    return wordRegex(currentWord, effectiveStrict()).test(song.title);
  if (currentChallenge.rule === "shorttitle")
    return titleWordCount(song.title) <= 2;
  if (currentChallenge.rule === "chain")
    return !chainLetter || firstAlphaLetter(song.title) === chainLetter;
  if (currentChallenge.rule === "setlist")
    return song.album === tourSetlist[round - 1];
  if (currentChallenge.rule === "devil")
    return devilAllowsSong(song);   // No Giveaways is already handled by the noTitle gate above
  return true;
}

// The number of whitespace-separated words in a title (Short n' Sweet's measure).
function titleWordCount(title) {
  return (title || "").trim().split(/\s+/).filter(Boolean).length;
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
    if (!roundAcceptsSong(song)) continue;   // hide rule-breaking suggestions
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
  const input = $("songInput");
  if (!dropdownItems.length) { hideDropdown(); return; }
  dd.innerHTML = "";
  dropdownItems.forEach((song, i) => {
    const div = document.createElement("div");
    const off = isOffLimitsPick(song);
    div.className = "item" + (i === activeIndex ? " active" : "") + (off ? " off-limits" : "");
    // Combobox/listbox semantics so a screen reader can follow arrow-key selection.
    div.id = "dd-opt-" + i;
    div.setAttribute("role", "option");
    div.setAttribute("aria-selected", i === activeIndex ? "true" : "false");
    div.innerHTML = `${escapeHtml(censor(song.title))}` + (off ? `<span class="dd-tag">in the title</span>` : "");
    div.addEventListener("mousedown", (e) => {
      e.preventDefault();
      submitAnswer(song, false);   // off-limits picks route through the soft-reject in submitAnswer
    });
    dd.appendChild(div);
  });
  dd.classList.add("show");
  input.setAttribute("aria-expanded", "true");
  if (activeIndex >= 0) input.setAttribute("aria-activedescendant", "dd-opt-" + activeIndex);
  else input.removeAttribute("aria-activedescendant");
}
function hideDropdown() {
  $("dropdown").classList.remove("show");
  const input = $("songInput");
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

// A pick is off-limits when the active mode bars title songs and the word sits in
// this song's title — the exact condition validSongs() uses to exclude it.
function isOffLimitsPick(song) {
  return !!song && effectiveNoTitle() && wordRegex(currentWord, effectiveStrict()).test(song.title);
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
  el.innerHTML = `<b>“${escapeHtml(censor(song.title))}”</b> is in the title — try another`;
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
// From A to Z: the first A–Z letter of a title (ignoring punctuation/digits).
function firstAlphaLetter(title) {
  const m = (title || "").toUpperCase().match(/[A-Z]/);
  return m ? m[0] : "";
}
// Shared soft-reject flash: wipe the line, pulse the input, show a red margin note,
// and keep the clock running — the round is NOT burned. Used by the off-limits,
// alphabetical, wildcard, and One Of A Kind rejects.
function softRejectFlash(html) {
  const input = $("songInput");
  input.value = "";
  dropdownItems = []; activeIndex = -1;
  hideDropdown();
  const el = $("rejectFlash");
  el.innerHTML = html;
  el.classList.remove("show");
  void el.offsetWidth;
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
// Soft reject for an out-of-order answer in the alphabetical challenge.
function rejectAlpha(letter) {
  softRejectFlash(`out of order — start with <b>${escapeHtml(lastAlphaLetter)}</b> or later`);
}
// Title...?: the word's in the lyrics but not the title they named.
function rejectTitleHas() {
  softRejectFlash(`that's in the lyrics — name a <b>title</b> with the word`);
}
// Short n' Sweet: the named title is too long.
function rejectShortTitle() {
  softRejectFlash(`too long — name a <b>one- or two-word</b> title`);
}
// Wrapped Like A Chain: the named title doesn't start with the required letter.
function rejectChain() {
  softRejectFlash(`off the chain — start with <b>${escapeHtml(chainLetter)}</b>`);
}
// On Tour!: the named song isn't from tonight's album.
function rejectTour() {
  const a = tourSetlist[round - 1] || "tonight's album";
  softRejectFlash(`not on the setlist — name a <b>${escapeHtml(a)}</b> song`);
}
// Album Focus: the named song is from another album. Don't burn the round.
function rejectAlbumFocus() {
  softRejectFlash(`from <b>${escapeHtml(focusAlbum)}</b> only`);
}
// The last A–Z letter of a title (Wrapped Like A Chain's link to the next answer).
function lastChainLetter(title) {
  const m = (title || "").toUpperCase().match(/[A-Z]/g);
  return m ? m[m.length - 1] : "";
}
// One Of A Kind: the player tried their target song on a round where it doesn't fit
// the prompt word. Costs a guess (so spamming the target every round can't brute-force
// the win); when the budget runs out the run fails. A guess is only spent here — naming
// it on a round where it DOES fit falls through and wins.
function rejectNewSong() {
  const t = challengeTargetSong ? challengeTargetSong.title : "your song";
  newSongLives -= 1;
  if (newSongLives <= 0) {                       // out of guesses — the song got away
    roundLocked = true;
    softRejectFlash(`<b>“${escapeHtml(censor(t))}”</b> doesn't fit — out of guesses`);
    endGame();                                   // routes to endChallenge (a loss)
    return;
  }
  const n = newSongLives;
  softRejectFlash(`<b>“${escapeHtml(censor(t))}”</b> doesn't fit this word — ` +
    `${n} ${n === 1 ? "guess" : "guesses"} left`);
  renderNewSongBanner();                          // refresh the lives pips
}

/* ---------- Lyric-line answering ---------- */
// A player can answer by typing a LYRIC LINE instead of the title. There is no lyric
// autocomplete (that would hand them the answer); the line is blind-typed and only
// JUDGED here. To pass it must (a) contain the prompt word, (b) be >= MIN_LYRIC_WORDS
// (or a long-enough 3-word phrase, see below),
// and (c) closely match a real word-bearing lyric line of a valid song. Fuzzy so
// typos / a slightly-off line still count. Returns { song, line } or null.
function matchLyricLine(phrase) {
  const normPhrase = normalizeLyric(phrase);
  if (!normPhrase) return null;
  const wordCount = normPhrase.split(" ").length;
  // Accept 4+ words, OR a 3-word phrase that's long enough by character count.
  if (wordCount < MIN_LYRIC_WORDS &&
      !(wordCount >= MIN_LYRIC_WORDS_SHORT && normPhrase.length >= MIN_LYRIC_SHORT_CHARS)) {
    return null;
  }
  // NOTE: we deliberately do NOT require the prompt word to appear in the typed phrase.
  // Matching is already restricted to currentSongs (every one of which contains the
  // word — they're the round's valid answers), so any real lyric chunk that matches is
  // a correct answer regardless of which specific lines the player recalled. This makes
  // multi-line recall "just work" when the word lives in a line they didn't type. The
  // bare-word / word+filler cheat is still blocked by MIN_LYRIC_WORDS + a real-line match.

  // Fast path: a verbatim contiguous run anywhere in the lyrics (incl. across lines).
  for (const s of currentSongs) {
    if (s._normLyrics.includes(normPhrase)) {
      const { text: line, lines } = recoverLyricLine(s, normPhrase);
      return { song: s, line, fuzzy: false, ...gradeLyricRecall(normPhrase, line, lines) };
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
  const { text: line, lines } = recoverFuzzyLine(best.song, normPhrase);
  return { song: best.song, line, fuzzy: true, ...gradeLyricRecall(normPhrase, line, lines) };
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
      if (!best || sim > best.sim) best = { sim, text: windowRaw.join(" "), lines: windowRaw.length };
      if (windowNorm.length > normPhrase.length * 2) break;   // don't over-grow the window
    }
  }
  return best ? { text: best.text, lines: best.lines } : { text: rawLines[0] || "", lines: 1 };
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
  if (single) return { text: single.trim(), lines: 1 };
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
  if (at < 0) return { text: (rawLines.find(Boolean) || "").trim(), lines: 1 };
  const endAt = at + normPhrase.length - 1;
  const startSeg = segs.find((s) => at >= s.start && at < s.end);
  const endSeg = segs.find((s) => endAt >= s.start && endAt < s.end);
  if (!startSeg || !endSeg) return { text: (rawLines.find(Boolean) || "").trim(), lines: 1 };
  const spanLines = rawLines.slice(startSeg.i, endSeg.i + 1)
    .map((l) => l.trim()).filter(Boolean);
  return { text: spanLines.join(" "), lines: spanLines.length };
}

// Grade how much of the matched real line the player actually typed. Typing the
// minimum scrapes a pass with no bonus; recalling most / all of the line earns a
// "verse bonus" and a louder celebration. A word-perfect block spanning WHOLE_VERSE_LINES
// real lines is the top "whole verse" rung. `lines` = how many raw lines the match spanned.
// Returns { tier, bonus, coverage, lines }.
function gradeLyricRecall(normPhrase, line, lines = 1) {
  const normLine = normalizeLyric(line);
  const total = normLine ? normLine.split(" ").length : 0;
  const typed = normPhrase ? normPhrase.split(" ").length : 0;
  const verbatim = normPhrase === normLine;
  const coverage = total ? Math.min(typed / total, 1) : 0;
  const perfect = verbatim || coverage >= RECALL_PERFECT;
  if (perfect && lines >= WHOLE_VERSE_LINES) return { tier: "verse", bonus: 3, coverage, lines };
  if (perfect) return { tier: "perfect", bonus: 2, coverage, lines };
  if (coverage >= RECALL_GOOD) return { tier: "good", bonus: 1, coverage, lines };
  return { tier: "base", bonus: 0, coverage, lines };
}

// Live verse-bonus gauge for what's CURRENTLY typed — drives #verseMeter so a player
// sees the reward climb as they write more of the line. Deliberately non-revealing:
// it only ever reacts to text the player has ALREADY typed (a real contiguous lyric
// fragment of a valid song), and returns a QUANTIZED tier — never a word count, a line
// length, or any un-typed text. Returns null when the text isn't yet a real fragment
// (so the meter stays hidden until the player is genuinely on a line). Cheap: an
// indexOf over currentSongs' precomputed _normLyrics blobs, gated behind the input debounce.
function verseProgress(text) {
  const np = normalizeLyric(text || "");
  if (!np || np.split(" ").length < 2) return null;
  for (const s of currentSongs) {
    if (!s._normLyrics.includes(np)) continue;
    const { text: line, lines } = recoverLyricLine(s, np);
    const total = normalizeLyric(line).split(" ").length;
    const coverage = total ? Math.min(np.split(" ").length / total, 1) : 0;
    if (coverage >= RECALL_PERFECT && lines >= WHOLE_VERSE_LINES) return "verse";
    if (coverage >= RECALL_PERFECT) return "perfect";
    if (coverage >= RECALL_GOOD) return "good";
    return "fragment";
  }
  return null;
}

const VERSE_METER = {
  fragment: { level: 1, label: "a fragment" },
  good:     { level: 2, label: "half the verse" },
  perfect:  { level: 3, label: "the whole line ★" },
  verse:    { level: 4, label: "a whole verse ★★" },
};
// Light the meter's notches for what's typed. Hidden unless the text is a real lyric
// fragment, and suppressed once the tier-3 line hint is on screen (it'd be copying).
function renderVerseMeter(text) {
  const meter = $("verseMeter");
  if (!meter) return;
  const tier = (gameType !== "daily" && hintTier >= 3) ? null : verseProgress(text);
  if (!tier) { meter.hidden = true; return; }
  const { level, label } = VERSE_METER[tier];
  meter.hidden = false;
  meter.querySelectorAll(".vm-notch").forEach((n) => {
    n.classList.toggle("lit", Number(n.dataset.tier) <= level);
  });
  meter.querySelector(".vm-label").textContent = label;
}

/* ---------- Submit & feedback ---------- */
function submitAnswer(song, isTimeout) {
  if (roundLocked) return;

  // Paris easter egg — answering "Paris" when the prompt word is "somewhere".
  // Fires on the attempt regardless of whether it's a correct match for the round.
  if (currentWord === "somewhere" && normalizeTitle($("songInput").value || "") === "paris") unlock("paris");
  checkPianoEgg($("songInput").value);   // "rep tv" / "reputation tv" typed as an answer

  let lyricMatch = null;
  if (!song && !isTimeout) {
    if (lyricModeNow()) {                   // Lyricist mode / Switch-Up lyric page: lyric line only
      lyricMatch = matchLyricLine($("songInput").value);
      if (lyricMatch) song = lyricMatch.song;
    } else if (dropdownItems.length) {
      song = dropdownItems[activeIndex >= 0 ? activeIndex : 0];
    } else {
      const raw = $("songInput").value;
      const key = normalizeTitle(raw);
      song = key ? (titleIndex.get(key) || null) : null;
      if (!song && key) song = spacelessIndex.get(key.replace(/ /g, "")) || null;  // forgive misplaced spaces
      // Not a title — try it as a lyric line. EXCEPT when this round's tier-3 line
      // hint has been revealed: the line is on screen, so accepting a typed line
      // would just be copying the hint. Force the title instead (dropdown is on in
      // every hint mode, so the title path is always available).
      if (!song && hintTier < 3) {
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

  // From A to Z: a valid answer earlier in the alphabet than the last accepted one is
  // soft-rejected (doesn't burn the round), so the player can keep the sequence going.
  if (song && !isTimeout && currentChallenge && currentChallenge.rule === "alphabetical"
      && currentSongs.some((s) => s.title === song.title)) {
    const L = firstAlphaLetter(song.title);
    if (lastAlphaLetter && L && L < lastAlphaLetter) { rejectAlpha(L); return; }
  }

  // One Of A Kind: trying the named target song on a round where it doesn't fit the
  // prompt word doesn't burn the round — the player keeps hunting for a word that lands
  // it ("answer that song for at least one word"). When it DOES fit, it falls through
  // and scores correct, satisfying the win check.
  if (song && !isTimeout && currentChallenge && currentChallenge.rule === "newsong"
      && challengeTargetSong && song.title === challengeTargetSong.title
      && !currentSongs.some((s) => s.title === song.title)) {
    rejectNewSong(); return;
  }

  // Wildcard: a song that's valid by lyrics but breaks this round's rule is soft-
  // rejected (no burned round) so the player can answer within the rule. Wrong songs
  // fall through to score as wrong; a null-accepts rule (vanishing) never rejects.
  if (song && !isTimeout && currentChallenge && currentChallenge.rule === "wildcard"
      && roundWildcard && roundWildcard.accepts
      && currentSongs.some((s) => s.title === song.title)
      && !roundWildcard.accepts(song)) {
    rejectWildcard(roundWildcard.label); return;
  }

  // Title...?: a song whose lyrics hold the word but whose TITLE doesn't is soft-
  // rejected (keep hunting for a title with the word) — a wholly unrelated song still
  // falls through and scores wrong.
  if (song && !isTimeout && currentChallenge && currentChallenge.rule === "titleHas") {
    const rx = wordRegex(currentWord, effectiveStrict());
    if (!rx.test(song.title) && rx.test(song.lyrics)) { rejectTitleHas(); return; }
  }

  // Short n' Sweet: a song valid by lyrics but with a 3+-word title is soft-rejected so
  // the player keeps looking for a one- or two-word title.
  if (song && !isTimeout && currentChallenge && currentChallenge.rule === "shorttitle"
      && currentLyricSongs.some((s) => s.title === song.title)
      && titleWordCount(song.title) > 2) {
    rejectShortTitle(); return;
  }

  // Wrapped Like A Chain: a valid-by-lyrics answer that doesn't start with the required
  // letter is soft-rejected so the player can keep the chain going.
  if (song && !isTimeout && currentChallenge && currentChallenge.rule === "chain"
      && chainLetter
      && currentLyricSongs.some((s) => s.title === song.title)
      && firstAlphaLetter(song.title) !== chainLetter) {
    rejectChain(); return;
  }

  // On Tour!: a valid-by-lyrics answer from the wrong album is soft-rejected so the
  // player keeps looking for one off tonight's album.
  if (song && !isTimeout && currentChallenge && currentChallenge.rule === "setlist"
      && currentLyricSongs.some((s) => s.title === song.title)
      && song.album !== tourSetlist[round - 1]) {
    rejectTour(); return;
  }

  // Album Focus: a named song from another album is soft-rejected (no burned round) so the
  // player keeps looking within the chosen album. Lyric/dropdown answers are already album-
  // gated; this catches a deliberately typed off-album title.
  if (song && !isTimeout && gameType === "album" && focusAlbum && song.album !== focusAlbum) {
    rejectAlbumFocus(); return;
  }

  // Devil's Path: a song valid by lyrics but blocked by an active curse (banned album /
  // forbidden initial / too-long title) is soft-rejected so the player keeps looking; a
  // wholly unrelated song still falls through and scores wrong.
  if (song && !isTimeout && currentChallenge && currentChallenge.rule === "devil"
      && currentLyricSongs.some((s) => s.title === song.title) && !devilAllowsSong(song)) {
    rejectDevil(song); return;
  }

  // Double Trouble: a page resolves only once `need` DIFFERENT valid songs are named.
  // Each accepted valid song banks toward the pair without locking the page (the clock
  // keeps running); a duplicate is soft-rejected; reaching `need` falls through to
  // resolve the page correct. A wrong song falls through and scores the page wrong.
  if (song && !isTimeout && currentChallenge && currentChallenge.rule === "multi"
      && currentSongs.some((s) => s.title === song.title)) {
    const need = currentChallenge.need || 2;
    if (roundNamed.includes(song.title)) {
      softRejectFlash(`already named <b>${escapeHtml(song.title)}</b> — name a different song`);
      return;
    }
    roundNamed.push(song.title);
    renderMultiBanner();
    if (roundNamed.length < need) {
      softRejectFlash(`✓ ${roundNamed.length} of ${need} — name another song with the word`);
      return;
    }
    // `need` reached — fall through with this final song to resolve the page correct.
  }

  roundLocked = true;
  clearTimer();
  resetTension();
  hideDropdown();
  $("songInput").disabled = true;
  $("playArea").style.display = "none";

  const correct = !!song && currentSongs.some((s) => s.title === song.title);
  // Choose Your Path — Second Chance / Nine Lives: spend a mulligan to retry a miss
  // (same word, fresh clock) instead of burning the round. Only kicks in on an actual
  // miss while mulligans remain; correct answers and the other challenges are untouched.
  if (!correct && currentChallenge && currentChallenge.rule === "path" && pathMulligans > 0) {
    pathMulligans -= 1;
    roundLocked = false;
    $("songInput").disabled = false;
    $("playArea").style.display = "";
    softRejectFlash(`second chance — try again (${pathMulligans} left)`);
    startTimer();
    return;
  }
  roundResults[round - 1] = correct;
  roundAlbums[round - 1] = song ? (song.album || null) : null;
  roundWords[round - 1] = currentWord;                 // prompt word — for Nemesis Word
  roundSongs[round - 1] = correct && song ? song.title : null;  // credited song — for the lifetime tally
  justEarnedIndex = correct ? round - 1 : -1;
  if (correct) score++;
  if (correct && song && song.title === "If This Was A Movie") unlock("spicy-drama");
  // It's A Clock!: bank the time left on the shared clock; a correct answer winds it
  // back up (capped). The timer is already cleared, so comboRemaining() is the reading
  // at the moment of the answer. Next round's startTimer resumes from comboClock.
  if (comboRuleActive()) {
    comboClock = comboRemaining();
    if (correct) comboClock = Math.min(COMBO_CAP, comboClock + COMBO_BONUS);
    renderComboBanner();
  }
  // Live challenge progress — refresh the banner the instant an answer is recorded
  // (Deep Cut's album tally / One Of A Kind's found-it stamp), before the page turns.
  if (gameType === "challenge" && currentChallenge) {
    if (currentChallenge.rule === "album5") renderDeepCutCounter();
    else if (currentChallenge.rule === "newsong") renderNewSongBanner();
  }
  // From A to Z: advance the alphabetical floor only on an accepted correct answer.
  if (correct && currentChallenge && currentChallenge.rule === "alphabetical") {
    lastAlphaLetter = firstAlphaLetter(song.title);
  }
  // Wrapped Like A Chain: the next title must start with this answer's LAST letter.
  if (correct && currentChallenge && currentChallenge.rule === "chain") {
    chainLetter = lastChainLetter(song.title);
    renderChainBanner();
  }
  correctStreak = correct ? correctStreak + 1 : 0;
  if (gameType === "infinite" && !correct) { lives--; renderLives(); }
  if (gameType === "adaptive") adaptiveAdjust(correct);
  // A word-perfect+ recall earns a pen-nib bead (set BEFORE renderBracelet so the
  // charm shows on the bead the moment it's earned, not a round late).
  const versePlus = lyricMatch && (lyricMatch.tier === "perfect" || lyricMatch.tier === "verse");
  if (versePlus) roundVerseTier[round - 1] = lyricMatch.tier;
  renderBracelet();

  if (lyricMatch) {
    lyricLineAnswers++;                  // recalled a lyric line (for You Knew The Line)
    verseBonus += lyricMatch.bonus;      // reward fuller recall, separate from the 0–13 score
    if (versePlus) {
      gameVersePerfect++;                // lifetime versePerfect / milestone achievements
      verseKeepsake.push({ line: lyricMatch.line, word: currentWord, tier: lyricMatch.tier });
    }
    if (lyricMatch.tier === "verse") { gameWholeVerses++; unlock("overachiever"); }
    // Someone Has A Favourite Song — 3 lyric answers from the same song in one game.
    lyricAnswerSongs.push(song.title);
    if (lyricAnswerSongs.filter((t) => t === song.title).length >= 3) unlock("fav-song");
    if (lyricMatch.tier === "perfect") unlock("word-for-word");
    if (lyricMatch.fuzzy) {              // landed it without the line being verbatim
      gameFuzzyMatches++;
      unlock("wordsmith");
    }
  }

  // Diamonds Are Forever — three rare/scarce prompt words answered right in a row.
  // Disqualified in Ultra (its pool is the rarest words, so a streak there is trivial).
  const rar = rarityTier(currentSongs.length);
  if (currentMode.id !== "ultra" && correct && (rar.name === "rare" || rar.name === "scarce" || rar.name === "singular")) {
    rareStreak++;
    if (rareStreak >= 3) unlock("diamonds");
  } else {
    rareStreak = 0;
  }

  // achievements: timing + streak signals (mid-game unlocks toast immediately).
  // Timing signals only apply to timed modes — Relaxed has no clock, so they're skipped.
  const timed = currentMode.seconds > 0;
  if (isTimeout) gameTimeouts++;
  if (timed) {
    const elapsed = (performance.now() - timerStart) / 1000;
    const remaining = currentMode.seconds - elapsed;
    gameTimeSum += Math.min(elapsed, currentMode.seconds);   // for Perfect Storm
    gameTimedRounds++;                                       // for the lifetime avg answer time
    if (remaining <= 3) gameHitRedZone = true;               // for Peace (timeouts count too)
    if (correct) {
      const ms = Math.min(elapsed, currentMode.seconds) * 1000;
      if (gameFastestMs == null || ms < gameFastestMs) gameFastestMs = ms;   // lifetime fastest answer
      if (elapsed < 2) unlock("speak-now");
      if (round === 1 && elapsed < 2) unlock("ready-for-it");
      if (remaining < 1) unlock("getaway-car");
      if (remaining < 0.5) unlock("i-did-something-bad");
    }
  }
  gameMaxStreak = Math.max(gameMaxStreak, correctStreak);
  if (correctStreak >= 5) unlock("bejeweled");
  if (correctStreak >= 10) unlock("sparks-fly");
  // It's Raining And It's Monday — answer the word "rain" right on a Monday.
  if (correct && currentWord === "rain" && new Date().getDay() === 1) unlock("raining-monday");

  // Daily: persist the run so a refresh/exit resumes here instead of restarting. Saved
  // after the round is recorded but before the next word is drawn, so the stored PRNG
  // position resumes the remaining words deterministically. The final round isn't saved —
  // endGame finalizes the result and clears the in-progress record.
  if (gameType === "daily" && round < TOTAL_ROUNDS) {
    saveDailyProgress(todayKey(), dailyProgressSnapshot(todayKey()));
  }

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
      `<span class="cc-text">${escapeHtml(censor(song.title))}</span>` +
      `<svg viewBox="0 0 100 46" preserveAspectRatio="none" aria-hidden="true">` +
        `<path class="cc-ring" pathLength="1" d="M5,26 C2,12 30,3 54,4 C84,5 99,13 96,25 C93,39 64,44 42,43 C16,42 7,38 5,26"/>` +
      `</svg>` +
    `</span></div>`;
  setTimeout(done, 640 * animScale());
}

function lyricCard(song, word, isWrong, lineOverride, context) {
  // A lyric-answer override is the span the player actually recalled, which need NOT
  // contain the prompt word (matching only requires a real line of a valid song — see
  // matchLyricLine). When it doesn't, fall back to the song's word-bearing line so the
  // card always shows — and highlights — the lyric that holds the prompt word.
  let line = lineOverride != null ? lineOverride : extractLineWithWord(song.lyrics, word);
  if (lineOverride != null && !wordRegex(word).test(line)) {
    line = extractLineWithWord(song.lyrics, word);
  }
  const color = albumColor(song.album) || "var(--ink-soft)";
  const albumLabel = song.album ? `<span class="album-tag" style="--album-color:${color}">${escapeHtml(song.album)}</span>` : "";
  const cls = isWrong ? " wrong-card" : "";
  const ctx = context ? lyricCardContext(song, word) : "";
  return `<div class="lyric-card${cls}" style="--album-color:${color}">
    <div class="song-title">${escapeHtml(censor(song.title))}${albumLabel}</div>
    <div class="lyric-line">"${highlightWord(line, word)}"</div>
    ${ctx}
  </div>`;
}

// The ±2 surrounding lines around the prompt word's line, for the in-card "in context"
// peek. Anchored on the word (not the displayed line, which may be a multi-line lyric
// answer) so it always lands where the word actually sits.
function lyricContextRows(song, word) {
  const all = (song.lyrics || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const idx = all.findIndex((l) => wordRegex(word).test(l));
  if (idx < 0) return "";
  const start = Math.max(0, idx - 2), end = Math.min(all.length, idx + 3);
  let html = "";
  if (start > 0) html += `<div class="lc-gap" aria-hidden="true">⋯</div>`;
  for (let i = start; i < end; i++) {
    html += i === idx
      ? `<div class="lc-line lc-match">${highlightWord(all[i], word)}</div>`
      : `<div class="lc-line">${escapeHtml(censor(all[i]))}</div>`;
  }
  if (end < all.length) html += `<div class="lc-gap" aria-hidden="true">⋯</div>`;
  return html;
}

// Progressive disclosure for a lyric card: a quiet "in context" toggle that expands the
// surrounding lines inline, with a "full lyrics" link nested inside that opens the whole
// song in a modal. One control keeps the default card uncluttered (CLAUDE: gameplay stays
// dominant). Returns "" when there's nothing to expand.
function lyricCardContext(song, word) {
  const rows = lyricContextRows(song, word);
  if (!rows) return "";
  return `<button type="button" class="lyric-ctx-toggle" aria-expanded="false">in context</button>` +
    `<div class="lyric-ctx" hidden>` +
      `<div class="lyric-ctx-lines">${rows}</div>` +
      `<button type="button" class="lyric-fullsong" data-song="${escapeHtml(song.title)}" data-word="${escapeHtml(word)}">full lyrics →</button>` +
    `</div>`;
}

const LYRIC_BANNERS = { base: "✓ you knew the line", good: "✓ nicely recalled", perfect: "✓ word-perfect", verse: "✓ the whole verse" };

// A reusable peel-and-stick foil star — the teacher's gold star, pressed into the
// margin. A die-cut star (clip-path foil) with the bonus amount written across its
// body; the tier wording lives in the banner beside it, so the sticker stays terse.
// Other moments can reuse it as the sticker vocabulary grows — see PLAN.md.
function stickerHTML({ amt, label, tone = "gold", big = false }) {
  return `<span class="sticker sticker--${tone}${big ? " sticker--big" : ""}" role="img" aria-label="+${amt} ${label}">
    <span class="sticker-foil"></span>
    <span class="sticker-amt">+${amt}</span>
  </span>`;
}
const VERSE_STICKERS = {
  good:    { label: "verse bonus",     tone: "gold" },
  perfect: { label: "word-perfect",    tone: "gold" },
  verse:   { label: "the whole verse", tone: "rose", big: true },
};
function verseSticker(tier, bonus) {
  if (!bonus) return "";
  const cfg = VERSE_STICKERS[tier] || VERSE_STICKERS.good;
  return stickerHTML({ amt: bonus, label: cfg.label, tone: cfg.tone, big: cfg.big });
}

function showCorrectFeedback(song, lyricMatch) {
  const fb = $("feedback");
  // On a lyric answer, celebrate the recall and show the exact line they typed.
  // The banner escalates with how much of the line they recalled, and a gold sticker
  // is pressed on for any verse bonus earned (fuller line = a louder, gold-foil reward).
  // Double Trouble resolves a page only once both songs are named — celebrate (and show)
  // the pair, not just the last one typed.
  const multi = gameType === "challenge" && currentChallenge && currentChallenge.rule === "multi" && roundNamed.length > 1;
  const banner = multi
    ? (roundNamed.length === 2 ? "✓ both of them" : `✓ all ${roundNamed.length}`)
    : lyricMatch ? (LYRIC_BANNERS[lyricMatch.tier] || LYRIC_BANNERS.base) : "✓ that's the one";
  const bonus = lyricMatch ? lyricMatch.bonus : 0;
  const sticker = lyricMatch ? verseSticker(lyricMatch.tier, bonus) : "";
  // First time a verse bonus is ever earned, teach what it is — once, then silent.
  let firstNote = "";
  if (bonus > 0 && !settings.seenVerseBonus) {
    settings.seenVerseBonus = true; saveSettings(settings);
    firstNote = `<p class="verse-firstnote">writing more of the line earns a verse bonus — a prestige tally, kept apart from your score</p>`;
  }
  const card = multi
    ? roundNamed.map((t) => lyricCard(currentSongs.find((s) => s.title === t) || song, currentWord, false, null, true)).join("")
    : lyricMatch
      ? lyricCard(song, currentWord, false, lyricMatch.line, true)
      : lyricCard(song, currentWord, false, null, true);
  // Auto-advance setting on → a countdown + skip; off → a plain "next page" button.
  const auto = settings.autoAdvance;
  const advanceUI = auto
    ? `<div class="countdown">next page in <b id="cd">${settings.countdownSecs}</b></div><button id="skipBtn" class="countdown-skip">skip →</button>`
    : `<button id="continueBtn" class="btn-ghost">next page →</button>`;
  fb.innerHTML = `
    <div class="fb-head"><div class="banner good">${banner}</div>${sticker}</div>
    ${firstNote}
    ${card}
    ${advanceUI}`;
  feedbackShownAt = Date.now();
  $(auto ? "skipBtn" : "continueBtn").addEventListener("click", advanceFromFeedback);
  celebrateCorrect(correctStreak, bonus);
  if (auto) runCountdown();
}

function showWrongFeedback(song, isTimeout) {
  const fb = $("feedback");
  const reason = isTimeout ? "the page ran out" : "not this verse";
  // Ultra offers no help (examples 0); the "show examples" setting can also force 0.
  const n = settings.showExamples ? currentMode.examples : 0;
  let help = "";
  if (n > 0) {
    let pool = currentSongs;
    // Double Trouble: don't showcase a song the player already named on this page (e.g.
    // they got the first of the pair, then missed the second) — only surface fresh options.
    if (currentChallenge && currentChallenge.rule === "multi" && roundNamed.length)
      pool = pool.filter((s) => !roundNamed.includes(s.title));
    const examples = shuffle(pool.slice()).slice(0, n);
    const cards = examples.map((s) => lyricCard(s, currentWord, true, null, true)).join("");
    help = `<span class="red-note">songs that hold "<b>${escapeHtml(currentWord)}</b>"</span>${cards}`;
  }
  fb.innerHTML = `
    <div class="banner bad">✗ ${reason}</div>
    ${help}
    <button id="continueBtn" class="btn-ghost">next page →</button>`;
  feedbackShownAt = Date.now();
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
  runFolded = true;   // this run's stats are saved here in full; block any unload re-fold
  clearTimer();
  clearTimeout(hintUrgeTimer);
  clearTimeout(vanishTimer);
  resetTension();
  applyEra(FINALE_ERAS[Math.floor(Math.random() * FINALE_ERAS.length)]);

  // Challenges and Album Focus are sandboxed — their own self-contained results path,
  // before any stats/records/achievement fold runs.
  if (gameType === "challenge") { endChallenge(); return; }
  if (gameType === "album") { endAlbumFocus(); return; }
  if (gameType === "adaptive") { endAdaptive(); return; }

  const isInfinite = gameType === "infinite";
  const isDaily = gameType === "daily";
  const roundsSurvived = roundResults.length;
  const boardScore = isInfinite ? roundsSurvived : score;  // infinite ranks by how far you got
  const mode = boardMode();

  // Completion time (sum of per-round answer seconds, capped per round). Only meaningful
  // when there's a clock — Relaxed (seconds 0) has no time. Used as the records speed metric.
  const runTime = currentMode.seconds > 0 ? gameTimeSum : null;

  // Log every finished run to the chronological history (classic / infinite / daily).
  // devNoLog (a dev cheat) skips every persistence fold so test runs don't dirty the data.
  if (!devNoLog) appendHistory({
    s: boardScore, c: score, n: roundsSurvived,
    m: isDaily ? "daily" : mode, t: gameType,
    d: new Date().toISOString(), tm: runTime,
    ...(verseBonus > 0 ? { v: verseBonus } : {}),
    ...(hintsUsed > 0 ? { h: 1 } : {}),
  });

  // Daily plays don't touch any mode's stats board. A hinted run counts toward
  // played/average/distribution but can't set any "best" (countBest = false).
  if (!isDaily && !devNoLog) updateStats(boardScore, mode, gameMaxStreak, hintsUsed === 0);

  // Lifetime per-song / per-word tally (every game type counts — it's a catalog
  // record, not a per-mode board). Powers Favourite Song, Songs Discovered,
  // Favourite Album, Nemesis Word.
  if (!devNoLog) {
    const tally = recordGameTally(roundResults.map((correct, i) => ({
      correct,
      title: roundSongs[i] || null,
      album: roundAlbums[i] || null,
      word: roundWords[i] || null,
    })));
    // "I Hate It Here" — every song in the catalogue answered correctly at least once.
    // Count discovered against allSongs (not raw tally keys) so it's exact.
    if (allSongs.length && allSongs.every((s) => tally.songs[s.title])) unlock("i-hate-it-here");
  }

  // Lifetime cross-game metrics (fastest/avg answer, accuracy, lyric lines, daily totals).
  const metrics = devNoLog ? { noTimeoutStreak: 0, versePerfect: 0 } : recordGameMetrics({
    rounds: roundsSurvived, correct: score,
    timeSumMs: gameTimeSum * 1000, timedRounds: gameTimedRounds,
    fastestMs: gameFastestMs, lyricLines: lyricLineAnswers,
    versePerfect: gameVersePerfect, wholeVerses: gameWholeVerses, verseBonus,
    isDaily, dailyPerfect: isDaily && score === TOTAL_ROUNDS,
    isInfinite, timeouts: gameTimeouts,
  });
  // Lifetime word-perfect-recall milestones (verse-bonus prestige ladder).
  if (!devNoLog) {
    if (metrics.versePerfect >= 10) unlock("got-you-down");
    if (metrics.versePerfect >= 50) unlock("by-heart");
    if (metrics.versePerfect >= 100) unlock("where-i-start");
    if (metrics.versePerfect >= 1000) unlock("clearly-ready");
  }
  const played = totalPlayed();   // classic modes only — infinite/daily tracked separately

  // Record this game type; "Hits Different" needs all three (classic + infinite + daily).
  const typesPlayed = devNoLog ? { classic: false, infinite: false, daily: false } : markTypePlayed(gameType);
  if (typesPlayed.classic && typesPlayed.infinite && typesPlayed.daily) unlock("hits-different");

  // end-of-game achievements (daily counts toward the game-quality ones; infinite deferred)
  const timedMode = currentMode.seconds > 0;   // Relaxed (no clock) skips timing achievements
  if (!isInfinite) {
    if (score === TOTAL_ROUNDS) unlock("mastermind");
    if (score === TOTAL_ROUNDS - 1) unlock("champagne-problems");
    if (score === 0) unlock("anti-hero");
    if (gameTimeouts === 0) unlock("fearless");
    if (metrics.noTimeoutStreak >= 2) unlock("fearless-tv");   // two no-timeout games in a row
    // Clean — a majority win (7+/13) on the clock, no timeouts and no hints leaned on.
    if (timedMode && score >= 7 && gameTimeouts === 0 && hintsUsed === 0) unlock("clean");
    if (currentMode.lyricOnly) unlock("all-too-well");
    if (played >= 1) unlock("enchanted");
    if (played >= 5) unlock("begin-again");
    if (played >= 15) unlock("fifteen");
    const trailingStreak = (() => { let n = 0; for (let i = roundResults.length - 1; i >= 0 && roundResults[i]; i--) n++; return n; })();
    if (roundResults.includes(false) && trailingStreak >= 5) unlock("long-story-short");
    if (currentMode.id === "ultra" && score >= 10) unlock("great-war");
    if (score === TOTAL_ROUNDS && (currentMode.id === "hard" || currentMode.id === "ultra")) unlock("long-live");
    // Mirrorball — a perfect 13/13 logged in every difficulty (updateStats already folded this game).
    if (["easy", "medium", "hard", "ultra"].every((m) => loadStats(m).scoreCounts[TOTAL_ROUNDS] > 0)) unlock("mirrorball");
    // Everything & Nothing All At Once — a majority win (7+/13) logged in every difficulty.
    if (["easy", "medium", "hard", "ultra"].every((m) => loadStats(m).best >= 7)) unlock("everything-nothing");
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
  if (currentMode.lyricOnly && gameFuzzyMatches >= 10) unlock("eyes-closed");
  if (recoveryCount(roundResults) >= 3) unlock("shake-it-off");
  if (hasTriangle(roundSongs)) unlock("the-triangle");
  if (longestBTitleRun(roundResults, roundSongs) >= 3) unlock("my-mind-is-alive");
  if (totalLifetimeMisses() >= 1000) unlock("thousand-cuts");
  if (new Date().getHours() === 0) unlock("midnights");   // played in the midnight hour
  // Safe & Sound — the three most recent finished runs were all classic Easy.
  const recent = loadHistory();
  if (recent.length >= 3 && recent.slice(0, 3).every((h) => h.m === "easy")) unlock("safe-and-sound");

  showScreen("results");
  const keepsakeOpts = isInfinite
    ? { total: Math.max(roundsSurvived, 1), letterBead: false, colors: albumPalette(), hinted: roundHinted, verseTiers: roundVerseTier }
    : { colors: albumPalette(), hinted: roundHinted, verseTiers: roundVerseTier };
  $("resultBracelet").innerHTML = buildBraceletSVG(roundResults, 0, -1, roundAlbums, keepsakeOpts);
  $("finalScore").textContent = boardScore;
  // Verse bonus (fuller lyric recall) rides alongside the score, never folded into it.
  // Hidden on a held-back daily score — it would leak how well the round went.
  const bonusSuffix = (verseBonus > 0 && !(isDaily && settings.hideDailyScore)) ? " · +" + verseBonus + " verse bonus" : "";
  const timeSuffix = (runTime != null && !(isDaily && settings.hideDailyScore)) ? " · " + fmtTime(runTime) : "";
  $("finalSub").textContent = (isInfinite ? "rounds · " + score + " correct" : "out of " + TOTAL_ROUNDS) + timeSuffix + bonusSuffix;
  $("keepGoingBtn").style.display = (isInfinite || isDaily) ? "none" : "";
  renderVerseAnthology();
  if (!isInfinite && score === TOTAL_ROUNDS) celebratePerfect();

  // Daily: persist the result, lock to one play/day, show streak + share (no board).
  if (isDaily) {
    const dateStr = todayKey();
    dailyShareTime = runTime;   // for the copyable result (held back behind reveal if the score is hidden)
    saveDailyResult(dateStr, { score, roundResults: roundResults.slice(), roundAlbums: roundAlbums.slice(), tm: runTime });
    clearDailyProgress(dateStr);   // run finished — drop the resumable in-progress record
    const streak = bumpDailyStreak(dateStr);   // extend (or reset) the consecutive-days streak
    unlock("today-was-a-fairytale");   // finished a Daily Challenge
    if (score === TOTAL_ROUNDS) unlock("daylight");
    if (streak.current >= 7) unlock("story-of-us");
    if (streak.current >= 30) unlock("evermore");
    renderResultRecap();
    dailyRng = null;   // back to Math.random() for any subsequent Classic game
    if (settings.hideDailyScore) $("finalScore").textContent = "?";
    $("namePrompt").style.display = "none";
    hideNewBestBanner();
    document.querySelector("#screen-results .podium-title").textContent = "Today's Result";
    renderDailyResultPanel();
    renderShareButton(dateStr, settings.hideDailyScore);
    return;
  }

  renderResultRecap();

  // Reset any daily-only chrome left over from a previous daily results view.
  document.querySelector("#screen-results .podium-title").textContent = "Your best";
  const staleShare = $("shareBtn");
  if (staleShare) staleShare.remove();
  $("namePrompt").style.display = "none";
  hideNewBestBanner();

  // Every positive run folds into your personal records (best-per-mode); a 0 doesn't
  // (it would never be a best). A hinted run is skipped here too — it can't set a PB,
  // though it's always in the history log either way.
  if (boardScore > 0 && hintsUsed === 0 && !devNoLog) {
    const recTime = isInfinite ? null : runTime;   // infinite ranks by rounds, not speed
    const prevBest = loadRecords(mode)[0];
    const { isBest } = insertRecord(mode, boardScore, todayKey(), recTime, verseBonus);
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
    if (hintsUsed > 0) {
      const note = document.createElement("p");
      note.className = "hint-used-note";
      note.textContent = "hint used — this run won't set a personal best";
      $("resultPodium").appendChild(note);
    }
  }
}

// First personal record with no signature yet → ask for a name once, store it globally,
// and reuse it on every future record (no prompt thereafter). Reuses the #namePrompt markup.
function promptSignOnce(after) {
  const nameDiv = $("namePrompt");
  const p = nameDiv.querySelector("p");
  if (p) p.textContent = "sign your notebook — you will be remembered";
  nameDiv.style.display = "";
  const save = () => {
    const v = ($("nameInput").value || "").trim().slice(0, 20);
    if (v) { settings.playerName = setPlayerName(v); checkPianoEgg(v); }   // keep the in-memory settings in sync (Settings panel reads it)
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

/* ---------- Quit / give up (close the notebook) ---------- */
let quitTimer = null;
// First tap arms the button; a second tap within 3s actually leaves. Guards an
// in-progress run against a stray click. Wired to #quitBtn.
function armQuit() {
  const btn = $("quitBtn");
  if (!btn) return;
  if (btn.classList.contains("armed")) {
    clearTimeout(quitTimer);
    btn.classList.remove("armed");
    btn.textContent = btn.dataset.label;
    quitGame();
    return;
  }
  btn.classList.add("armed");
  btn.textContent = "give up? tap again";
  quitTimer = setTimeout(() => {
    btn.classList.remove("armed");
    btn.textContent = btn.dataset.label;
  }, 3000);
}

// Abandon the in-progress run and return to the start screen. A quit isn't a finished
// game, so nothing is logged to stats / records / history — but two fail-fun
// achievements watch for the way you leave.
function quitGame() {
  if (!screens.game.classList.contains("active")) return;

  // Quit achievements — checked against the live run state, before teardown. Skipped
  // for challenges (sandboxed — a challenge run never fires global achievements).
  if (gameType !== "challenge") {
    // The Bolter: bail in round 1 having typed nothing.
    if (round === 1 && roundResults.length === 0 && !($("songInput").value || "").trim()) {
      unlock("the-bolter");
    }
    // No Closure: answered the first 12 of a 13-round run, then leave the 13th blank.
    if ((gameType === "classic" || gameType === "daily") && roundResults.length === TOTAL_ROUNDS - 1) {
      unlock("no-closure");
    }
  }

  // Save the progress made before quitting, so a partial run still credits the
  // lifetime stats (see foldRunProgress).
  foldRunProgress();

  // Teardown: stop every timer / animation a round may have started.
  clearTimer();
  if (countdownId) { clearInterval(countdownId); countdownId = null; }
  clearTimeout(hintUrgeTimer);
  clearTimeout(vanishTimer);
  clearCurtain();
  challengeRunActive = false;
  resetTension();
  clearEggs();
  roundLocked = false;
  $("feedback").innerHTML = "";
  $("songInput").value = "";

  // Back to the desk. The next game start (startGame / startInfinite / startDaily)
  // calls resetRunState, so the abandoned score/round clear there.
  applyEra("gold");
  renderStartPickers();
  $("startContent").style.display = "";
  flipInToScreen("start");
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
let gameVersePerfect = 0;        // word-perfect-or-better lines this game (lifetime versePerfect / milestones)
let gameWholeVerses = 0;         // whole-verse (4-line) recalls this game (Overachiever fires per-round)
let verseKeepsake = [];          // { line, word, tier } for each perfect+ recall — results-page anthology
let roundVerseTier = [];         // per-round verse tier ("perfect"/"verse") → nib bracelet charm
let lyricAnswerSongs = [];       // titles answered via a lyric line this game (for Someone Has A Favourite Song)
let gameTimeSum = 0;             // total answer time this game, secs (for Perfect Storm)
let gameHitRedZone = false;      // any round answered with ≤3s left this game (for Peace)
let rareStreak = 0;              // consecutive correct rare/scarce words this game (for Diamonds Are Forever)
let gameFuzzyMatches = 0;        // fuzzy (non-verbatim) lyric matches this game (for Wordsmith / Eyes Closed)
let gameTimedRounds = 0;         // rounds answered in a timed mode this game (for the lifetime avg answer time)
let gameFastestMs = null;        // fastest single correct answer this game, ms (for the lifetime fastest-answer metric)

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
  } else if (era === "reputation" && settings.snake && chance(0.5)) {
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
// round. The body follows the head along a travelling sine wave
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
  // The overlay's viewBox is 0..W mapped to the card width (≈1 unit per px) but
  // it overflows visibly onto the desk, so the snake keeps slithering past the
  // card and only despawns once it's fully off the right edge of the window —
  // no tell-tale fade where the user could see it pop out.
  const exitX = (window.innerWidth - card.getBoundingClientRect().left) + 80;

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

    if (nodes[M - 1].x > exitX) {            // whole snake has slithered off the screen
      snakeRaf = null;
      svg.remove();
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
  for (let i = 0; i < 378; i++) {
    const st = document.createElement("span");
    st.className = "ss";
    st.style.left = (Math.random() * 100) + "%";
    st.style.width = st.style.height = (10 + Math.random() * 12) + "px";
    // 3x the fall distance (and matching duration) so the shower lasts ~3x longer;
    // the long fall carries every star off the card's clipped bottom edge while
    // still bright, so none linger resting in a faded state.
    st.style.setProperty("--fall", (1140 + Math.random() * 840) + "px");
    st.style.animationDuration = (4.8 + Math.random() * 4.2) + "s";
    st.style.animationDelay = (Math.random() * 0.8) + "s";
    st.innerHTML = STAR_SVG;
    layer.appendChild(st);
  }
  card.appendChild(layer);
  setTimeout(() => layer.remove(), 10200);

  // Make the whole page sparkle while you sit with a perfect score: a slow gold
  // glow on the card, a soft sheen that sweeps across the paper, and a field of
  // twinkling sparkles scattered over it. Cleared by clearPerfectFX on the next
  // showScreen (so a later non-perfect result doesn't inherit it).
  card.classList.add("perfect");
  const twinkle = document.createElement("div");
  twinkle.className = "twinkle-layer"; twinkle.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 46; i++) {
    const t = document.createElement("span");
    t.className = "tw";
    t.style.left = (Math.random() * 100) + "%";
    t.style.top = (Math.random() * 100) + "%";
    t.style.width = t.style.height = (6 + Math.random() * 11) + "px";
    t.style.animationDuration = (1.4 + Math.random() * 2.2) + "s";
    t.style.animationDelay = (Math.random() * 3.2) + "s";
    t.innerHTML = SPARKLE_SVG;
    twinkle.appendChild(t);
  }
  card.appendChild(twinkle);
  const sweep = document.createElement("div");
  sweep.className = "shine-sweep"; sweep.setAttribute("aria-hidden", "true");
  card.appendChild(sweep);
}

// Strip the perfect-game shimmer (glow class + sparkle/sheen overlays) from the
// results card. Called whenever we change screens so the effect never lingers
// onto a subsequent ordinary result.
function clearPerfectFX() {
  const card = $("screen-results");
  if (!card) return;
  card.classList.remove("perfect");
  card.querySelectorAll(".twinkle-layer, .shine-sweep").forEach((el) => el.remove());
}

/* ---------- Input wiring ---------- */
function wireInput() {
  const input = $("songInput");
  input.addEventListener("input", () => {
    // Hard/Ultra have no autocomplete — you type the full title.
    if (effectiveDropdown()) {
      if (debounceId) clearTimeout(debounceId);
      // Null debounceId when it fires so the Enter handler can tell a *genuinely
      // pending* edit (flush + reset selection) from an already-settled list (leave
      // the arrow-key selection alone). Without this, debounceId stays truthy after
      // firing, so every Enter re-ran updateDropdown and snapped activeIndex back to 0.
      debounceId = setTimeout(() => { debounceId = null; updateDropdown(); }, 120);
    }
    clearTimeout(hintUrgeTimer);            // typing cancels the Relaxed idle nudge
    $("hintBtn").classList.remove("urge");
    handleTypingEggs(input.value);
    renderVerseMeter(input.value);          // live verse-bonus gauge (non-revealing)
  });
  input.addEventListener("keydown", (e) => {
    if ($("settingsModal").classList.contains("open")) return;   // modal is captive
    if (e.key === "Tab" && hintsAllowed()) {
      e.preventDefault();                   // keep focus in the input; reveal a hint instead
      useHint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();        // this keypress submits — don't let it also bubble to the page-advance handler
      // The dropdown refresh is debounced (120ms). If a keystroke is still
      // pending, flush it now so Enter accepts a match for what's *currently*
      // typed — not the previous query's stale top result. With the dropdown
      // off, dropdownItems stays empty and submitAnswer takes the exact-title path.
      if (effectiveDropdown() && debounceId) { clearTimeout(debounceId); debounceId = null; updateDropdown(); }
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
  $("hintBtn").addEventListener("click", () => { useHint(); input.focus(); });
  // After a verdict the input is disabled, so a document-level Enter advances
  // the page: skips the correct-answer countdown, or fires "next page" on a miss.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (!screens.game.classList.contains("active") || !roundLocked) return;
    // Modals are captive — don't let Enter advance the page behind them.
    if ($("settingsModal").classList.contains("open")) return;
    if ($("songModal").classList.contains("open")) return;
    // Only once a verdict is actually on the page — not during the pen-circle
    // animation between submitting and the feedback appearing.
    if (!$("cd") && !$("continueBtn")) return;
    // Brief grace so an Enter still held from submitting can't instantly skip the result.
    if (Date.now() - feedbackShownAt < ENTER_SKIP_GRACE) return;
    // "Enter advances on a miss" off → require a click on the miss/answer screen.
    if (!settings.enterOnMiss && document.querySelector("#feedback .banner.bad")) return;
    e.preventDefault();
    advanceFromFeedback();
  });

  // Lyric-context controls live inside #feedback, whose innerHTML is rebuilt each round,
  // so delegate from the stable container. The toggle expands the inline ±context peek;
  // the nested link opens the full song. Either interaction pauses any auto-advance.
  $("feedback").addEventListener("click", (e) => {
    const toggle = e.target.closest(".lyric-ctx-toggle");
    if (toggle) {
      const card = toggle.closest(".lyric-card");
      const box = card && card.querySelector(".lyric-ctx");
      if (box) {
        const showing = box.hidden;   // currently hidden → we're about to show it
        box.hidden = !showing;
        toggle.setAttribute("aria-expanded", String(showing));
        toggle.textContent = showing ? "hide context" : "in context";
        if (showing) pauseAutoAdvanceForReading();
      }
      return;
    }
    const full = e.target.closest(".lyric-fullsong");
    if (full) openFullSong(full.dataset.song, full.dataset.word);
  });

  // Full-song modal: close on the scrim, the close button, or Escape; trap Tab inside it.
  $("songModalClose").addEventListener("click", closeFullSong);
  $("songScrim").addEventListener("click", closeFullSong);
  document.addEventListener("keydown", (e) => {
    const m = $("songModal");
    if (!m.classList.contains("open")) return;
    if (e.key === "Escape") { e.stopPropagation(); closeFullSong(); return; }
    if (e.key !== "Tab") return;
    const focusable = m.querySelectorAll("button, [href], a");
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
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
function setSelectHTML(key, name, desc, options) {
  const opts = options.map((o) =>
    `<option value="${escapeHtml(o.val)}"${o.val === settings[key] ? " selected" : ""}>${escapeHtml(o.label)}</option>`
  ).join("");
  return `<div class="set-row"><div class="set-label"><span class="set-name">${name}</span>` +
    (desc ? `<span class="set-desc">${desc}</span>` : "") + `</div>` +
    `<div class="set-control"><select class="set-select" id="set-${key}" data-select="${key}" aria-label="${name}">${opts}</select></div></div>`;
}
function setSliderHTML() {
  return `<div class="set-row"><div class="set-label"><span class="set-name">Countdown length</span>` +
    `<span class="set-desc">seconds before the next page auto-turns</span></div>` +
    `<div class="set-control set-slider-row"><input type="range" id="countdownSlider" class="set-slider" min="3" max="8" step="1" value="${settings.countdownSecs}">` +
    `<span class="set-slider-val" id="countdownVal">${settings.countdownSecs}s</span></div></div>`;
}
// Heart-hands gesture (the fan motif) — a line-art icon that caps the signature
// line. fill:currentColor so it era-tints with --ink-accent (set in CSS).
const HEART_HANDS_SVG = `<svg class="np-hands" viewBox="0 14 100 80" width="52" height="42" fill="currentColor" role="img" aria-label="heart hands"><path d="M98.402,59.013c-3.616-4.526-7.108-9.851-9.115-13.895c-0.087-0.175-0.183-0.365-0.285-0.568c-0.017-0.049-0.028-0.098-0.05-0.146c-1.069-2.343-1.792-4.372-2.43-6.162c-1.202-3.376-2.071-5.815-4.251-7.123c-2.077-1.247-3.877-2.375-5.446-3.359c-4.831-3.03-7.505-4.693-9.837-4.542c-0.616,0.041-2.491,0.166-11.093,4.479l-0.19,0.095c-1.822,0.91-4.708,5.807-5.514,9.356c-0.039,0.173-0.041,0.345-0.021,0.512c-0.059,0.069-0.115,0.138-0.171,0.207c-0.056-0.069-0.112-0.137-0.17-0.206c0.021-0.167,0.019-0.339-0.021-0.512c-0.806-3.549-3.691-8.445-5.516-9.357l-0.198-0.099c-8.597-4.308-10.468-4.433-11.083-4.474c-2.35-0.158-5.005,1.512-9.836,4.541c-1.569,0.984-3.369,2.113-5.448,3.36c-2.179,1.308-3.048,3.747-4.25,7.123c-0.638,1.79-1.36,3.818-2.43,6.162c-0.022,0.049-0.034,0.099-0.05,0.148c-0.103,0.202-0.198,0.392-0.284,0.566c-2.005,4.042-5.499,9.366-9.116,13.894c-0.517,0.647-0.412,1.592,0.236,2.108c0.647,0.518,1.592,0.41,2.108-0.235c3.742-4.685,7.366-10.215,9.46-14.434c2.519-5.079,5.242-9.014,6.777-9.793c4.442-2.256,12-5.635,13.238-5.69c0.755,0.147,4.253,1.921,6.132,2.874c2,1.015,2.803,1.415,3.239,1.562c1.096,0.554,5.417,4.374,5.713,5.476c0,0.001,0,0.001,0,0.002c0,0.005,0,0.014,0,0.02c0,0.111-0.004,0.207-0.011,0.279c-0.399-0.054-1.115-0.265-2.136-0.627c-1.298-0.462-2.682-1.342-3.902-2.118l-0.649-0.411c-2.142-1.339-6.262-1.977-10.244-0.208c-2.987,1.326-5.268,4.094-6.102,7.405c-0.608,2.423-0.851,6.237,1.445,10.652c1.882,3.614,6.307,7.71,9.47,8.764c0.227,0.075,0.506,0.164,0.83,0.267c3.089,0.975,11.292,3.563,11.299,8.171c0,0.002,0,0.003,0,0.005c0,0.003,0,0.008,0,0.011c-0.001,0.28-0.039,0.501-0.081,0.647c-0.843-0.205-2.285-0.807-3.684-1.39c-2.012-0.839-4.093-1.707-5.746-2.035c-2.779-0.551-6.172-0.559-9.765-0.568c-5.506-0.013-11.747-0.028-15.941-2.204c-0.735-0.38-1.641-0.094-2.022,0.642s-0.094,1.641,0.641,2.022c0.892,0.463,1.845,0.839,2.842,1.147c-1.248,0.736-2.576,1.577-3.536,2.345c-0.647,0.518-0.752,1.462-0.234,2.108c0.296,0.371,0.732,0.563,1.172,0.563c0.329,0,0.659-0.107,0.936-0.328c1.718-1.374,4.992-3.145,6.133-3.747c3.283,0.434,6.762,0.443,10.001,0.451c3.443,0.009,6.694,0.017,9.188,0.512c1.359,0.27,3.386,1.114,5.175,1.86c1.876,0.782,3.497,1.458,4.629,1.638c0.149,0.023,0.298,0.035,0.444,0.035c0.485,0,0.943-0.133,1.345-0.381c0.401,0.248,0.859,0.381,1.345,0.381c0.146,0,0.295-0.012,0.445-0.035c1.133-0.18,2.753-0.855,4.629-1.638c1.789-0.746,3.816-1.591,5.176-1.86c2.494-0.495,5.746-0.503,9.188-0.512c3.24-0.008,6.719-0.018,10.001-0.451c1.141,0.602,4.412,2.37,6.132,3.746c0.277,0.222,0.607,0.329,0.937,0.329c0.44,0,0.876-0.192,1.172-0.563c0.518-0.647,0.413-1.591-0.233-2.108c-0.96-0.768-2.289-1.61-3.536-2.346c0.997-0.309,1.95-0.686,2.842-1.148c0.735-0.381,1.022-1.286,0.641-2.021c-0.382-0.736-1.287-1.025-2.021-0.641c-4.193,2.175-10.434,2.19-15.94,2.203c-3.592,0.01-6.984,0.018-9.765,0.568c-1.653,0.328-3.734,1.196-5.746,2.035c-1.399,0.583-2.842,1.185-3.685,1.39c-0.042-0.148-0.08-0.372-0.08-0.658c0-4.612,8.209-7.202,11.3-8.177c0.323-0.102,0.604-0.19,0.829-0.266c3.164-1.055,7.589-5.149,9.47-8.764c2.298-4.418,2.054-8.231,1.444-10.653c-0.834-3.31-3.114-6.078-6.101-7.404c-3.985-1.769-8.103-1.131-10.243,0.208l-0.656,0.415c-1.219,0.775-2.6,1.653-3.895,2.113c-1.028,0.365-1.746,0.576-2.145,0.628c-0.003-0.026-0.004-0.063-0.006-0.094c0.001-0.049,0.001-0.088,0.001-0.128c0.339-1.217,4.626-5.006,5.715-5.556c0.438-0.147,1.241-0.547,3.234-1.559c1.88-0.954,5.38-2.729,6.037-2.868c1.338,0.046,8.896,3.426,13.338,5.682c1.532,0.778,4.255,4.713,6.776,9.793c2.095,4.221,5.719,9.751,9.459,14.434c0.517,0.646,1.462,0.753,2.108,0.235C98.813,60.604,98.92,59.66,98.402,59.013z M40.905,31.167c-4.518-2.292-6.288-3.118-7.214-3.184c-2.388-0.181-13.106,5.119-14.675,5.902c0.085-0.066,0.166-0.139,0.256-0.193c2.098-1.258,3.914-2.397,5.498-3.391c3.871-2.427,6.686-4.18,8.042-4.089c0.442,0.03,2.463,0.417,9.938,4.163l0.188,0.093c0.392,0.238,1.262,1.379,2.105,2.868c-0.599-0.422-1.076-0.708-1.304-0.777C43.44,32.454,42.035,31.741,40.905,31.167z M54.653,43.38c1.614-0.574,3.214-1.591,4.499-2.408l0.638-0.403c1.196-0.748,4.273-1.414,7.436-0.01c2.149,0.955,3.798,2.972,4.407,5.395c0.483,1.917,0.667,4.955-1.196,8.536c-1.645,3.161-5.588,6.58-7.757,7.303c-0.214,0.071-0.478,0.154-0.782,0.25C58.879,62.994,52.814,64.91,50,68.705c-2.814-3.794-8.878-5.71-11.896-6.662c-0.305-0.097-0.569-0.18-0.784-0.251c-2.168-0.723-6.112-4.142-7.757-7.303c-1.862-3.579-1.678-6.618-1.197-8.536c0.61-2.423,2.258-4.44,4.409-5.395c3.16-1.405,6.238-0.74,7.436,0.01l0.63,0.398c1.288,0.818,2.89,1.837,4.507,2.413c1.882,0.668,3.439,1.121,4.652,0.516C51.212,44.501,52.769,44.048,54.653,43.38z M66.309,27.983c-0.927,0.066-2.696,0.893-7.218,3.186c-1.128,0.572-2.531,1.284-2.812,1.384c-0.234,0.07-0.721,0.362-1.329,0.791c0.842-1.491,1.71-2.632,2.093-2.866l0.197-0.099c7.672-3.847,9.633-4.146,9.947-4.167c1.392-0.114,4.173,1.663,8.044,4.09c1.584,0.993,3.4,2.132,5.497,3.39c0.089,0.054,0.17,0.126,0.254,0.191C79.409,33.093,68.746,27.789,66.309,27.983z"/></svg>`;

// The "Your name" flyleaf nameplate. The big handwritten line is the input — its id
// stays #set-playerName so wireSettingsBody's existing change handler is reused.
function setNameplateHTML() {
  return `<div class="nameplate">` +
    `<p class="np-kicker">this notebook belongs to</p>` +
    `<div class="np-sigrow">` +
      `<input type="text" class="np-name-input" id="set-playerName" maxlength="20" ` +
      `value="${escapeHtml(settings.playerName || "")}" placeholder="your name" ` +
      `aria-label="Your name" autocomplete="off" spellcheck="false">` +
      HEART_HANDS_SVG +
    `</div>` +
    `<p class="np-hint">signed on every personal record</p>` +
  `</div>`;
}
function setSection(title, inner) { return `<div class="set-section"><p class="set-section-title">${title}</p>${inner}</div>`; }

// The profile-polaroid row: a thumbnail + add/change/remove. The photo never
// leaves the browser, so the copy says so.
function setAvatarRowHTML() {
  const photo = getAvatar();
  const controls = photo
    ? `<button type="button" class="btn-ghost" data-avatar="change">Change photo</button>` +
      `<button type="button" class="btn-ghost" data-avatar="remove">Remove</button>`
    : `<button type="button" class="btn-ghost" data-avatar="change">Add a photo</button>`;
  return `<div class="set-row set-row-avatar"><div class="set-label"><span class="set-name">Your photo</span>` +
    `<span class="set-desc">a polaroid on your records page — stays on this device</span></div>` +
    `<div class="set-control set-avatar">${polaroidHTML(photo, getPlayerName(), { small: true, tilt: -3 })}` +
    `<div class="set-avatar-actions">${controls}</div></div></div>`;
}

// Fallback zone list for the rare browser without Intl.supportedValuesOf — a spread of
// common UTC offsets so a player can still pick a sensible reset day.
const COMMON_TZ_FALLBACK = [
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver",
  "America/Chicago", "America/New_York", "America/Halifax", "America/Sao_Paulo",
  "Atlantic/Azores", "UTC", "Europe/London", "Europe/Paris", "Europe/Athens",
  "Europe/Moscow", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Bangkok",
  "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];
function renderSettingsBody() {
  const diffOpts = [{ val: "last", label: "Last" }].concat(MODE_ORDER.map((m) => ({ val: m, label: MODES[m].label })));
  const statsOpts = [{ val: "all", label: "All" }, { val: "last", label: "Last" }].concat(MODE_ORDER.map((m) => ({ val: m, label: MODES[m].label })));
  const zones = (typeof Intl.supportedValuesOf === "function") ? Intl.supportedValuesOf("timeZone") : COMMON_TZ_FALLBACK;
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzOpts = [{ val: "auto", label: `Auto (detected: ${detectedTz})` }]
    .concat(zones.map((z) => ({ val: z, label: z.replace(/_/g, " ") })));
  const body = $("settingsBody");
  body.innerHTML =
    setSection("Notebook",
      setNameplateHTML() +
      setAvatarRowHTML()
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
      setToggleHTML("stemMatching", "Match word variants", "off = exact word only (love won’t match loving)") +
      setToggleHTML("enableHints", "Hints", "Easy &amp; Relaxed; a hinted run can’t set a personal best") +
      setToggleHTML("censorExplicit", "Censor explicit words", "mask swearing in shown lyrics &amp; titles (f**k, s**t)") +
      setChoiceHTML("defaultGameType", "Default game type", "on launch", [{ val: "last", label: "Last" }, { val: "classic", label: "Classic" }, { val: "infinite", label: "Infinite" }, { val: "adaptive", label: "Adaptive" }]) +
      setChoiceHTML("defaultDifficulty", "Default difficulty", "on launch", diffOpts) +
      setChoiceHTML("defaultStatsTab", "Default stats tab", "which tab opens first", statsOpts)
    ) +
    setSection("Daily challenge",
      setSelectHTML("timezone", "Time zone", "when the daily resets — your local day", tzOpts) +
      `<p class="set-note">Today here is <b>${todayKey()}</b> — the next puzzle drops in ${formatResetCountdown(msUntilDailyReset())}. Changing this shifts your daily’s reset time and can affect your streak.</p>`
    ) +
    setSection("Display &amp; accessibility",
      setChoiceHTML("weekStart", "Week starts on", "first row of the records calendar", [{ val: "mon", label: "Monday" }, { val: "sun", label: "Sunday" }]) +
      setToggleHTML("highContrast", "High contrast", "darker ink, whiter paper") +
      setToggleHTML("colorBlindAlbums", "Colour-blind album colours", "a more distinguishable palette") +
      setToggleHTML("hideDailyScore", "Hide daily score until reveal", "")
    ) +
    setSection("Sound",
      setToggleHTML("sound", "Sound effects", "") +
      `<p class="set-note">no sounds yet — this just saves your preference.</p>`
    ) +
    setSection("Data",
      `<p class="set-note">Your stats, achievements, and records live in this browser’s storage. That’s safe day-to-day, but not fool-proof — clearing your browser data, switching devices, or some private-browsing modes can wipe it. If you’d hate to lose your progress, export a backup now and then.</p>` +
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
        `<button class="danger-btn" data-danger="settings">Reset settings</button>` +
        `<button class="danger-btn wipe" data-danger="all">Clear everything</button>` +
      `</div></div>` +
    setSection("About",
      `<div class="set-about">` +
      `<p>Swift to the Song Association — a songwriter’s-notebook word game. Fan-made and unofficial; lyrics belong to their writers.</p>` +
      `<p> Inspired by ELLE.</p>` +
      `<div class="about-notes">` +
        `<a class="about-note about-note--gh" href="https://github.com/swiftothecore/swift-association" target="_blank" rel="noopener">` +
          `<span class="about-note-paper">` +
            `<svg class="about-note-ico about-note-ico--gh" viewBox="0 0 640 640" aria-hidden="true"><path d="M319.988 7.973C143.293 7.973 0 151.242 0 327.96c0 141.392 91.678 261.298 218.826 303.63 16.004 2.964 21.886-6.957 21.886-15.414 0-7.63-.319-32.835-.449-59.552-89.032 19.359-107.8-37.772-107.8-37.772-14.552-36.993-35.529-46.831-35.529-46.831-29.032-19.879 2.209-19.442 2.209-19.442 32.126 2.245 49.04 32.954 49.04 32.954 28.56 48.922 74.883 34.76 93.131 26.598 2.882-20.681 11.15-34.807 20.315-42.803-71.08-8.067-145.797-35.516-145.797-158.14 0-34.926 12.52-63.485 32.965-85.88-3.33-8.078-14.291-40.606 3.083-84.674 0 0 26.87-8.61 88.029 32.8 25.512-7.075 52.878-10.642 80.056-10.76 27.2.118 54.614 3.673 80.162 10.76 61.076-41.386 87.922-32.8 87.922-32.8 17.398 44.08 6.485 76.631 3.154 84.675 20.516 22.394 32.93 50.953 32.93 85.879 0 122.907-74.883 149.93-146.117 157.856 11.481 9.921 21.733 29.398 21.733 59.233 0 42.792-.366 77.28-.366 87.804 0 8.516 5.764 18.473 21.992 15.354 127.076-42.354 218.637-162.274 218.637-303.582 0-176.695-143.269-319.988-320-319.988l-.023.107z"/></svg>` +
            `<span class="about-note-lbl">The code on GitHub</span>` +
          `</span>` +
        `</a>` +
        `<a class="about-note about-note--ts" href="https://www.taylorswift.com" target="_blank" rel="noopener">` +
          `<span class="about-note-paper">` +
            `<svg class="about-note-sig" viewBox="0 0 803.2 448.9" aria-hidden="true"><path d="M795.6,213.1c-50,5.9-109.4,8.4-141.2,3.5c-9-1.2-24.3,2.1-24,5.3c0.8,2.3,0.6,4.3-0.5,6.1c-5.3,0.7-8.3,4.1-9.2,8c-1,3.9-13.1,2.9-22.8,0.4c-10.7-2.7-24.2-10.3-31.5-18.3c27.3-38.5,52.9-82.6,57.8-106.1c2.9-11.6-2.6-22.3-14.2-25.3c-23.3-5.9-64.1,25-73.7,62.8c-6.9,27.1,0.8,53.8,20.4,70.2c-14.4,16-32.4,39.7-48.5,65.1c-0.7-17.7-37.4-51.8-46.2-54c-3.9-1-15.1,6.5-20.1,6.2c27.2-22,48.6-45.5,57.5-80.4c12.5-49.4-28.7-135.2-100.5-153.3c-49.4-12.5-110.6,9.1-126.1,70.2c-12,47.5-9.1,138-17.2,235c-47.1,10.8-108.5,12.8-155,1C27,291-2.9,242.1,11.3,185.9c8.6-33.9,25.8-49.2,26.6-52.1c1.7-6.8-7.3-8-9.2-4.4C24.8,136.7,11.4,152.9,4,182c-20.1,79.5,38.7,120.2,96.9,134.9c38.8,9.8,120.5,8.8,155.2-2c-2.8,31.3-3.6,71.3,1.2,97.3c4.1,20.6,7.9,34,16.6,36.2c4.8,1.2,9.2,0.3,10-2.6c0.8-3.3-0.6-4.1-3-3.6c-1.4,0.3-2.9-0.1-4-1.1c-5.2-4.6-10.6-19.5-11.8-31c-2.6-26.4-3.9-61.9-0.2-97c53.4-11.2,109.2-32.2,154.9-61.9c11.4-0.2,23.5-3.3,31.1-8.6c5.8,1.5,6.1-3.6,12.9-1.9c11.6,2.9,40.6,39.2,37.7,50.8c-1.2,4.8-36.7,39.2-48.7,66.1c-6.3,12.8,2.4,10.9,6.8,10c21.8-4.8,45.2-23.6,50.8-45.9c2.5-9.7,2-20.1,0.3-29.8c20-27.5,40-55.1,50.9-66.6c13.5,9.4,22,14.9,39.5,19.3c11.6,2.9,18.1,2.4,23.3,1.8c4.8,5.6,10.9,10,18.6,11.9c14.5,3.7,28.6,1.1,30.1-4.8c3.4-13.6-28.6-21.7-27.3-26.5c1.5-5.8,68.1,3.8,111.6-0.7c3.2-0.2,4.4,3.2,1,4.4c-21.6,3.8-84.8,49.7-94.8,89.5c-1.5,5.8-2.5,9.7-2.2,12.8c0.6,4.3,2.5,5.6,4.3,4.1c0.8-0.7,1.3-1.8,1.3-2.9c0.1-3.1,0.5-4.3,2.4-8.4c31.8-80.7,118.4-92.8,132.2-102.7C805,220.7,803.1,211.9,795.6,213.1z M394.1,242.5c-4.8-1.2-8.7-2.2-9-5.4c4.9-5.8,10.2-11.9,11.2-15.7c0.7-2.9-1.2-7.5-6.8-5.8c-5.6,1.7-8.5,5.1-11.9,10.4c-6.1-4.6-12.8-10.5-23.5-13.2c-13.6-3.4-30.1,8.9-33.5,22.5c-3.2,12.6-0.3,21.6,12.3,24.8c10.7,2.7,36.4-5.2,45.4-16.4c7,4.9,14.5,7.8,25.7,8.6c-31.1,21-83.3,39.8-139.4,53.4c6.1-89.2,5.1-183.3,16.2-227C294.6,24.4,343.4-5.5,396.7,8c51.4,13,111.1,82.8,93.7,151.6C479.8,197.2,431.7,253.1,394.1,242.5z M375.2,235.7c-1.2,4.8-29.6,19.3-41.3,16.4c-3.9-1-6.8-5.8-4.6-14.6c2.7-10.7,13.2-19.4,23.3-18.9c5.1,0.3,10.7,7.8,18.9,11C375.5,230.6,375.7,233.7,375.2,235.7z M466.5,355.7c-1.5,0.4-2.7-1.1-2.1-2.5c6.4-14.4,36.6-51.7,38.4-51.2c1.9,0.5,1.7,9.7,0,16.5C497.8,338.1,475.8,353.3,466.5,355.7z M560.3,213.4c-12.6-11.4-23.4-33.8-17.3-58c9.5-37.6,40-60.7,66.5-61c3.4,0,6.5,2.3,7.2,5.6c0.7,3.3,0.2,7.7-0.9,11.9C611.7,128.4,582.5,187,560.3,213.4z M647.1,241.2c2.2-1,4.9-0.7,6.8,0.8c3,2.4,6.1,4.5,9.2,5.6c-0.3,9.2-25.7,3.8-23.8-3.9C641.9,243.3,644.5,242.4,647.1,241.2z"/></svg>` +
            `<span class="about-note-lbl">Taylor’s website</span>` +
          `</span>` +
        `</a>` +
        `<a class="about-note about-note--elle" href="https://www.youtube.com/playlist?list=PLG8Rnf78qVIHDRXoJrg6E4jXNTJM_Hc9a" target="_blank" rel="noopener">` +
          `<span class="about-note-paper">` +
            `<svg class="about-note-ico about-note-ico--yt" viewBox="0 0 32 32" aria-hidden="true"><path d="M29.41,9.26a3.5,3.5,0,0,0-2.47-2.47C24.76,6.2,16,6.2,16,6.2s-8.76,0-10.94.59A3.5,3.5,0,0,0,2.59,9.26,36.13,36.13,0,0,0,2,16a36.13,36.13,0,0,0,.59,6.74,3.5,3.5,0,0,0,2.47,2.47C7.24,25.8,16,25.8,16,25.8s8.76,0,10.94-.59a3.5,3.5,0,0,0,2.47-2.47A36.13,36.13,0,0,0,30,16,36.13,36.13,0,0,0,29.41,9.26ZM13.2,20.2V11.8L20.47,16Z"/></svg>` +
            `<span class="about-note-lbl">ELLE’s Song Association</span>` +
          `</span>` +
        `</a>` +
      `</div>` +
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
  body.querySelectorAll("[data-select]").forEach((sel) => sel.addEventListener("change", () => {
    settings[sel.dataset.select] = sel.value;
    saveSettings(settings);
    renderDailyButtonState();   // refresh the start-screen button + countdown live
    renderSettingsBody();       // refresh the "today here is…" note
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
    checkPianoEgg(settings.playerName);
    refreshStartBoard();   // re-sign the start-screen records live
    if (screens.records.classList.contains("active")) renderRecordsPage();
  });
  body.querySelectorAll("[data-avatar]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.avatar === "remove") applyAvatar("");
    else chooseAvatar((url) => applyAvatar(url));
  }));
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
  else if (which === "ach") {
    resetAchievements();
    earnedAchievements = loadAchievements();
    // also lift the sacrifice tombstones (charms become re-earnable; spent tokens stay)
    const w = loadChallengeTokens(); w.burnedAchievements = []; saveChallengeTokens(w);
    burnedAchIds = new Set();
    if (screens.achievements.classList.contains("active")) renderAchievementsPage();
  }
  else if (which === "tally") resetTally();
  else if (which === "daily") resetDaily();
  else if (which === "settings") {
    // Revert every preference to its default, but keep the player's signature
    // and the runtime "last game type" memory — those aren't a tuned preference.
    settings = { ...DEFAULT_SETTINGS, playerName: settings.playerName, lastGameType: settings.lastGameType };
    saveSettings(settings);
    applySettings();
  }
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
// Element focused before the modal opened, so focus can be returned there on close
// (usually #songInput mid-game or the gear) instead of being lost to the hidden page.
let lastFocusedBeforeSettings = null;
let lastFocusedBeforeSong = null;

// Reading lyric context shouldn't let the page turn out from under the reader, so any
// running correct-answer countdown is cancelled the moment they expand context or open
// the full song. The manual "skip"/Enter path stays available to advance when ready.
function pauseAutoAdvanceForReading() {
  if (countdownId) { clearInterval(countdownId); countdownId = null; }
  const cd = document.querySelector("#feedback .countdown");
  if (cd) cd.innerHTML = `<span class="cd-paused">take your time</span>`;
}

// Build the full lyrics for the song modal: structured sections with their labels, every
// line holding the prompt word highlighted (and used as the scroll anchor). Falls back to
// the flat lyrics if a song somehow has no structured sections.
function fullSongHTML(song, word) {
  const sections = (Array.isArray(song.sections) && song.sections.length)
    ? song.sections
    : [{ label: "", lines: (song.lyrics || "").split("\n") }];
  return sections.map((sec) => {
    const lines = (sec.lines || []).map((raw) => {
      const l = (raw || "").trim();
      if (!l) return "";
      return word && wordRegex(word).test(l)
        ? `<div class="lc-line lc-match">${highlightWord(l, word)}</div>`
        : `<div class="lc-line">${escapeHtml(censor(l))}</div>`;
    }).join("");
    const label = sec.label ? `<div class="fs-label">${escapeHtml(sec.label)}</div>` : "";
    return `<div class="fs-section">${label}${lines}</div>`;
  }).join("");
}

function openFullSong(title, word) {
  const song = allSongs.find((s) => s.title === title);
  if (!song) return;
  lastFocusedBeforeSong = document.activeElement;
  pauseAutoAdvanceForReading();
  const color = albumColor(song.album) || "var(--ink-soft)";
  const albumLabel = song.album ? `<span class="album-tag" style="--album-color:${color}">${escapeHtml(song.album)}</span>` : "";
  $("songModalTitle").innerHTML = `${escapeHtml(censor(song.title))}${albumLabel}`;
  $("songModalBody").innerHTML = fullSongHTML(song, word);
  const m = $("songModal");
  m.style.setProperty("--album-color", color);
  m.classList.add("open");
  m.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  const close = $("songModalClose");
  if (close) { try { close.focus({ preventScroll: true }); } catch (_) { close.focus(); } }
  // Land the reader on the first highlighted line rather than the top of the song.
  const match = $("songModalBody").querySelector(".lc-match");
  if (match) { try { match.scrollIntoView({ block: "center" }); } catch (_) { /* ignore */ } }
}

function closeFullSong() {
  const m = $("songModal");
  if (!m.classList.contains("open")) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden", "true");
  // Settings may also be open behind it (its own scroll lock); only release the page
  // freeze when nothing else needs it.
  if (!$("settingsModal").classList.contains("open")) document.body.classList.remove("modal-open");
  const back = lastFocusedBeforeSong;
  lastFocusedBeforeSong = null;
  if (back && typeof back.focus === "function" && document.contains(back)) {
    try { back.focus({ preventScroll: true }); } catch (_) { back.focus(); }
  }
}

function openSettings() {
  unlock("i-look-in-windows");
  lastFocusedBeforeSettings = document.activeElement;
  pauseForSettings();
  renderSettingsBody();
  const m = $("settingsModal");
  m.classList.add("open");
  m.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");   // freeze the page behind the modal
  // Move focus into the dialog so keyboard/SR users land inside it (and the focus
  // trap has somewhere to start). The close button is a safe, always-present target.
  const close = $("settingsCloseBtn");
  if (close) { try { close.focus({ preventScroll: true }); } catch (_) { close.focus(); } }
}
function closeSettings() {
  const m = $("settingsModal");
  if (!m.classList.contains("open")) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  resumeFromSettings();
  // Restore focus to wherever it was before opening (falls back to the gear).
  const back = lastFocusedBeforeSettings;
  lastFocusedBeforeSettings = null;
  const target = (back && typeof back.focus === "function" && document.contains(back)) ? back : $("settingsGear");
  if (target) { try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); } }
}

// Wheel over the dimmed backdrop (outside the dialog) still scrolls the dialog,
// so the cursor doesn't have to be on the panel for the wheel to work.
function routeSettingsWheel(e) {
  const card = document.querySelector(".settings-card");
  if (!card) return;
  if (card.contains(e.target)) return;   // already over the panel — let it scroll natively
  const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? card.clientHeight : 1;
  card.scrollTop += e.deltaY * factor;
  e.preventDefault();
}

/* ---------- Dev cheats (flag-gated; the panel itself lives in js/dev.js) ---------- */
// Activation: append ?dev=swift13 to the URL once to arm (persists in localStorage),
// ?dev=0 to disarm. The param is stripped from the URL afterwards so it isn't shared.
const DEV_FLAG = "swiftSongAssociation.dev";
function devActive() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.has("dev")) {
      const v = params.get("dev");
      if (v === "0" || v === "off") localStorage.removeItem(DEV_FLAG);
      else if (v === "swift13" || v === "1") localStorage.setItem(DEV_FLAG, "1");
      params.delete("dev");
      const qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    }
    return localStorage.getItem(DEV_FLAG) === "1";
  } catch (e) { return false; }
}

// Re-point the *current* live round to a chosen prompt word without advancing.
function devApplyWord(word) {
  if (!word) return;
  currentWord = word;
  if (!usedWords.includes(word)) usedWords.push(word);
  currentSongs = validSongs(currentWord, effectiveStrict(), effectiveNoTitle());
  roundHintSong = pickHintSong();
  $("wordDisplay").textContent = currentWord;
  renderExcludedNote();
  renderHintAffordance();
}

// Answer the current live round. kind: "correct" | "wrong" | "timeout".
function devAnswer(kind) {
  if (!screens.game.classList.contains("active")) return;
  if (roundLocked) { advanceFromFeedback(); return; }   // a verdict is showing → just turn the page
  if (kind === "timeout") { submitAnswer(null, true); return; }
  if (kind === "wrong") {
    const bad = allSongs.find((s) => !currentSongs.some((c) => c.title === s.title));
    if (bad) submitAnswer(bad); else submitAnswer(null, true);
    return;
  }
  if (currentSongs.length) submitAnswer(currentSongs[0]);   // correct
}

/* Timer cheats — operate on the live interval (timerStart) or a frozen value. */
function devTimerFreeze() {
  if (!timerId) return false;
  devFrozenRemaining = Math.max(0, currentMode.seconds - (performance.now() - timerStart) / 1000);
  clearTimer();
  return true;
}
function devTimerUnfreeze() {
  if (devFrozenRemaining == null) return;
  startTimer(devFrozenRemaining);
  devFrozenRemaining = null;
}
function devTimerAdd(secs) {
  if (timerId) timerStart += secs * 1000;
  else if (devFrozenRemaining != null) devFrozenRemaining = Math.max(0, devFrozenRemaining + secs);
}
function devTimerSet(secs) {
  if (timerId) timerStart = performance.now() - (currentMode.seconds - secs) * 1000;
  else if (devFrozenRemaining != null) devFrozenRemaining = secs;
}
function devTimerDisable() {
  clearTimer();
  devFrozenRemaining = null;
  const wrap = document.querySelector(".timer-wrap");
  if (wrap) wrap.style.display = "none";
}

// Build and finish a whole game in one shot (fills the per-round arrays from real
// data, then runs the genuine endGame so results / records / achievements all fire).
function devSimulate(correctCount, opts = {}) {
  const type = opts.type || "classic";
  gameType = type === "infinite" ? "infinite" : type === "daily" ? "daily" : "classic";
  if (opts.mode && MODES[opts.mode]) currentMode = MODES[opts.mode];
  if (gameType === "daily") currentMode = MODES.medium;
  resetRunState();
  if (gameType === "infinite") lives = startingLives();
  const total = TOTAL_ROUNDS;
  const want = Math.max(0, Math.min(correctCount, total));
  for (let i = 0; i < total; i++) {
    round = i + 1;
    const word = pickWord();
    currentWord = word;
    const valid = validSongs(word, effectiveStrict(), currentMode.noTitle);
    const correct = i < want && valid.length > 0;
    roundWords[i] = word;
    roundResults[i] = correct;
    if (correct) {
      const song = valid[Math.floor(Math.random() * valid.length)];
      roundAlbums[i] = song.album || null;
      roundSongs[i] = song.title;
      score++;
      correctStreak++;
      gameMaxStreak = Math.max(gameMaxStreak, correctStreak);
      gameTimedRounds++;
      gameTimeSum += 2;
    } else {
      roundAlbums[i] = null;
      roundSongs[i] = null;
      correctStreak = 0;
      gameTimeouts++;
      if (gameType === "infinite") lives--;
    }
  }
  round = total;
  endGame();
}

/* Seeding helpers — fabricate plausible data from the real catalog. */
function devSeedRecords() {
  const today = todayKey();
  MODE_ORDER.forEach((m, mi) => {
    for (let k = 0; k < 3; k++) {
      const sc = Math.max(1, TOTAL_ROUNDS - k - (mi % 3));
      const time = m === "relaxed" ? null : 30 + k * 8 + Math.random() * 10;
      insertRecord(m, sc, today, time);
    }
  });
}
function devSeedHistory(n = 25) {
  const modes = ["easy", "medium", "hard", "ultra", "lyricist"];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const m = modes[Math.floor(Math.random() * modes.length)];
    const c = Math.floor(Math.random() * (TOTAL_ROUNDS + 1));
    appendHistory({ s: c, c, n: TOTAL_ROUNDS, m, t: "classic",
      d: new Date(now - i * 7 * 3600 * 1000).toISOString(), tm: 30 + Math.random() * 60 });
  }
}
function devSeedTally(games = 6) {
  for (let g = 0; g < games; g++) {
    const rounds = [];
    for (let i = 0; i < TOTAL_ROUNDS; i++) {
      const s = allSongs[Math.floor(Math.random() * allSongs.length)];
      const correct = Math.random() < 0.7;
      rounds.push({ correct, title: correct ? s.title : null,
        album: correct ? (s.album || null) : null,
        word: playableWords[Math.floor(Math.random() * playableWords.length)] });
    }
    recordGameTally(rounds);
  }
}
function devUnlockAllAch() {
  const d = new Date().toISOString().slice(0, 10);
  ACHIEVEMENTS.forEach((a) => { earnedAchievements[a.id] = d; });
  saveAchievements(earnedAchievements);
}
function devLockAllAch() { resetAchievements(); earnedAchievements = {}; }

// The single curated surface handed to the dev panel. Getters read live module
// state on each call; the rest are thin wrappers over the game's own functions.
function buildDevApi() {
  return {
    MODES, MODE_ORDER, ERAS, ACHIEVEMENTS,
    getState: () => ({
      screen: Object.keys(screens).find((k) => screens[k].classList.contains("active")),
      round, score, total: TOTAL_ROUNDS,
      mode: currentMode.id, gameType, infiniteVariant, lives,
      era: document.body.getAttribute("data-era"),
      word: currentWord, roundLocked,
      hintsUsed, devNoLog, devDate: window.__devDate || null,
      valid: currentSongs.map((s) => ({
        title: s.title, album: s.album || null,
        line: extractLineWithWord(s.lyrics, currentWord),
      })),
    }),
    words: () => playableWords.slice(),
    // Round control
    answer: devAnswer,
    advance: () => advanceFromFeedback(),
    setWord: devApplyWord,
    setScore: (n) => { score = Math.max(0, n | 0); },
    jumpToRound: (n) => { round = Math.max(0, (n | 0) - 1); clearTimer(); advanceRound(); startTimer(); },
    endNow: () => endGame(),
    simulate: devSimulate,
    // Start games
    start: (mode) => { if (mode && MODES[mode]) setMode(mode); startGame(); },
    startInfinite: (variant) => startInfinite(variant || infiniteVariant),
    startDaily: () => startDaily(),
    // Word / era / mode
    setEra: (era) => applyEra(era),
    setMode: (id) => setMode(id),
    // Timer
    timer: { freeze: devTimerFreeze, unfreeze: devTimerUnfreeze, add: devTimerAdd,
             set: devTimerSet, disable: devTimerDisable },
    // Daily
    daily: {
      resetToday: () => clearDailyResult(todayKey()),
      clearProgress: () => clearDailyProgress(todayKey()),   // drop the in-progress resume record
      hasProgress: () => !!loadDailyProgress(todayKey()),
      setDate: (d) => { window.__devDate = d || null; },
      setStreak: (current, best, lastPlayed) =>
        saveDailyStreak({ current: current | 0, best: Math.max(best | 0, current | 0),
          lastPlayed: lastPlayed || todayKey() }),
    },
    // Seeding
    seed: { records: devSeedRecords, history: devSeedHistory, tally: devSeedTally,
            unlockAch: devUnlockAllAch, lockAch: devLockAllAch,
            fireAch: (id) => unlock(id),
            removeAch: (id) => { if (earnedAchievements[id]) { delete earnedAchievements[id]; saveAchievements(earnedAchievements); } },
            setName: (n) => { settings.playerName = setPlayerName(n); } },
    // Resets
    reset: { records: resetRecords, stats: resetStatsAll, ach: () => { resetAchievements(); earnedAchievements = {}; },
             tally: resetTally, daily: resetDaily, all: clearAllData },
    // Visual eggs
    eggs: { snake: () => slitherSnake(), doodle: (k) => addDoodle(k || "cat", "corner-br", 60, 60),
            sparkle: () => celebrateCorrect(3), starShower: () => celebratePerfect(),
            blueWash: () => triggerBlueWash(), secret13: () => revealSecret13(),
            pen: (p) => setPen(p || null) },
    // Misc
    setNoLog: (on) => { devNoLog = !!on; },
    reload: () => location.reload(),
    goStart: () => { showScreen("start"); $("startContent").style.display = ""; refreshStartBoard(); },
  };
}

/* ---------- Init ---------- */
async function init() {
  showScreen("start");
  applyEra("gold");
  earnedAchievements = loadAchievements();
  burnedAchIds = new Set(loadChallengeTokens().burnedAchievements || []);
  burnedAchIds.forEach((id) => delete earnedAchievements[id]);   // sacrificed charms never count
  settings = loadSettings();
  applySettings();
  migrateRecordsFromStats();   // seed records from pre-existing stats once, before any game runs
  console.log("%c♡ written in the margins · 13 pages of you ♡", "font-size:14px;color:#a9791f;font-family:cursive;");
  currentMode = loadMode();
  // Default game type on launch (or restore the last one clicked).
  gameType = GAME_TYPES.includes(settings.defaultGameType) ? settings.defaultGameType
           : (GAME_TYPES.includes(settings.lastGameType) ? settings.lastGameType : "classic");
  renderStartPickers();
  const titleEl = document.querySelector("header.title h1");
  if (titleEl) titleEl.addEventListener("click", () => {
    if (++titleTaps >= 13) { titleTaps = 0; revealSecret13(); }
  });
  $("playBtn").addEventListener("click", () => {
    if (gameType === "infinite") startInfinite(infiniteVariant);
    else if (gameType === "adaptive") startAdaptive();
    else startGame();
  });
  $("dailyBtn").addEventListener("click", startDaily);
  $("statsBtn").addEventListener("click", () => { statsBackTarget = "start"; renderStats(null); flipAwayToScreen("stats"); });
  $("resultsStatsBtn").addEventListener("click", () => { statsBackTarget = "results"; renderStats(score); flipAwayToScreen("stats"); });
  $("statsBackBtn").addEventListener("click", () => {
    const prev = statsBackTarget;
    if (prev === "start") { $("startContent").style.display = ""; }
    flipInToScreen(prev);
  });
  $("recordsBtn").addEventListener("click", () => openRecords("start"));
  $("viewRecordsBtn").addEventListener("click", () => openRecords("results"));
  $("recordsBackBtn").addEventListener("click", () => {
    const prev = recordsBackTarget;
    if (prev === "start") { $("startContent").style.display = ""; }
    flipInToScreen(prev);
  });
  $("achievementsBtn").addEventListener("click", () => openAchievements("start"));
  $("viewAchievementsBtn").addEventListener("click", () => openAchievements("results"));
  $("achievementsBackBtn").addEventListener("click", () => {
    const prev = achievementsBackTarget;
    if (prev === "start") { $("startContent").style.display = ""; }
    flipInToScreen(prev);
  });
  $("songbookBackBtn").addEventListener("click", () => {
    const prev = songbookBackTarget;
    if (prev === "start") { $("startContent").style.display = ""; }
    flipInToScreen(prev);
  });
  $("challengesBtn").addEventListener("click", () => openChallenges("start"));
  $("viewChallengesBtn").addEventListener("click", () => openChallenges("results"));
  $("challengesBackBtn").addEventListener("click", () => {
    const prev = challengesBackTarget;
    if (prev === "start") { $("startContent").style.display = ""; }
    flipInToScreen(prev);
  });
  $("albumFocusBtn").addEventListener("click", () => openAlbumFocus("start"));
  $("albumFocusBackBtn").addEventListener("click", () => {
    const prev = albumFocusBackTarget;
    if (prev === "start") { $("startContent").style.display = ""; }
    flipInToScreen(prev);
  });
  $("againBtn").addEventListener("click", () => {
    applyEra("gold");
    renderStartPickers();
    showScreen("start");
    $("startContent").style.display = "";
  });
  // Roll a finished classic run straight into endless play, carrying the score.
  $("keepGoingBtn").addEventListener("click", () => startInfinite("3lives", { carry: true }));
  // Quit / give up mid-game — first tap arms, second tap leaves (see armQuit).
  $("quitBtn").addEventListener("click", armQuit);

  // Settings modal — openable from any screen (gear), closed by ✕, scrim, or ESC.
  $("settingsGear").addEventListener("click", openSettings);
  $("settingsCloseBtn").addEventListener("click", closeSettings);
  $("settingsScrim").addEventListener("click", closeSettings);
  $("settingsModal").addEventListener("wheel", routeSettingsWheel, { passive: false });
  // Focus trap: keep Tab/Shift+Tab cycling within the open dialog.
  $("settingsModal").addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || !$("settingsModal").classList.contains("open")) return;
    const card = document.querySelector(".settings-card");
    if (!card) return;
    const focusables = Array.from(
      card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Leaving the page mid-game (reload / close) still banks the progress made so
  // far, exactly like the quit button. Skipped for bfcache restores (persisted),
  // where the in-memory game just resumes.
  window.addEventListener("pagehide", (e) => {
    if (e.persisted) return;
    if (screens.game.classList.contains("active")) foldRunProgress();
  });
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
  setupTooltips();

  try {
    await loadData();
    $("loading").style.display = "none";
    $("startContent").style.display = "";
    refreshStartBoard();
    maybeStartFromWordParam();   // "Play this word" deep-link from the searcher
  } catch (err) {
    $("loading").outerHTML = `
      <div class="error">
        <p><b>Couldn't open the notebook.</b></p>
        <p>${escapeHtml(err.message)}</p>
        <p>Try refreshing the page.</p>
      </div>`;
  }

  // Dev cheats panel — only loaded behind the ?dev flag, so it costs nothing in
  // normal play. The module is committed but inert until armed (see devActive).
  if (devActive()) {
    try { (await import("./dev.js")).initDev(buildDevApi()); }
    catch (e) { console.warn("dev panel failed to load", e); }
  }
}

document.addEventListener("DOMContentLoaded", init);

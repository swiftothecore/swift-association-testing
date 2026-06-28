// Pure constants & data tables. No state, no DOM — safe to import anywhere.

export const TOTAL_ROUNDS = 13;
export const ROUND_SECONDS = 10;
export const RECENT_WINDOW = 5;

/* ---------- localStorage keys ---------- */
export const HS_KEY = "swiftSongAssociation.highscores";        // legacy fake-celebrity board (dormant; kept for old backups)
export const RECORDS_KEY = "swiftSongAssociation.records";      // personal best runs per mode — { score, date }[]
export const HISTORY_KEY = "swiftSongAssociation.history";      // chronological log of every finished run (capped)
export const STATS_KEY = "swiftSongAssociation.stats";
export const ACH_KEY = "swiftSongAssociation.achievements";
export const DIFF_KEY = "swiftSongAssociation.difficulty";
export const DAILY_KEY = "swiftSongAssociation.daily";
export const DAILY_BOARD_KEY = "swiftSongAssociation.dailyBoard";
export const DAILY_STREAK_KEY = "swiftSongAssociation.dailyStreak";
export const TYPES_KEY = "swiftSongAssociation.typesPlayed";   // {classic,infinite,daily} — for "Hits Different"
export const TALLY_KEY = "swiftSongAssociation.songTally";     // lifetime per-song/per-word tally — Favourite Song, Songs Discovered, Nemesis Word, I Hate It Here
export const SETTINGS_KEY = "swiftSongAssociation.settings";   // user preferences (see DEFAULT_SETTINGS)
export const METRICS_KEY = "swiftSongAssociation.metrics";    // lifetime cross-game counters — fastest/avg answer, accuracy, lyric lines, daily totals
export const CHALLENGES_KEY = "swiftSongAssociation.challenges";        // per-challenge progress — { [id]: {unlocked, defeated, attempts, best} }
export const CHALLENGE_TOKENS_KEY = "swiftSongAssociation.challengeTokens"; // { balance, fromAchievements:[] } — tokens spent to unlock challenges
export const ALBUM_FOCUS_KEY = "swiftSongAssociation.albumFocus";       // per-album best/beaten board — { [album]: {best, bestDiff, beaten, beatenDiff, perfected, perfectedDiff} }
export const ADAPTIVE_KEY = "swiftSongAssociation.adaptive";            // Adaptive mode board — { bestPeak, bestScore, date, played }
export const SEARCH_KEY = "swiftSongAssociation.search";                // Swift To The Lyric searcher — { mode, view, recent:[] }

// Every persisted key shares this namespace; export/import and "clear everything"
// sweep all keys under it.
export const APP_PREFIX = "swiftSongAssociation.";

/* ---------- User settings (the settings panel) ---------- */
// One flat record. loadSettings merges this over whatever's stored, so adding a
// new key here gives existing players a sensible default with no migration.
export const DEFAULT_SETTINGS = {
  // motion & animation
  reduceMotion: "auto",     // "auto" (follow OS) | "on" | "off"
  animSpeed: "normal",      // "normal" | "fast" | "instant"
  pageTurn: true,           // page-flip between rounds
  penCircle: true,          // pen-circle confirm before the verdict
  sparkles: true,           // sparkle burst on a correct answer
  timerTension: true,       // vignette / word tremor / red margin tally in the final seconds
  reducedFlashing: false,   // also suppress the perfect-game star shower
  snake: true,              // the reputation-era slithering snake
  // gameplay pacing
  autoAdvance: true,        // auto-advance countdown after a correct answer
  countdownSecs: 5,         // 3..8 — length of that countdown
  enterOnMiss: true,        // Enter advances past the miss screen
  showExamples: true,       // show example songs after a wrong answer
  stemMatching: true,       // match word variants (love→loving, gold→golden); off = exact word only

  enableHints: true,        // show progressive hints in Easy/Normal/Relaxed (a hinted run can't set a personal best)
  censorExplicit: false,    // mask general profanity (fuck→f**k) in shown lyrics/titles; the racial slur is always masked regardless

  defaultGameType: "last",  // "last" | "classic" | "infinite"
  defaultDifficulty: "last",// "last" | a MODES id
  defaultStatsTab: "all",   // which Stats tab opens first: "all" | "last" | a MODES id
  // display & accessibility
  highContrast: false,
  colorBlindAlbums: false,  // swap ALBUM_COLORS for a colour-blind-friendly palette
  hideDailyScore: false,    // hide the daily score until "reveal & copy"
  timezone: "auto",         // daily-reset zone: "auto" (detect) | an IANA id e.g. "America/New_York"
  weekStart: "mon",         // first row/column of week-based views (the records calendar): "mon" | "sun"
  // meta
  sound: false,             // placeholder — no audio wired yet
  lastGameType: "classic",  // runtime memory backing defaultGameType: "last" (not shown in UI)
  playerName: "",           // notebook signature — set once, reused on every personal record
  avatar: "",               // profile polaroid — a center-cropped data-URL, stays on this device
};

/* Difficulty modes — each just re-tunes existing levers (timer, dropdown,
   word-rarity pool, matching strictness, wrong-answer help). Gameplay code is
   shared; the mode object sets the parameters. */
export const MODES = {
  easy:   { id: "easy",   label: "Easy",   seconds: 15, dropdown: true,  pool: "easy",  strict: false, noTitle: false, examples: 3, hint: true,  blurb: "15s · suggestions & hints · common words" },
  medium: { id: "medium", label: "Normal", seconds: 10, dropdown: true,  pool: "all",   strict: false, noTitle: true,  examples: 3, hint: false, blurb: "10s · suggestions · all words · not in the title" },
  hard:   { id: "hard",   label: "Hard",   seconds: 7,  dropdown: false, pool: "hard",  strict: false, noTitle: true,  examples: 3, hint: false, blurb: "7s · type the full title · rarer words · not in the title" },
  ultra:  { id: "ultra",  label: "Ultra",  seconds: 5,  dropdown: false, pool: "ultra", strict: false, noTitle: true,  examples: 0, hint: false, blurb: "5s · type the full title · rarest · not in the title" },
  // Lyric-only: no title input (lyricOnly), longer clock. You answer by typing a lyric
  // line (a few words around the prompt word are enough — the matcher is fuzzy).
  lyricist: { id: "lyricist", label: "Lyricist", seconds: 20, dropdown: false, pool: "all", strict: false, noTitle: false, examples: 3, hint: false, lyricOnly: true, blurb: "20s · type a lyric line, not the title" },
  // No-timer practice mode (seconds: 0 → startTimer takes the no-timer path). Same
  // forgiving levers as Normal; the only difference is the clock never runs.
  relaxed: { id: "relaxed", label: "Relaxed", seconds: 0, dropdown: true, pool: "all", strict: false, noTitle: false, examples: 3, hint: true,  blurb: "no timer · suggestions & hints · all words" },
};
export const MODE_ORDER = ["relaxed", "easy", "medium", "hard", "ultra", "lyricist"];
// The start-screen picker presents two groups. The ladder (relaxed→ultra) is one axis —
// naming the song, tuned harder or softer. Lyricist is a different MODALITY (answer by a
// lyric line, not a title), so the main picker sets it apart rather than implying it's a
// sixth, "harder than Ultra" rung. MODE_ORDER keeps all six for stats, records, and Album
// Focus, where lyricist legitimately ranks as the top "by heart" tier.
export const DIFFICULTY_LADDER = ["relaxed", "easy", "medium", "hard", "ultra"];
export const MODALITY_MODES = ["lyricist"];
// Per-mode accent for the index-card record tiles (label + tape tint). Keyed by mode id;
// infinite tokens borrow the colour of their underlying difficulty.
export const MODE_COLORS = {
  relaxed:  "#5f87a8",   // denim
  easy:     "#7a9e5e",   // green
  medium:   "#c6912b",   // gold
  hard:     "#bb5640",   // coral-red
  ultra:    "#5a5a66",   // graphite
  lyricist: "#8a78b0",   // lavender
};

/* ---------- Album Focus mode ----------
   "Quiz me on one album": every prompt word and valid answer come from a single studio
   album, played at a chosen difficulty. Sandboxed in its own board (ALBUM_FOCUS_KEY).
   The album list is STUDIO_ALBUMS (the 12 — pseudo-groups are never offered). */
// Every playable mode is offered (in MODE_ORDER). Ultra's rarity bucket can be thin within a
// single album, but pickAlbumWord falls back to the album's full word list, so a 13-round run
// always fills; lyricist answers by lyric line and is album-gated by the soft-reject path.
export const ALBUM_FOCUS_DIFFS = ["relaxed", "easy", "medium", "hard", "ultra", "lyricist"]; // MODES ids the sub-picker offers
export const ALBUM_FOCUS_TARGET = 9;                           // score ≥ this beats an album; === TOTAL_ROUNDS perfects it
// Hardness ranking — the completed-album look scales with the toughest difficulty it was
// beaten/perfected at, so re-beating on a harder mode upgrades the keepsake (see
// recordAlbumFocusRun). Lyricist (recall by lyric line) ranks top as the "by heart" flex.
export const DIFF_RANK = { relaxed: 0, easy: 1, medium: 2, hard: 3, ultra: 4, lyricist: 5 };

/* ---------- Adaptive mode ----------
   A third gameType beside Classic and Infinite. A fixed 13-round run where word RARITY
   alone floats with live performance, on a visible level. The level maps straight onto the
   four rarity buckets; every other lever stays fixed at Normal's baseline. Sandboxed in its
   own board (ADAPTIVE_KEY), ranked on the peak level reached (a floating 0-13 score is not
   comparable, so it is never ranked against the difficulty boards). See PLAN.md section 5. */
export const ADAPTIVE_BUCKETS = [null, "easy", "all", "hard", "ultra"];   // level 1..4 -> wordBuckets key (index 0 unused)
export const ADAPTIVE_LEVELS = [null, "Common", "Deeper", "Rare", "Rarest"]; // level 1..4 -> readable tier name
export const ADAPT_MAX_LEVEL = 4;       // top level (ultra bucket)
export const ADAPT_START_LEVEL = 2;     // start in the middle (the "all" bucket)
export const ADAPT_PROMO_STREAK = 2;    // correct answers at a level needed to climb one (a single miss demotes)
// Anti-too-soft knob: at this level and above, the title dropdown switches off, so the
// rarest tiers test RECALL (type the full title) not just recognition. Set above
// ADAPT_MAX_LEVEL to keep suggestions on for the whole run.
export const ADAPT_NODROP_LEVEL = 3;    // suggestions off from Rare (L3) upward

/* Challenges mode — discrete rule-bending puzzles, unlocked with tokens and "defeated".
   Pure data: each entry declares a `rule` token; app.js dispatches on it (round modifier,
   per-answer judge, win check). Sandboxed like daily — a challenge run never folds into the
   difficulty boards/stats/history/tally/achievements. `mode` fixes the MODES levers it runs
   under (without persisting DIFF_KEY). `free` challenges start unlocked; the rest cost a token. */
export const CHALLENGES = [
  { id: "vanishing-word", name: "Vanishing Word", rule: "vanishing", mode: "medium",
    free: true,  cost: 1, target: 10, revealMs: 1500, tapes: 1, icon: "sparkle",
    desc: "The word vanishes after a moment — answer from memory.",
    win: "Score 10 / 13 with disappearing words." },
  { id: "deep-cut", name: "Deep Cut", rule: "album5", mode: "easy",
    free: false, cost: 1, album: null /* any single album */, tapes: 1, icon: "vinyl",
    desc: "Pull five correct answers from a single album.",
    win: "Answer 5 correct songs from one album." },
  { id: "alphabetical", name: "From A to Z", rule: "alphabetical", mode: "medium",
    free: false, cost: 1, target: 9, pool: "easy", tapes: 3, icon: "book",
    desc: "Each song's title must start no earlier than the last.",
    win: "Land 9 correct answers in non-decreasing A→Z order." },
  { id: "word-modifiers", name: "Word Games", rule: "wordfx", mode: "medium",
    free: false, cost: 1, target: 9, noTitle: false, tapes: 2, icon: "shake",
    desc: "The word warps more each round — read it before it's gibberish.",
    win: "Score 9 / 13 through the distortion." },
  { id: "one-of-a-kind", name: "One Of A Kind", rule: "newsong", mode: "easy",
    free: false, cost: 1, tapes: 1, icon: "gem",
    desc: "You're given one specific song. Slip it in as your answer on a round where it actually fits the word. You get 3 guesses — naming it on a word it doesn't fit costs you one.",
    win: "Answer the named song before your 3 guesses run out." },
  { id: "choose-your-path", name: "Choose Your Path", rule: "path", mode: "medium",
    free: false, cost: 1, target: 9, forks: [4, 8], tapes: 1, icon: "branch",
    desc: "At forks in the run, pick a perk that reshapes the rest.",
    win: "Score 9 / 13 — your way." },
  { id: "wildcard", name: "Wildcard", rule: "wildcard", mode: "medium",
    free: false, cost: 1, target: 9, noTitle: false, tapes: 2, icon: "mask",
    desc: "Every round changes the rule — keep up.",
    win: "Score 9 / 13 across shifting rules." },
  { id: "revolving-door", name: "Revolving Door", rule: "revolving", mode: "medium",
    free: false, cost: 1, target: 9, seconds: 20, rotateMs: 5000, noTitle: true, tapes: 1, icon: "cycle",
    blurb: "20s a page · suggestions · not in the title · the word swaps every 5s",
    desc: "You get 20 seconds a page — but the word swaps for a new one every 5. Answer the one that's showing before it spins away.",
    win: "Score 9 / 13 while the word keeps revolving." },
  { id: "shrinking-timer", name: "Shrinking Timer", rule: "accelerate", mode: "medium",
    free: false, cost: 1, target: 9, noTitle: true, pool: "easy", tapes: 2, icon: "hourglass",
    blurb: "suggestions · not in the title · the clock shrinks every page (16s → 5s)",
    desc: "Each page gives you less time than the last — from 16 seconds down to 5.",
    win: "Score 9 / 13 as the clock keeps shrinking." },
  { id: "title-in", name: "Title...?", rule: "titleHas", mode: "medium",
    free: false, cost: 1, target: 9, noTitle: false, dropdown: false, tapes: 2, icon: "key",
    blurb: "10s · no suggestions · the word must be in the title",
    desc: "Flip the usual rule — name a song whose TITLE contains the word.",
    win: "Score 9 / 13, each answer's title holding the word." },
  { id: "short-title", name: "Short n' Sweet", rule: "shorttitle", mode: "medium",
    free: false, cost: 1, target: 9, pool: "easy", noTitle: false, tapes: 1, icon: "feather",
    blurb: "10s · suggestions · only one- or two-word titles count",
    desc: "Only songs with a one- or two-word title are allowed answers.",
    win: "Score 9 / 13 using only short titles." },
  { id: "lyric-lover", name: "Lyric Lover", rule: "verse", mode: "lyricist",
    free: false, cost: 1, target: 6, tapes: 3, icon: "quote",
    desc: "Answer by typing the lyric line — and recall it word-for-word.",
    win: "Recall 6 lines word-for-word (or better) — type the line exactly." },
  { id: "wrapped-chain", name: "Wrapped Like A Chain", rule: "chain", mode: "medium",
    free: false, cost: 1, target: 6, noTitle: false, pool: "easy", tapes: 3, icon: "scarf",
    blurb: "10s · suggestions · each title starts with the last letter of the one before",
    desc: "Link the songs into a chain — each title must begin with the last letter of your previous answer.",
    win: "Build a chain of 6 linked songs." },
  { id: "on-tour", name: "On Tour!", rule: "setlist", mode: "medium",
    free: false, cost: 1, target: 9, noTitle: false, tapes: 2, icon: "ticket",
    blurb: "10s · suggestions · each page wants a song from that night's album",
    desc: "A setlist of albums, one per page — your answer must come from that night's album.",
    win: "Score 9 / 13 playing each album on cue." },
  { id: "its-a-clock", name: "It's A Clock!", rule: "combo", mode: "medium",
    free: false, cost: 1, target: 9, noTitle: false, pool: "easy", tapes: 2, icon: "bolt",
    blurb: "one shared clock · every right answer winds it back up · run it dry and it's over",
    desc: "Forget per-page timers — one shared clock drains across the whole run. Each correct answer winds it back up; let it hit zero and the run ends.",
    win: "Score 9 / 13 before the shared clock runs out." },
  { id: "switch-up", name: "Switch-Up", rule: "switchup", mode: "medium",
    free: false, cost: 1, target: 9, seconds: 12, noTitle: false, tapes: 1, icon: "refresh",
    blurb: "12s · each page wants EITHER a title OR a sung lyric line — it keeps switching",
    desc: "Every page flips the rules: sometimes name the song's title, sometimes sing a real lyric line. Read the switch before you answer.",
    win: "Score 9 / 13 as the answer type keeps switching." },
  { id: "double-trouble", name: "Double Trouble", rule: "multi", mode: "medium",
    free: false, cost: 1, target: 8, need: 2, pool: "easy", seconds: 18, tapes: 2, icon: "trio",
    blurb: "18s · suggestions · name TWO different songs each page · not in the title",
    desc: "One song isn't enough — each page needs two different songs that both use the word (and the word can't be in either title).",
    win: "Clear 8 pages, naming two different songs each." },
  { id: "devils-path", name: "Devil's Path", rule: "devil", mode: "medium",
    free: false, cost: 1, target: 9, forks: [4, 8], tapes: 2, icon: "triangle",
    blurb: "10s · suggestions · at pages 4 & 8 you must take the lesser of two curses",
    desc: "Choose Your Path's evil twin: at forks in the run you're handed two curses and must take the lesser of two evils. Whatever you pick haunts the rest of the run.",
    win: "Score 9 / 13 despite the curses you take." },
];
export const CHALLENGE_BY_ID = Object.fromEntries(CHALLENGES.map((c) => [c.id, c]));
export const CHALLENGE_ORDER = CHALLENGES.map((c) => c.id);

/* Era engine */
export const ERAS = ["gold", "lavender", "red", "denim", "graphite", "midnight", "debut", "reputation", "lover", "evermore"];
// Album Focus locks the whole run to one era wash — the era that best fits each studio
// album's mood (a couple reuse the closest era; only one album plays per run, so that's fine).
export const ALBUM_ERA = {
  "Taylor Swift": "debut", "Fearless": "gold", "Speak Now": "lavender", "Red": "red",
  "1989": "denim", "reputation": "reputation", "Lover": "lover", "folklore": "graphite",
  "evermore": "evermore", "Midnights": "midnight",
  "The Tortured Poets Department": "graphite", "The Life of a Showgirl": "gold",
};
export const TENDER_ERAS = ["lavender", "denim", "lover", "evermore"];   // round 5 (Track 5) leans tender
export const FINALE_ERAS = ["gold", "midnight", "reputation"];           // round 13 leans grand

/* ---------- Taylor milestones (the start-screen anniversary marginalia) ----------
   Real release dates + her birthday. Matched on month-day (ignore year) so a note
   recurs annually; the "Nth anniversary" is computed from the year. `album` keys into
   ALBUM_ERA / ALBUM_COLORS so a milestone note can wear that era's colour (re-records
   borrow their original album's era). Dec 13 doubles as the game's sacred 13.
   ⚠ Verify every date before editing — fans catch a wrong one instantly. */
export const TS_MILESTONES = [
  { md: "12-13", year: 1989, kind: "birthday", title: "Taylor Swift",                  album: null },
  { md: "10-24", year: 2006, kind: "album",    title: "Taylor Swift", aka: "the debut", album: "Taylor Swift" },
  { md: "11-11", year: 2008, kind: "album",    title: "Fearless",                      album: "Fearless" },
  { md: "10-25", year: 2010, kind: "album",    title: "Speak Now",                     album: "Speak Now" },
  { md: "10-22", year: 2012, kind: "album",    title: "Red",                           album: "Red" },
  { md: "10-27", year: 2014, kind: "album",    title: "1989",                          album: "1989" },
  { md: "11-10", year: 2017, kind: "album",    title: "reputation",                    album: "reputation" },
  { md: "08-23", year: 2019, kind: "album",    title: "Lover",                         album: "Lover" },
  { md: "07-24", year: 2020, kind: "album",    title: "folklore",                      album: "folklore" },
  { md: "12-11", year: 2020, kind: "album",    title: "evermore",                      album: "evermore" },
  { md: "04-09", year: 2021, kind: "tv",       title: "Fearless (Taylor's Version)",   album: "Fearless" },
  { md: "11-12", year: 2021, kind: "tv",       title: "Red (Taylor's Version)",        album: "Red" },
  { md: "10-21", year: 2022, kind: "album",    title: "Midnights",                     album: "Midnights" },
  { md: "07-07", year: 2023, kind: "tv",       title: "Speak Now (Taylor's Version)",  album: "Speak Now" },
  { md: "10-27", year: 2023, kind: "tv",       title: "1989 (Taylor's Version)",       album: "1989" },
  { md: "04-19", year: 2024, kind: "album",    title: "The Tortured Poets Department", album: "The Tortured Poets Department" },
  { md: "10-03", year: 2025, kind: "album",    title: "The Life of a Showgirl",        album: "The Life of a Showgirl" },
];

/* ---------- Album colours (left-rule tint + tag on lyric cards) ---------- */
// The 12 studio albums (explicit so future pseudo-album groups — singles, holiday,
// features — don't dilute album-scoped achievements like The Eras Tour / Branch Out).
export const STUDIO_ALBUMS = [
  "Taylor Swift", "Fearless", "Speak Now", "Red", "1989", "reputation",
  "Lover", "folklore", "evermore", "Midnights",
  "The Tortured Poets Department", "The Life of a Showgirl",
];
export const ALBUM_COLORS = {
  "Taylor Swift":                     "#5a9ea6",
  "Fearless":                         "#b8943a",
  "Speak Now":                        "#8b5fa0",
  "Red":                              "#a32a2a",
  "1989":                             "#4a8fb5",
  "reputation":                       "#555555",
  "Lover":                            "#c4649a",
  "folklore":                         "#9b9b9b",
  "evermore":                         "#7a5a38",
  "Midnights":                        "#3d4f8a",
  "The Tortured Poets Department":    "#b39a7c",
  "The Life of a Showgirl":          "#e07830",
  "Holiday Collection":               "#bcdcec",  // snow blue
  "Songs From Movies":                "#2f6b4f",  // pine green
  "Written for Others":               "#7e7634",  // olive
  "Collaborations":                   "#7a2f4a",  // wine
};
// A colour-blind-friendly alternative (Okabe-Ito / Paul-Tol hues + spread lightness)
// so the 12 albums stay distinguishable for deutan/protan/tritan vision. Same keys
// as ALBUM_COLORS; swapped in when the "colour-blind album colours" setting is on.
export const CB_ALBUM_COLORS = {
  "Taylor Swift":                     "#0072b2",  // blue
  "Fearless":                         "#e69f00",  // orange
  "Speak Now":                        "#cc79a7",  // reddish purple
  "Red":                              "#d55e00",  // vermillion
  "1989":                             "#56b4e9",  // sky blue
  "reputation":                       "#333333",  // near-black
  "Lover":                            "#e78ac3",  // pink
  "folklore":                         "#999999",  // grey
  "evermore":                         "#8c5a2b",  // brown
  "Midnights":                        "#332288",  // indigo
  "The Tortured Poets Department":    "#44aa99",  // teal
  "The Life of a Showgirl":           "#ddcc77",  // sand
  "Holiday Collection":               "#aad4e6",  // pale cyan
  "Songs From Movies":                "#117733",  // green
  "Written for Others":               "#999933",  // olive
  "Collaborations":                   "#882255",  // maroon
};

// Extra accepted spellings for titles whose forgiving forms normalizeTitle can't
// derive (irregular abbreviations). Keyed by the canonical title; each alias is run
// through normalizeTitle at index-build time, so list them readably. The "ten"
// variants fold to their "10" forms automatically, and the full "...10/ten minute
// version" already matches via normalizeTitle — these cover the abbreviations.
export const TITLE_ALIASES = {
  "All Too Well (10 Minute Version)": [
    "all ten well", "all 10 well",
    "all too well 10", "all too well ten",
  ],
  // Remix features people know by the bare title (the "(remix)" form still
  // matches via normalizeTitle); the alias makes the plain name work too.
  "Gasoline (Remix)": ["gasoline"],
  "The Joker And The Queen (Remix)": ["the joker and the queen"],
  // "I Heart ?" reads aloud as "I Heart Question Mark".
  "I Heart ?": ["i heart question mark"],
};

/* ---------- Achievements ---------- */
export const ACH_ICONS = {
  // hung charms: filled bead bodies (ink-fill) with inked detail (ink)
  star:    `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 2.2 L14.7 8.7 L21.7 9.3 L16.3 13.9 L18 20.8 L12 17.1 L6 20.8 L7.7 13.9 L2.3 9.3 L9.3 8.7 Z"/><path class="ink" stroke-width="0.9" opacity="0.7" d="M12 6 L13.2 9.2 L16.6 9.5"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M10.6 1.6 C11.6 7.4 14 9.8 19.8 10.8 C14 11.8 11.6 14.2 10.6 20 C9.6 14.2 7.2 11.8 1.4 10.8 C7.2 9.8 9.6 7.4 10.6 1.6 Z"/><path class="ink-fill" d="M18.8 14.6 C19.2 16.6 19.8 17.2 21.8 17.6 C19.8 18 19.2 18.6 18.8 20.6 C18.4 18.6 17.8 18 15.8 17.6 C17.8 17.2 18.4 16.6 18.8 14.6 Z"/></svg>`,
  shield:  `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 1.8 L20 4.6 V11 C20 16.2 16.6 20.2 12 22.2 C7.4 20.2 4 16.2 4 11 V4.6 Z"/><path class="ink" d="M8.3 11.8 l2.7 2.7 4.8 -5.6"/></svg>`,
  bolt:    `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M13.6 1.8 L4.4 13.6 H10 L9 22.2 L19.6 9.5 H13.3 Z"/><path class="ink" stroke-width="0.9" opacity="0.6" d="M12 6 L9 13"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path class="ink" stroke-width="2.1" d="M19.4 14.2 A8 8 0 1 1 17 6.4"/><path class="ink-fill" d="M17.3 1.4 L19.1 7.6 L12.8 6.7 Z"/></svg>`,
  key:     `<svg viewBox="0 0 24 24"><circle class="ink-fill" cx="8" cy="8" r="5.4"/><circle cx="8" cy="8" r="1.9" fill="var(--paper)"/><path class="ink" d="M11.8 11.8 L20 20 M16.8 16.8 l2.4 -2.4 M14.2 14.2 l2.2 -2.2"/></svg>`,
  gem:     `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M6.6 3 H17.4 L21.6 9 L12 21.6 L2.4 9 Z"/><path class="ink" d="M2.4 9 H21.6 M8.8 3 L6.9 9 L12 21.6 M15.2 3 L17.1 9 L12 21.6"/></svg>`,
  rise:    `<svg viewBox="0 0 24 24"><path class="ink" stroke-width="2.1" stroke-linecap="round" d="M3 19 L9.5 12.5 L13 16 L20.5 6.5"/><path class="ink-fill" d="M14.6 5 L21.5 4 L21 10.8 Z"/></svg>`,
  crown:   `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M2.5 18 L4.5 7.5 L9 12.5 L12 5 L15 12.5 L19.5 7.5 L21.5 18 Z"/><path class="ink" d="M3 18 H21"/><circle class="ink-fill" cx="4.5" cy="7.5" r="1.5"/><circle class="ink-fill" cx="12" cy="5" r="1.5"/><circle class="ink-fill" cx="19.5" cy="7.5" r="1.5"/></svg>`,
  scarf:   `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M5 5 C11 9 13 9 19 5 L20.5 8.5 C14 12.5 10 12.5 3.5 8.5 Z"/><path class="ink-fill" d="M9.5 11 L8 21 L11 18.5 L12.5 11 Z"/><g class="ink"><path d="M8 21 l-0.4 1.5 M10 20 l0 1.5 M11.5 19 l0.4 1.5"/></g></svg>`,
  heartcrack: `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 21 C3.5 14.5 3 9.5 5.8 6.6 C8.2 4.1 11 5.2 12 7.4 C13 5.2 15.8 4.1 18.2 6.6 C21 9.5 20.5 14.5 12 21 Z"/><path d="M12 7.4 L10 12 L13.2 13.6 L11 18.5" fill="none" stroke="var(--paper)" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  flute:   `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M8.5 3 H15.5 L14 11 A2 2 0 0 1 10 11 Z"/><path class="ink" d="M12 12.5 V19.5 M9 19.5 H15"/><circle class="ink-fill" cx="16.5" cy="3.5" r="1"/><circle class="ink-fill" cx="18" cy="6.5" r="0.8"/><circle class="ink-fill" cx="16.8" cy="9" r="0.6"/></svg>`,
  trio:    `<svg viewBox="0 0 24 24"><circle class="ink-fill" cx="8.5" cy="9" r="4.5"/><circle class="ink-fill" cx="15.5" cy="9" r="4.5"/><circle class="ink-fill" cx="12" cy="15.5" r="4.5"/></svg>`,
  calendar:`<svg viewBox="0 0 24 24"><rect class="ink-fill" x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5 H20.5" stroke="var(--paper)" stroke-width="1.4"/><path class="ink" d="M8 3 V6 M16 3 V6"/><g fill="var(--paper)"><circle cx="8.5" cy="13" r="1"/><circle cx="12" cy="13" r="1"/><circle cx="15.5" cy="13" r="1"/><circle cx="8.5" cy="16.5" r="1"/><circle cx="12" cy="16.5" r="1"/></g></svg>`,
  note:    `<svg viewBox="0 0 24 24"><circle class="ink-fill" cx="7" cy="17.5" r="2.8"/><circle class="ink-fill" cx="16" cy="15.5" r="2.8"/><path class="ink" fill="none" d="M9.5 17.5 V6 L18.5 4 V15.5"/><path class="ink" fill="none" d="M9.5 8.5 L18.5 6.5"/></svg>`,
  tree:    `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 2 L16.5 8.5 H14 L17.5 13.5 H6.5 L10 8.5 H7.5 Z"/><rect class="ink-fill" x="10.5" y="13" width="3" height="6.5"/></svg>`,
  balloon: `<svg viewBox="0 0 24 24"><ellipse class="ink-fill" cx="12" cy="9" rx="6.5" ry="7.5"/><path class="ink-fill" d="M10.8 16 L13.2 16 L12 18 Z"/><path class="ink" fill="none" d="M12 18 C12 20 10.5 20 11 21.5"/></svg>`,
  firework:`<svg viewBox="0 0 24 24"><g class="ink"><path d="M12 12 V3"/><path d="M12 12 L18.4 5.6"/><path d="M12 12 H21"/><path d="M12 12 L18.4 18.4"/><path d="M12 12 V21"/><path d="M12 12 L5.6 18.4"/><path d="M12 12 H3"/><path d="M12 12 L5.6 5.6"/></g><circle class="ink-fill" cx="12" cy="12" r="2.2"/></svg>`,
  swords:  `<svg viewBox="0 0 24 24"><g class="ink" stroke-width="2" stroke-linecap="round" fill="none"><path d="M4 4 L15 15"/><path d="M20 4 L9 15"/><path d="M7 17 L4 20"/><path d="M17 17 L20 20"/><path d="M6 14 L10 18"/><path d="M18 14 L14 18"/></g><circle class="ink-fill" cx="4" cy="4" r="1.6"/><circle class="ink-fill" cx="20" cy="4" r="1.6"/></svg>`,
  castle:  `<svg viewBox="0 0 24 24"><rect class="ink-fill" x="5" y="9" width="14" height="11"/><g class="ink-fill"><rect x="5" y="6" width="3" height="3"/><rect x="10.5" y="6" width="3" height="3"/><rect x="16" y="6" width="3" height="3"/></g><path d="M10 20 V15 a2 2 0 0 1 4 0 V20 Z" fill="var(--paper)"/></svg>`,
  sun:     `<svg viewBox="0 0 24 24"><circle class="ink-fill" cx="12" cy="12" r="5"/><g class="ink" stroke-width="1.8" stroke-linecap="round"><path d="M12 1.5 V4"/><path d="M12 20 V22.5"/><path d="M1.5 12 H4"/><path d="M20 12 H22.5"/><path d="M4.2 4.2 L6 6"/><path d="M18 18 L19.8 19.8"/><path d="M19.8 4.2 L18 6"/><path d="M6 18 L4.2 19.8"/></g></svg>`,
  book:    `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 5 C9 3.2 5.5 3.2 3 4.2 V19 C5.5 18 9 18 12 19.8 C15 18 18.5 18 21 19 V4.2 C18.5 3.2 15 3.2 12 5 Z"/><path d="M12 5 V19.8" stroke="var(--paper)" stroke-width="1.2"/><g stroke="var(--paper)" stroke-width="0.9" fill="none"><path d="M5 7.5 H10"/><path d="M5 10 H10"/><path d="M14 7.5 H19"/><path d="M14 10 H19"/></g></svg>`,
  feather: `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M19 3 C10 4 5 10 4.5 17 L8 13.5 C10 16 14 15 16 11 C13 12 11.5 11 11 9.5 C13 11 16 10 17 6.5 C14.5 7.5 13 6.8 12.5 5.5 C15 7 18 5.5 19 3 Z"/><path class="ink" stroke-width="1.4" stroke-linecap="round" d="M4 20 L8 13.5"/></svg>`,
  rocket:  `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 1.5 C15.5 4 17 8 17 12 L15 16 H9 L7 12 C7 8 8.5 4 12 1.5 Z"/><circle cx="12" cy="9" r="2" fill="var(--paper)"/><path class="ink-fill" d="M9 14 L5.5 17 L8 16.5 L8.5 19 Z"/><path class="ink-fill" d="M15 14 L18.5 17 L16 16.5 L15.5 19 Z"/><path class="ink" stroke-width="1.6" stroke-linecap="round" d="M11 18 L11 21 M13 18 L13 20.5"/></svg>`,
  mask:    `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M5 4 H19 V11 C19 17 16 21 12 21 C8 21 5 17 5 11 Z"/><g fill="var(--paper)"><circle cx="9.3" cy="10" r="1"/><circle cx="14.7" cy="10" r="1"/></g><path d="M9 16 q3 -3 6 0" fill="none" stroke="var(--paper)" stroke-width="1.4"/></svg>`,
  branch:  `<svg viewBox="0 0 24 24"><path class="ink" stroke-width="1.8" stroke-linecap="round" fill="none" d="M5 21 C7 14 9 9 16 4"/><path class="ink-fill" d="M9 11 C7 9 7 6 9.5 5 C10.5 7.5 11.5 9 9 11 Z"/><path class="ink-fill" d="M12 8 C10 6 10 3 12.5 2 C13.5 4.5 14.5 6 12 8 Z"/><path class="ink-fill" d="M8 15 C6 14 5 11 7 9.5 C8.5 11.5 9.5 13 8 15 Z"/></svg>`,
  ticket:  `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M3 7 H21 V10 a2 2 0 0 0 0 4 V17 H3 V14 a2 2 0 0 0 0 -4 Z"/><path d="M14 7 V17" stroke="var(--paper)" stroke-width="1.2" stroke-dasharray="1.5 1.5"/><circle cx="8.5" cy="12" r="1.3" fill="var(--paper)"/></svg>`,
  cycle:   `<svg viewBox="0 0 24 24"><g class="ink" stroke-width="2" fill="none"><path d="M19 9 A8 8 0 0 0 5.5 6.5"/><path d="M5 15 A8 8 0 0 0 18.5 17.5"/></g><path class="ink-fill" d="M4 3 L6.5 7 L2 7.2 Z"/><path class="ink-fill" d="M20 21 L17.5 17 L22 16.8 Z"/></svg>`,
  moon:    `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M20 14.5 A9 9 0 1 1 11 3 A7 7 0 0 0 20 14.5 Z"/></svg>`,
  shake:   `<svg viewBox="0 0 24 24"><circle class="ink-fill" cx="12" cy="12" r="4"/><g class="ink" stroke-width="1.8" stroke-linecap="round" fill="none"><path d="M5 7 q-2 5 0 10"/><path d="M3 9 q-1.2 3 0 6"/><path d="M19 7 q2 5 0 10"/><path d="M21 9 q1.2 3 0 6"/></g></svg>`,
  peace:   `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" class="ink" fill="none" stroke-width="2"/><g class="ink" stroke-width="2"><path d="M12 2.5 V21.5"/><path d="M12 12 L5.3 18.7"/><path d="M12 12 L18.7 18.7"/></g></svg>`,
  storm:   `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M7 14 a4 4 0 0 1 0.4 -8 a5 5 0 0 1 9.4 1 a3.5 3.5 0 0 1 -0.8 7 Z"/><path class="ink-fill" d="M11 13 L8 19 H11 L10 23 L15 16 H12 Z"/></svg>`,
  triangle:`<svg viewBox="0 0 24 24"><path class="ink" fill="none" stroke-width="2" stroke-linejoin="round" d="M12 4 L20.5 19 H3.5 Z"/><circle cx="12" cy="4" r="2.2" class="ink-fill"/><circle cx="20.5" cy="19" r="2.2" class="ink-fill"/><circle cx="3.5" cy="19" r="2.2" class="ink-fill"/></svg>`,
  brain:   `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M9 3 a3 3 0 0 0 -3 3 a3 3 0 0 0 -2 4 a3 3 0 0 0 1 4 a3 3 0 0 0 3 3 a2.5 2.5 0 0 0 3 0 V4 a2 2 0 0 0 -2 -1 Z"/><path class="ink-fill" d="M15 3 a3 3 0 0 1 3 3 a3 3 0 0 1 2 4 a3 3 0 0 1 -1 4 a3 3 0 0 1 -3 3 a2.5 2.5 0 0 1 -3 0 V4 a2 2 0 0 1 2 -1 Z"/><path d="M12 4 V20" stroke="var(--paper)" stroke-width="1"/></svg>`,
  thermometer:`<svg viewBox="0 0 24 24"><rect class="ink-fill" x="9.5" y="2" width="5" height="13" rx="2.5"/><circle class="ink-fill" cx="12" cy="18" r="4"/><rect x="11" y="6" width="2" height="9" fill="var(--paper)"/><circle cx="12" cy="18" r="2" fill="var(--paper)"/><g class="ink" stroke-width="1.4" stroke-linecap="round"><path d="M16 5 h3"/><path d="M16 9 h2"/></g></svg>`,
  eyeoff:  `<svg viewBox="0 0 24 24"><path class="ink" fill="none" stroke-width="1.8" d="M2.5 12 C6 6 18 6 21.5 12 C18 18 6 18 2.5 12 Z"/><circle class="ink-fill" cx="12" cy="12" r="3"/><path class="ink" stroke-width="2.2" stroke-linecap="round" d="M4 4 L20 20"/></svg>`,
  scissors:`<svg viewBox="0 0 24 24"><g class="ink" stroke-width="1.8" fill="none"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.5 7.5 L20 18"/><path d="M8.5 16.5 L20 6"/></g><circle class="ink-fill" cx="12" cy="12" r="1.3"/></svg>`,
  mountain:`<svg viewBox="0 0 24 24"><path class="ink-fill" d="M2 20 L9 7 L13 14 L16 9 L22 20 Z"/><path d="M7 11 L9 7 L11 11 Z" fill="var(--paper)"/><path d="M14.5 11.5 L16 9 L17.5 11.5 Z" fill="var(--paper)"/></svg>`,
  clapper: `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M3 8 L20.5 5 L21 8.5 L3.5 11.5 Z"/><g stroke="var(--paper)" stroke-width="1.3"><path d="M6.5 7.4 L7.8 5.3 M10.5 6.7 L11.8 4.7 M14.5 6 L15.8 4 M18.5 5.3 L19.8 3.4"/></g><rect class="ink-fill" x="3.5" y="11" width="17" height="9" rx="1"/></svg>`,
  window:  `<svg viewBox="0 0 24 24"><rect class="ink-fill" x="3.5" y="3.5" width="17" height="17" rx="1.5"/><g stroke="var(--paper)" stroke-width="1.4"><path d="M12 4 V20"/><path d="M4 12 H20"/></g></svg>`,
  snake:   `<svg viewBox="0 0 24 24"><path class="ink" fill="none" stroke-width="2.3" stroke-linecap="round" d="M5 19 C10 19 10 13 6 13 C2 13 2 7 7 7 C13 7 13 12 18 12 C21 12 21 8 18.5 7"/><circle class="ink-fill" cx="18.5" cy="6.5" r="1.6"/><path class="ink" stroke-width="1" stroke-linecap="round" d="M19.6 5.6 L21 4.6 M19.6 7.4 L21 8.4"/></svg>`,
  house:   `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 2.5 L21.5 11 H18 V21 H6 V11 H2.5 Z"/><rect x="9.5" y="14" width="5" height="7" fill="var(--paper)"/></svg>`,
  target:  `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" class="ink" fill="none" stroke-width="2"/><circle cx="12" cy="12" r="5.5" class="ink" fill="none" stroke-width="2"/><circle cx="12" cy="12" r="1.8" class="ink-fill"/></svg>`,
  mirrorball: `<svg viewBox="0 0 24 24"><path class="ink" stroke-width="1.6" d="M12 1.5 V5"/><circle class="ink-fill" cx="12" cy="13" r="8"/><g stroke="var(--paper)" stroke-width="0.9" fill="none"><path d="M4.4 11 H19.6"/><path d="M4.4 15 H19.6"/><path d="M6 7.6 H18"/><path d="M6 18.4 H18"/><path d="M12 5 V21"/><path d="M8 5.7 V20.3"/><path d="M16 5.7 V20.3"/></g></svg>`,
  diamond: `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M7 3 H17 L20 9 H4 Z"/><path class="ink-fill" d="M4 9 H20 L12 21.5 Z"/><g stroke="var(--paper)" stroke-width="0.9" fill="none"><path d="M4 9 H20"/><path d="M9.5 3 L8 9 L12 21.5"/><path d="M14.5 3 L16 9 L12 21.5"/><path d="M12 3 V9"/></g></svg>`,
  nib:     `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 2 L17 13 L12 22 L7 13 Z"/><circle cx="12" cy="10.5" r="1.7" fill="var(--paper)"/><path class="ink" stroke-width="1.2" d="M12 12.5 V21"/></svg>`,
  eyeclosed: `<svg viewBox="0 0 24 24"><path class="ink" fill="none" stroke-width="2" stroke-linecap="round" d="M3 10 C7 15.5 17 15.5 21 10"/><g class="ink" stroke-width="1.6" stroke-linecap="round"><path d="M5 13 L3.8 16"/><path d="M9 14.6 L8.4 17.6"/><path d="M12 15.2 V18.2"/><path d="M15 14.6 L15.6 17.6"/><path d="M19 13 L20.2 16"/></g></svg>`,
  tower:   `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 1.5 L13.4 6 H10.6 Z"/><path class="ink" fill="none" stroke-width="1.6" stroke-linejoin="round" d="M10.7 5.5 L7.5 14 L4 22 H20 L16.5 14 L13.3 5.5"/><g class="ink" stroke-width="1.3"><path d="M6.4 16.8 H17.6"/><path d="M9 9.5 H15"/><path d="M8.4 13 C10.5 11.5 13.5 11.5 15.6 13"/><path d="M5.6 18.6 C9.5 16.6 14.5 16.6 18.4 18.6"/></g><path class="ink" stroke-width="1.3" d="M12 6.5 V22"/></svg>`,
  // a single water droplet — "Clean" (the rain washed it all away)
  drop:    `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 2 C12 2 5 10 5 15 a7 7 0 0 0 14 0 C19 10 12 2 12 2 Z"/><path d="M9.5 15 a2.5 2.5 0 0 0 2.5 2.5" fill="none" stroke="var(--paper)" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  // yin-yang — everything & nothing, all at once (the gold half is the bead fill,
  // the other half solid ink; two eyes complete the taijitu)
  yinyang: `<svg viewBox="0 0 24 24"><circle class="ink-fill" cx="12" cy="12" r="10" stroke-width="1.2"/><path d="M12 2 a10 10 0 0 1 0 20 a5 5 0 0 1 0 -10 a5 5 0 0 0 0 -10 z" fill="var(--ink)"/><circle cx="12" cy="7" r="1.7" fill="var(--ink)"/><circle cx="12" cy="17" r="1.7" fill="var(--bead)"/></svg>`,
  // a vinyl record — Taylor's Version (re-recording)
  vinyl:   `<svg viewBox="0 0 24 24"><circle class="ink-fill" cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="4.4" fill="var(--paper)"/><circle class="ink-fill" cx="12" cy="12" r="1.3"/><g stroke="var(--paper)" stroke-width="0.8" fill="none" opacity="0.6"><circle cx="12" cy="12" r="6.6"/><circle cx="12" cy="12" r="8"/></g></svg>`,
  // a few piano keys — the piano was hissing
  piano:   `<svg viewBox="0 0 24 24"><rect class="ink-fill" x="3" y="5" width="18" height="14" rx="1.5"/><rect x="4.5" y="6.5" width="15" height="11" fill="var(--paper)"/><g class="ink" stroke-width="1"><path d="M7.5 6.5 V17.5 M10.5 6.5 V17.5 M13.5 6.5 V17.5 M16.5 6.5 V17.5"/></g><g class="ink-fill"><rect x="6.4" y="6.5" width="1.6" height="6"/><rect x="9.4" y="6.5" width="1.6" height="6"/><rect x="12.4" y="6.5" width="1.6" height="6"/><rect x="15.4" y="6.5" width="1.6" height="6"/></g></svg>`,
  // an hourglass — is it over now?
  hourglass:`<svg viewBox="0 0 24 24"><g class="ink" stroke-width="2" stroke-linecap="round"><path d="M6 3 H18 M6 21 H18"/></g><path class="ink-fill" d="M7 4 H17 L12 12 Z"/><path class="ink-fill" d="M12 12 L17 20 H7 Z"/></svg>`,
  // a four-leaf clover — the lucky one
  clover:  `<svg viewBox="0 0 24 24"><g class="ink-fill"><circle cx="12" cy="7.6" r="3.1"/><circle cx="12" cy="14.4" r="3.1"/><circle cx="8.6" cy="11" r="3.1"/><circle cx="15.4" cy="11" r="3.1"/></g><path class="ink" stroke-width="1.6" stroke-linecap="round" d="M12.5 12 L14.5 21"/></svg>`,
  // an ajar door — the bolter (someone who runs)
  door:    `<svg viewBox="0 0 24 24"><g class="ink" stroke-width="1.6" stroke-linejoin="round"><path d="M4 21 H20"/></g><path class="ink-fill" d="M7 3 L16 4.6 V20.4 L7 21 Z"/><circle cx="9" cy="12" r="0.9" fill="var(--paper)"/></svg>`,
  // a padlock, shut — no closure
  lock:    `<svg viewBox="0 0 24 24"><path class="ink" fill="none" stroke-width="1.8" d="M8 10 V7.5 a4 4 0 0 1 8 0 V10"/><rect class="ink-fill" x="5" y="10" width="14" height="10" rx="1.6"/><circle cx="12" cy="14" r="1.3" fill="var(--paper)"/><rect x="11.3" y="14.5" width="1.4" height="3.2" rx="0.6" fill="var(--paper)"/></svg>`,
  // a pair of quotation marks — word for word, quoted exactly
  quote:   `<svg viewBox="0 0 24 24"><path class="ink-fill" d="M4 5 H10 V11 C10 14.5 8 16.5 4.5 17.5 L3.5 15 C5.5 14.4 6.6 13.4 7 12 H4 Z"/><path class="ink-fill" d="M14 5 H20 V11 C20 14.5 18 16.5 14.5 17.5 L13.5 15 C15.5 14.4 16.6 13.4 17 12 H14 Z"/></svg>`,
  // an umbrella — it's raining and it's Monday
  umbrella:`<svg viewBox="0 0 24 24"><path class="ink-fill" d="M12 2.2 C6 2.2 2 7 2 12 L22 12 C22 7 18 2.2 12 2.2 Z"/><g stroke="var(--paper)" stroke-width="1" fill="none"><path d="M7 12 C7 8 8.5 4 12 2.6"/><path d="M17 12 C17 8 15.5 4 12 2.6"/><path d="M12 2.6 V12"/></g><path class="ink" stroke-width="1.6" stroke-linecap="round" fill="none" d="M12 12 V19 a2.6 2.6 0 0 1 -5.2 0"/></svg>`,
  // a ticked checklist page — every song in the catalogue, named (I Hate It Here)
  checklist:`<svg viewBox="0 0 24 24"><rect class="ink-fill" x="4" y="2.5" width="16" height="19" rx="2"/><g stroke="var(--paper)" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 7.6 l1.3 1.3 L10.4 6.4"/><path d="M6.6 13.4 l1.3 1.3 L10.4 12.2"/><path d="M12.8 8 H17"/><path d="M12.8 13.8 H17"/></g></svg>`,
  // a six-armed snowflake — weird but beautiful (Snow On The Beach)
  snowflake:`<svg viewBox="0 0 24 24"><g class="ink" stroke-width="1.5" stroke-linecap="round" fill="none"><path d="M12 2.5 V21.5"/><path d="M3.8 7.25 L20.2 16.75"/><path d="M20.2 7.25 L3.8 16.75"/><path d="M12 6 L9.7 4.4 M12 6 L14.3 4.4 M12 18 L9.7 19.6 M12 18 L14.3 19.6"/><path d="M6.6 7.7 L6.5 5 M6.6 7.7 L3.9 7.9 M17.4 16.3 L17.5 19 M17.4 16.3 L20.1 16.1"/><path d="M17.4 7.7 L17.5 5 M17.4 7.7 L20.1 7.9 M6.6 16.3 L6.5 19 M6.6 16.3 L3.9 16.1"/></g></svg>`,
};
export const ACHIEVEMENTS = [
  { id: "enchanted",        name: "Enchanted",        desc: "Finish your first game",              secret: false, icon: "sparkle" },
  { id: "mastermind",       name: "Mastermind",       desc: "Score a perfect 13/13",               secret: false, icon: "star" },
  { id: "fearless",         name: "Fearless",         desc: "Finish with no timeouts",             secret: false, icon: "shield" },
  { id: "speak-now",        name: "Speak Now",        desc: "Answer correctly in under 2s",        secret: false, icon: "bolt" },
  { id: "begin-again",      name: "Begin Again",      desc: "Play 5 games",                        secret: false, icon: "refresh" },
  { id: "getaway-car",      name: "Getaway Car",      desc: "Answer correctly with under 1s left", secret: true,  icon: "key" },
  { id: "bejeweled",        name: "Bejeweled",        desc: "Hit a 5-in-a-row streak",             secret: true,  icon: "gem" },
  { id: "long-story-short", name: "Long Story Short", desc: "Come back to finish on a 5+ streak",  secret: true,  icon: "rise" },
  { id: "today-was-a-fairytale", name: "Today Was A Fairytale", desc: "Finish your first Daily Challenge", secret: false, icon: "crown" },
  { id: "all-too-well",     name: "All Too Well",     desc: "Finish a full Lyricist game",          secret: false, icon: "scarf" },
  { id: "champagne-problems", name: "Champagne Problems", desc: "Finish one shy — 12/13",            secret: true,  icon: "flute" },
  { id: "anti-hero",        name: "Anti-Hero",        desc: "Score 0/13",                          secret: true,  icon: "heartcrack" },
  { id: "hits-different",   name: "Hits Different",   desc: "Play all three game types",           secret: false, icon: "trio" },
  { id: "fifteen",          name: "Fifteen",          desc: "Play 15 games",                       secret: false, icon: "calendar" },
  { id: "you-knew-the-line", name: "You Knew The Line", desc: "Recall 5 lyric lines in one game",  secret: true,  icon: "note" },
  { id: "out-of-the-woods", name: "Out Of The Woods", desc: "Survive 20+ rounds in Infinite",      secret: false, icon: "tree" },
  { id: "twenty-two",       name: "22",               desc: "Reach exactly round 22 in Infinite",  secret: false, icon: "balloon" },
  { id: "sparks-fly",       name: "Sparks Fly",       desc: "Hit a 10-in-a-row streak",            secret: true,  icon: "firework" },
  { id: "great-war",        name: "The Great War",    desc: "Win an Ultra game — 10+ correct",     secret: false, icon: "swords" },
  { id: "long-live",        name: "Long Live",        desc: "Perfect 13/13 on Hard or Ultra",      secret: true,  icon: "castle" },
  { id: "ready-for-it",     name: "…Ready For It?",   desc: "Nail round 1 in under 2s",            secret: false, icon: "rocket" },
  { id: "i-did-something-bad", name: "I Did Something Bad", desc: "Answer right with under 0.5s left", secret: true, icon: "mask" },
  { id: "branch-out",       name: "Time To Branch Out?", desc: "3 correct in a row from one album", secret: true, icon: "branch" },
  { id: "eras-tour",        name: "The Eras Tour",    desc: "Score from nearly every studio album in one game", secret: true, icon: "ticket" },
  { id: "daylight",         name: "Daylight",         desc: "Score a perfect Daily",               secret: true,  icon: "sun" },
  { id: "story-of-us",      name: "The Story Of Us",  desc: "Keep a 7-day Daily streak",           secret: false, icon: "book" },
  { id: "evermore",         name: "Evermore",         desc: "Reach a 30-day Daily streak",         secret: true,  icon: "feather" },
  { id: "karma",            name: "Karma",            desc: "Earn 13 achievements",                secret: false, icon: "cycle" },
  { id: "midnights",        name: "Midnights",        desc: "Play between 12 and 1am",             secret: true,  icon: "moon" },
  { id: "shake-it-off",     name: "Shake It Off",     desc: "Bounce back from a miss 3× in one game", secret: false, icon: "shake" },
  { id: "peace",            name: "Peace",            desc: "Finish a game without the timer hitting the red",  secret: true, icon: "peace" },
  { id: "perfect-storm",    name: "Perfect Storm",    desc: "Average under 3s per answer in a game", secret: true, icon: "storm" },
  { id: "the-triangle",     name: "The Triangle",     desc: "Answer cardigan, betty and august in one game", secret: true, icon: "triangle" },
  { id: "my-mind-is-alive", name: "My Mind Is Alive", desc: "3 correct in a row — titles starting with B", secret: true, icon: "brain" },
  { id: "cruel-summer",     name: "Cruel Summer",     desc: "Lose all 3 lives in the first 4 rounds", secret: true, icon: "thermometer" },
  { id: "i-cant-see-you",   name: "I Can't See You",  desc: "Finish a game without answering once", secret: true, icon: "eyeoff" },
  { id: "thousand-cuts",    name: "Death By A Thousand Cuts", desc: "1,000 lifetime missed rounds", secret: true, icon: "scissors" },
  { id: "holy-ground",      name: "Holy Ground",      desc: "Reach round 13 from scratch in Infinite", secret: true, icon: "mountain" },
  { id: "spicy-drama",      name: "Spicy Drama",      desc: "Answer with \"If This Was A Movie\" — Fearless or Speak Now? Fans still argue", secret: true, icon: "clapper" },
  { id: "word-for-word",    name: "Word For Word",    desc: "Recall a lyric line word-perfect",     secret: true,  icon: "quote" },
  { id: "i-look-in-windows", name: "I Look In People's Windows", desc: "Open the settings menu",      secret: true,  icon: "window" },
  { id: "look-what-you-made-me-do", name: "Look What You Made Me Do", desc: "Make the snake appear",  secret: true,  icon: "snake" },
  { id: "snow-on-the-beach",   name: "Snow On The Beach",   desc: "Watch the snow fall on the page",        secret: true,  icon: "snowflake" },
  { id: "safe-and-sound",   name: "Safe & Sound",     desc: "Play Easy three times in a row",       secret: false, icon: "house" },
  { id: "revenge",          name: "R-E-V-E-N-G-E",    desc: "Beat your own best score on any board", secret: false, icon: "target" },
  { id: "mirrorball",       name: "Mirrorball",       desc: "Score a perfect 13/13 in every difficulty", secret: true, icon: "mirrorball" },
  { id: "diamonds",         name: "Diamonds Are Forever", desc: "3 rare words right in a row (no Ultra)", secret: true, icon: "diamond" },
  { id: "wordsmith",        name: "Wordsmith",        desc: "Win a round on a fuzzy lyric match",    secret: true,  icon: "nib" },
  { id: "got-you-down",     name: "I've Got You Down", desc: "Recall 10 lyric lines word-perfect",   secret: false, icon: "nib" },
  { id: "by-heart",         name: "I Know You By Heart", desc: "Recall 50 lyric lines word-perfect", secret: false, icon: "nib" },
  { id: "where-i-start",    name: "You Don't Even Know Where I Start", desc: "Recall 100 lyric lines word-perfect", secret: false, icon: "quote" },
  { id: "clearly-ready",    name: "…Clearly You Were Ready For It?", desc: "Recall 1,000 lyric lines word-perfect", secret: true, icon: "quote" },
  { id: "overachiever",     name: "Overachiever",     desc: "Recall a whole verse — four lines word-perfect", secret: true, icon: "nib" },
  { id: "fav-song",         name: "Someone Has A Favourite Song", desc: "Answer three rounds with lyrics from the same song", secret: true, icon: "star" },
  { id: "eyes-closed",      name: "Eyes Closed",      desc: "10 fuzzy lyric matches in one Lyricist game", secret: true, icon: "eyeclosed" },
  { id: "paris",            name: "Paris",            desc: "Answer “Paris” when the word is “somewhere”", secret: true, icon: "tower" },
  { id: "i-hate-it-here",   name: "I Hate It Here",   desc: "Answer every song in the catalogue at least once", secret: false, icon: "checklist" },
  { id: "raining-monday",   name: "It's Raining And It's Monday", desc: "Answer “rain” correctly on a Monday", secret: true, icon: "umbrella" },
  { id: "clean",            name: "Clean",            desc: "Win without hints or a single timeout",  secret: false, icon: "drop" },
  { id: "everything-nothing", name: "Everything & Nothing All At Once", desc: "Win a game in every difficulty", secret: false, icon: "yinyang" },
  { id: "fearless-tv",      name: "Fearless (Taylor's Version)", desc: "Two games in a row with no timeouts", secret: false, icon: "vinyl" },
  { id: "piano-was-hissing", name: "The Piano Was Hissing", desc: "Type “reputation tv” somewhere",    secret: true,  icon: "piano" },
  { id: "the-bolter",       name: "The Bolter",       desc: "Quit before typing anything in round 1", secret: true,  icon: "door" },
  { id: "no-closure",       name: "No Closure",       desc: "Give up after 12 — never answer the 13th", secret: true, icon: "lock" },
  { id: "the-archer",       name: "The Archer",       desc: "Defeat your first challenge",           secret: false, icon: "target" },
  { id: "the-alchemy",      name: "The Alchemy",      desc: "Defeat every challenge",                secret: false, icon: "crown" },
  { id: "paper-rings",      name: "Paper Rings",      desc: "Unlock every challenge",                secret: false, icon: "diamond" },
  { id: "state-of-grace",   name: "State Of Grace",   desc: "Defeat a challenge on the first try",   secret: true,  icon: "feather" },
  { id: "this-is-me-trying", name: "This Is Me Trying", desc: "Defeat a challenge after 5+ attempts", secret: true, icon: "mountain" },
  { id: "the-lakes",        name: "The Lakes",        desc: "Climb to the Rarest tier in Adaptive",  secret: false, icon: "mountain" },
  { id: "stay-stay-stay",   name: "Stay Stay Stay",   desc: "Reach Rarest and finish there without slipping", secret: true, icon: "crown" },
  { id: "a-place-in-this-world", name: "A Place In This World", desc: "Beat your first album in Album Focus", secret: false, icon: "house" },
  { id: "change",           name: "Change",           desc: "Beat all 12 albums in Album Focus",     secret: false, icon: "crown" },
  { id: "gold-rush",        name: "Gold Rush",        desc: "Perfect an album in Album Focus — 13/13", secret: true,  icon: "star" },
  { id: "starlight",        name: "Starlight",        desc: "Perfect all 12 albums in Album Focus",  secret: true,  icon: "firework" },
  { id: "castles-crumbling", name: "Castles Crumbling", desc: "Trade an achievement for a token",    secret: true,  icon: "castle" },
  { id: "is-it-over-now",   name: "Is It Over Now?",  desc: "Earn every hidden achievement",         secret: true,  icon: "hourglass" },
  { id: "the-lucky-one",    name: "The Lucky One",    desc: "Earn every other achievement",          secret: true,  icon: "clover" },
];
export const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

// Achievements are shown grouped by theme on the Charm Collection page. Order here is
// the section order. The final "Secret charms" section is render-only (not a group).
export const ACH_GROUPS = [
  { id: "core",      label: "Core",                   short: "Core" },
  { id: "daily",     label: "Daily challenge",        short: "Daily" },
  { id: "infinite",  label: "Infinite mode",          short: "Infinite" },
  { id: "lyricist",  label: "Lyricist & lyric lines", short: "Lyricist" },
  { id: "catalogue", label: "Catalogue knowledge",    short: "Catalogue" },
  { id: "challenges", label: "Challenges",             short: "Challenge" },
  { id: "albumFocus", label: "Album Focus",            short: "Album" },
  { id: "adaptive",  label: "Adaptive mode",          short: "Adaptive" },
];
// One muted notebook hue per theme — the section dots and the by-theme breakdown bars.
export const ACH_GROUP_COLORS = {
  core:      "#c8951f",
  daily:     "#3f7d6e",
  infinite:  "#2f4d7a",
  lyricist:  "#9b6b9e",
  catalogue: "#b23a3a",
  challenges: "#2b2722",
  albumFocus: "#a8577a",
  adaptive:  "#7d5a3f",
};
// Membership: only the non-core ids are listed; everything else defaults to "core"
// (groupOf in app.js). Keeps this in sync without re-listing every achievement.
export const ACH_GROUP_OF = {
  "today-was-a-fairytale": "daily", "daylight": "daily", "story-of-us": "daily", "evermore": "daily",
  "out-of-the-woods": "infinite", "twenty-two": "infinite", "long-story-short": "infinite",
  "cruel-summer": "infinite", "holy-ground": "infinite",
  "all-too-well": "lyricist", "you-knew-the-line": "lyricist", "word-for-word": "lyricist",
  "wordsmith": "lyricist", "eyes-closed": "lyricist",
  "got-you-down": "lyricist", "by-heart": "lyricist", "where-i-start": "lyricist",
  "clearly-ready": "lyricist", "overachiever": "lyricist", "fav-song": "lyricist",
  "branch-out": "catalogue", "eras-tour": "catalogue", "the-triangle": "catalogue",
  "my-mind-is-alive": "catalogue", "thousand-cuts": "catalogue", "spicy-drama": "catalogue",
  "diamonds": "catalogue", "paris": "catalogue", "i-hate-it-here": "catalogue",
  "the-archer": "challenges", "the-alchemy": "challenges", "paper-rings": "challenges",
  "state-of-grace": "challenges", "this-is-me-trying": "challenges", "castles-crumbling": "challenges",
  "a-place-in-this-world": "albumFocus", "change": "albumFocus", "gold-rush": "albumFocus", "starlight": "albumFocus",
  "the-lakes": "adaptive", "stay-stay-stay": "adaptive",
};

// Charm → token conversion eligibility. Only *skill/mastery* charms can be sacrificed
// for a challenge token; freebies can't. Secret charms (easter eggs / trivia) and the
// whole `challenges` group (no recursion — challenge progress shouldn't fund more
// challenge unlocks) are excluded by isTradeableAch() in app.js. This set adds the
// remaining *visible* freebies: pure participation / play-count / meta charms.
export const ACH_NO_TRADE = new Set([
  "enchanted",              // finish your first game
  "begin-again",            // play 5 games
  "fifteen",                // play 15 games
  "karma",                  // earn 13 charms (meta)
  "today-was-a-fairytale",  // finish your first Daily
  "hits-different",         // play all three game types
  "safe-and-sound",         // play Easy three times in a row
]);

/* ---------- Easter-egg art ---------- */
export const PEN_SVG = {
  // A feather quill: a barbed plume, a bare curved rachis, and a sharpened cut nib.
  quill: `<svg viewBox="0 0 24 24"><g transform="rotate(-45 12 12)"><path class="vane" d="M8.4 12 Q14 4.6 21 6.9 Q15.2 9.9 9.6 12.7 Z"/><g class="barb"><path d="M10.6 11.2 L12.1 8.4"/><path d="M12.8 10.6 L14.4 7.6"/><path d="M15 9.9 L16.6 7.2"/><path d="M17.4 9.2 L18.9 7"/></g><path class="spine" d="M2.7 12.7 Q9 12.2 21 6.9"/><path class="tip" d="M2.1 13 L4.5 12.05 L4.7 13.25 Z"/><path class="slit" d="M2.9 12.85 L4 12.45"/></g></svg>`,
  // A fountain pen: barrel, gold trim band, leaf-shaped nib with slit + breather hole, pocket clip.
  fountain: `<svg viewBox="0 0 24 24"><g transform="rotate(-45 12 12)"><path class="barrel" d="M8 10.2 H20 Q21.6 10.2 21.6 12 Q21.6 13.8 20 13.8 H8 Z"/><path class="barrel" d="M8 10.5 L6.4 11.1 L6.4 12.9 L8 13.5 Z"/><path class="nib" d="M2.3 12 Q4.2 10.7 6.3 10.7 L6.3 13.3 Q4.2 13.3 2.3 12 Z"/><path class="slit" d="M2.9 12 H5.5"/><circle class="hole" cx="5.5" cy="12" r="0.55"/><rect class="band" x="7.5" y="10.2" width="1.1" height="3.6" rx="0.3"/><path class="barrel" d="M16.4 10.3 Q18.4 9.2 19.2 10 Q19.6 10.6 18.6 11.1 L17.4 11.1 Z"/></g></svg>`,
  // A sleek gel pen: barrel, conical metal tip, gold grip + end cap, with glints of glitter.
  glitter: `<svg viewBox="0 0 24 24"><g transform="rotate(-45 12 12)"><path class="barrel" d="M8 10 H20 Q22 10 22 12 Q22 14 20 14 H8 Z"/><rect class="grip" x="6" y="10.2" width="2.4" height="3.6" rx="0.4"/><path class="tip" d="M6 10.4 L3 11.6 Q2.3 12 3 12.4 L6 13.6 Z"/><circle class="glitter-spark" cx="2.7" cy="12" r="0.6"/><rect class="band" x="19" y="10" width="1.6" height="4" rx="0.6"/></g><g class="glitter-spark"><path d="M5 6 l0.5 1.4 1.4 0.5 -1.4 0.5 -0.5 1.4 -0.5 -1.4 -1.4 -0.5 1.4 -0.5 z"/><path d="M18 17 l0.4 1.1 1.1 0.4 -1.1 0.4 -0.4 1.1 -0.4 -1.1 -1.1 -0.4 1.1 -0.4 z"/><circle cx="11" cy="5.5" r="0.7"/><circle cx="16" cy="19" r="0.6"/></g></svg>`,
};

export const STAR_SVG = `<svg viewBox="0 0 24 24"><path d="M12 2 L14.6 9 L22 9.3 L16 14 L18 21.5 L12 17 L6 21.5 L8 14 L2 9.3 L9.4 9 Z" fill="currentColor"/></svg>`;
export const SPARKLE_SVG = `<svg viewBox="0 0 24 24"><path d="M12 1 C13 8 16 11 23 12 C16 13 13 16 12 23 C11 16 8 13 1 12 C8 11 11 8 12 1 Z" fill="currentColor"/></svg>`;

export const DOODLE_SVG = {
  // a fence panel with 5 diamond cut-outs in a quincunx (Taylor's fence photo)
  fence: `<svg viewBox="0 0 76 64"><g class="ink"><rect x="3" y="6" width="70" height="52" rx="2"/><line x1="20" y1="6" x2="20" y2="58"/><line x1="38" y1="6" x2="38" y2="58"/><line x1="56" y1="6" x2="56" y2="58"/><path d="M14 18 l5 5 -5 5 -5 -5 z"/><path d="M62 18 l5 5 -5 5 -5 -5 z"/><path d="M14 42 l5 5 -5 5 -5 -5 z"/><path d="M62 42 l5 5 -5 5 -5 -5 z"/><path d="M38 30 l5 5 -5 5 -5 -5 z"/></g></svg>`,
  // a quiet inked coil — the reduced-motion stand-in for the slithering snake
  snake: `<svg viewBox="0 0 84 58"><g class="ink"><path d="M8 42 C20 42 20 28 32 28 C44 28 44 42 56 42 C66 42 70 32 67 24"/><path d="M67 24 C65 17 71 12 76 15"/></g><path class="ink-fill" d="M73 11 a3.2 3.2 0 1 1 0.1 0 z"/><circle cx="74.4" cy="13.6" r="0.7" fill="var(--paper)"/><g class="ink"><path d="M77 13 l5 -2 m-5 3.4 l5 1"/></g><g class="ink" stroke-width="1.3" opacity="0.6"><path d="M17 40 l2 -3 m7 0 l2 -3 m9 4 l2 3 m7 -1 l2 3"/></g></svg>`,
  scarf: `<svg viewBox="0 0 60 58"><g class="ink"><path d="M13 9 C26 18 34 18 47 9"/><path d="M15 14 C26 21 34 21 45 14"/><path d="M27 18 C24 26 24 31 28 35 L24 51"/><path d="M33 18 C36 26 36 31 32 35 L36 49"/><path d="M27.5 35 L32.5 35"/></g><g class="ink" stroke-width="0.9" opacity="0.65"><path d="M26 24 l8 0.4 M25.4 28 l9 0.4 M26.5 31 l7 0.4"/></g><g class="ink" stroke-width="1.4"><path d="M22 51 l-0.8 5 m3.2 -6 l0.4 6 m3.4 -6 l1 5"/><path d="M34 49 l-0.8 5 m3.4 -6 l0.4 6 m3.4 -6 l1 5"/></g></svg>`,
  cat: `<svg viewBox="0 0 60 56"><g class="ink"><path d="M16 13 L20 25 M16 13 L13 24"/><path d="M44 13 L40 25 M44 13 L47 24"/><path d="M13 27 C9 33 9 44 14 49 C21 53 39 53 46 49 C51 44 51 33 47 27 C40 20 20 20 13 27 Z"/><path d="M46 47 C55 47 59 38 55 31"/></g><g class="ink" stroke-width="1.5"><circle cx="24" cy="35" r="1.3" class="ink-fill"/><circle cx="36" cy="35" r="1.3" class="ink-fill"/><path d="M30 38 l0 2.4 M30 40.4 l-3 2 M30 40.4 l3 2"/></g><g class="ink" stroke-width="0.9" opacity="0.7"><path d="M22 39 l-9 -1.5 m9 4 l-9 1.5 M38 39 l9 -1.5 m-9 4 l9 1.5"/></g></svg>`,
  guitar: `<svg viewBox="0 0 44 60"><g class="ink"><path d="M22 23 C15 23 12 31 16 36 C10 41 11 53 22 55 C33 53 34 41 28 36 C32 31 29 23 22 23 Z"/><circle cx="22" cy="41" r="4.4"/><rect x="19.4" y="5" width="5.2" height="18" rx="1.4"/><path d="M20 5 q-2.4 -2 -0.2 -3.4 M24 5 q2.4 -2 0.2 -3.4"/><path d="M22 23 L22 36"/><path d="M16.5 48 L27.5 48"/></g><g class="ink" stroke-width="0.8" opacity="0.7"><path d="M20.4 23 L20.4 34 M22 23 L22 34 M23.6 23 L23.6 34"/></g><g class="ink" stroke-width="1.2"><circle cx="20" cy="3" r="0.6" class="ink-fill"/><circle cx="24" cy="3" r="0.6" class="ink-fill"/></g></svg>`,
  thirteen: `<svg viewBox="0 0 40 40"><text x="6" y="29" font-family="Caveat, cursive" font-size="29" fill="var(--ink-soft)">13</text><ellipse cx="19" cy="20" rx="17" ry="14.5" fill="none" stroke="var(--ink-soft)" stroke-width="1.5" transform="rotate(-8 19 20)"/></svg>`,
};

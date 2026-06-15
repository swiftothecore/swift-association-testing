// Pure constants & data tables. No state, no DOM — safe to import anywhere.

export const TOTAL_ROUNDS = 13;
export const ROUND_SECONDS = 10;
export const RECENT_WINDOW = 5;

/* ---------- localStorage keys ---------- */
export const HS_KEY = "swiftSongAssociation.highscores";
export const STATS_KEY = "swiftSongAssociation.stats";
export const ACH_KEY = "swiftSongAssociation.achievements";
export const DIFF_KEY = "swiftSongAssociation.difficulty";
export const DAILY_KEY = "swiftSongAssociation.daily";
export const DAILY_BOARD_KEY = "swiftSongAssociation.dailyBoard";

/* Difficulty modes — each just re-tunes existing levers (timer, dropdown,
   word-rarity pool, matching strictness, wrong-answer help). Gameplay code is
   shared; the mode object sets the parameters. */
export const MODES = {
  easy:   { id: "easy",   label: "Easy",   seconds: 15, dropdown: true,  pool: "easy",  strict: false, noTitle: false, examples: 3, blurb: "15s · hints on · common words" },
  medium: { id: "medium", label: "Normal", seconds: 10, dropdown: true,  pool: "all",   strict: false, noTitle: false, examples: 3, blurb: "10s · hints on · all words" },
  hard:   { id: "hard",   label: "Hard",   seconds: 7,  dropdown: false, pool: "hard",  strict: false, noTitle: true,  examples: 3, blurb: "7s · no hints · rarer words · not in the title" },
  ultra:  { id: "ultra",  label: "Ultra",  seconds: 5,  dropdown: false, pool: "ultra", strict: true,  noTitle: true,  examples: 0, blurb: "5s · no hints · rarest · exact · not in the title" },
  // Lyric-only: no title input (lyricOnly), longer clock. You answer by typing a lyric
  // line (a few words around the prompt word are enough — the matcher is fuzzy).
  lyricist: { id: "lyricist", label: "Lyricist", seconds: 20, dropdown: false, pool: "all", strict: false, noTitle: false, examples: 3, lyricOnly: true, blurb: "20s · type a lyric line, not the title" },
};
export const MODE_ORDER = ["easy", "medium", "hard", "ultra", "lyricist"];

export const DEFAULT_PODIUM = [
  { name: "Sabrina Carpenter", score: 13 },
  { name: "Taylor Swift", score: 12 },
  { name: "Olivia Rodrigo", score: 10 },
  { name: "SwiftLover13", score: 8 },
  { name: "Selena Gomez", score: 4 },
];
// Infinite boards seed with rounds-survived numbers, not the 13-capped classic ones.
export const INFINITE_DEFAULT_PODIUM = [
  { name: "Taylor Swift", score: 22 },
  { name: "SwiftLover13", score: 16 },
  { name: "Sabrina Carpenter", score: 11 },
];
// Daily board resets every day — seed with fewer entries so it fills organically.
export const DAILY_DEFAULT_PODIUM = [
  { name: "Taylor Swift", score: 13 },
  { name: "SwiftLover13", score: 11 },
  { name: "Sabrina Carpenter", score: 9 },
];

/* Era engine */
export const ERAS = ["gold", "lavender", "red", "denim", "graphite", "midnight"];
export const TENDER_ERAS = ["lavender", "denim"];   // round 5 (Track 5) leans tender
export const FINALE_ERAS = ["gold", "midnight"];    // round 13 leans grand

/* ---------- Album colours (left-rule tint + tag on lyric cards) ---------- */
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
];
export const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

/* ---------- Easter-egg art ---------- */
export const PEN_SVG = {
  quill: `<svg viewBox="0 0 24 24"><g class="ink"><path d="M4.5 19.5 C9 12.5 14 6.5 21 2.5 C19.2 10.8 15 16.8 8 19.8 Z"/><path d="M18.5 5 L7.5 16.5"/><path d="M15.5 6.5 l-3.6 -1 M13.5 8.5 l-3.6 -1 M11.5 10.5 l-3.6 -1 M9.5 12.5 l-3.6 -1"/></g></svg>`,
  fountain: `<svg viewBox="0 0 24 24"><g class="ink"><path d="M19.5 2.8 L8.5 13.8"/><path d="M8.5 13.8 L6 16.3"/></g><path class="ink-fill" d="M6 16.3 L3.2 21 L8 18.6 Z"/><path class="ink" stroke-width="1" d="M5 18.6 L6.8 16.8"/></svg>`,
  glitter: `<svg viewBox="0 0 24 24"><g class="ink"><path d="M18.5 3.5 L8 14"/><path d="M8 14 L5 17"/></g><path class="ink-fill" d="M5 17 L2.6 21.4 L7 19 Z"/><g class="glitter-spark"><path d="M18.5 11 l1 2.2 2.2 1 -2.2 1 -1 2.2 -1 -2.2 -2.2 -1 2.2 -1 z"/><circle cx="21.2" cy="6.8" r="1"/><circle cx="13" cy="18.4" r="0.9"/></g></svg>`,
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

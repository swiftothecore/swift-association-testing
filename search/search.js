"use strict";
// Swift To The Lyric — the lyrics searcher. Reuses the game's matching core
// (../js/match.js), helpers (../js/util.js), and album data (../js/config.js) so a
// search returns exactly the lines the game would count as a match. Loads songs.json
// itself and works off the structured `sections` (label + lines) so every hit knows
// its section and per-section line number without re-parsing strings.
import { escapeHtml, fuzzySubstringRatio } from "../js/util.js";
import { wordRegex, highlightWord } from "../js/match.js";
import { ALBUM_COLORS } from "../js/config.js";

const $ = (id) => document.getElementById(id);
const FUZZY_MIN = 0.78;   // token similarity needed for a fuzzy hit (0..1)

let SONGS = [];                  // flat: { title, album, sections:[{label, lines}] }
const ALBUM_INDEX = new Map();   // album name -> release order (from songs.json order)

// Section TYPES present in the data (for the structural filter), in a sensible order.
const SECTION_ORDER = ["(intro)", "Intro", "Verse", "Pre-Chorus", "Chorus", "Post-Chorus",
  "Refrain", "Hook", "Bridge", "Outro", "Interlude", "Spoken", "Breakdown", "Coda"];
let SECTION_TYPES = [];

const state = { q: "", mode: "stem", grouped: true, section: "any", pos: "any" };

/* ---------- data ---------- */
async function loadData() {
  const res = await fetch("../songs.json");
  if (!res.ok) throw new Error("Failed to load songs.json");
  const grouped = await res.json();
  grouped.forEach((g, i) => ALBUM_INDEX.set(g.album, i));
  SONGS = grouped.flatMap(({ album, songs }) =>
    songs.map((s) => ({ title: s.title, album, sections: Array.isArray(s.sections) ? s.sections : [] }))
  );
  const set = new Set();
  for (const s of SONGS) for (const sec of s.sections) set.add(sectionType(sec.label));
  SECTION_TYPES = SECTION_ORDER.filter((t) => set.has(t))
    .concat([...set].filter((t) => !SECTION_ORDER.includes(t)).sort());
}

/* ---------- search ---------- */
function sectionName(label) { return label && label.trim() ? label : "(intro)"; }
// The bare section TYPE (drop the trailing number): "Verse 1" -> "Verse", "" -> "(intro)".
function sectionType(label) {
  const t = (label || "").replace(/\s*\d+\s*$/, "").trim();
  return t || "(intro)";
}

// Per-section display labels, disambiguating repeats ("Chorus (2)") so a hit's
// location is unambiguous when a section type recurs in a song.
function sectionDisplays(song) {
  const totals = {};
  for (const sec of song.sections) { const n = sectionName(sec.label); totals[n] = (totals[n] || 0) + 1; }
  const seen = {};
  return song.sections.map((sec) => {
    const n = sectionName(sec.label);
    seen[n] = (seen[n] || 0) + 1;
    return totals[n] > 1 ? `${n} (${seen[n]})` : n;
  });
}

function makeHit(sec, si, li, label, html) {
  const lines = sec.lines || [];
  return {
    sectionLabel: label,
    sectionIndex: si,
    lineNo: li + 1,                                  // per-section, 1-based
    html,
    prev: li > 0 ? lines[li - 1] : null,
    next: li < lines.length - 1 ? lines[li + 1] : null,
  };
}

// Wrap the match at a known position (used by fuzzy, which already located its token).
function markAt(line, idx, len) {
  if (idx < 0) return escapeHtml(line);
  return escapeHtml(line.slice(0, idx)) + "<mark>" + escapeHtml(line.slice(idx, idx + len)) +
    "</mark>" + escapeHtml(line.slice(idx + len));
}

// Structural filters: restrict by section type and by the match's position in the line
// ("starts the line" = only non-letters before it; "ends the line" = only non-letters,
// e.g. punctuation/quotes, after it — a rhyme-position search).
function passesFilters(secLabel, line, idx, len) {
  if (state.section !== "any" && sectionType(secLabel) !== state.section) return false;
  if (state.pos === "start" && !/^[^A-Za-z]*$/.test(line.slice(0, idx))) return false;
  if (state.pos === "end" && !/^[^A-Za-z]*$/.test(line.slice(idx + len))) return false;
  return true;
}

function searchSong(song, q, mode) {
  const hits = [];
  const disp = sectionDisplays(song);
  if (mode === "fuzzy") {
    const ql = q.toLowerCase();
    song.sections.forEach((sec, si) => {
      (sec.lines || []).forEach((line, li) => {
        let best = 0, bestIdx = -1, bestLen = 0;
        for (const m of line.matchAll(/[A-Za-z']+/g)) {
          const tok = m[0];
          if (tok.length < 2 || Math.abs(tok.length - ql.length) > 2) continue;   // cheap length prefilter
          const r = fuzzySubstringRatio(ql, tok.toLowerCase());
          if (r > best) { best = r; bestIdx = m.index; bestLen = tok.length; }
        }
        if (best >= FUZZY_MIN && passesFilters(sec.label, line, bestIdx, bestLen))
          hits.push(makeHit(sec, si, li, disp[si], markAt(line, bestIdx, bestLen)));
      });
    });
  } else {
    const strict = mode === "exact";
    const rx = wordRegex(q, strict);   // non-global: exec always returns the first match
    song.sections.forEach((sec, si) => {
      (sec.lines || []).forEach((line, li) => {
        const m = rx.exec(line);
        if (m && passesFilters(sec.label, line, m.index, m[0].length))
          hits.push(makeHit(sec, si, li, disp[si], highlightWord(line, q, strict)));
      });
    });
  }
  return hits;
}

function runSearch() {
  const q = state.q.trim();
  writeHash();
  if (q.length < 2) { renderInitial(q); return; }
  const groups = [];
  for (const song of SONGS) {
    const hits = searchSong(song, q, state.mode);
    if (hits.length) groups.push({ song, hits });
  }
  groups.sort((a, b) =>
    (ALBUM_INDEX.get(a.song.album) - ALBUM_INDEX.get(b.song.album)) || a.song.title.localeCompare(b.song.title));
  render(q, groups);
}

/* ---------- render ---------- */
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function renderInitial(q) {
  $("counter").innerHTML = "";
  $("bar").innerHTML = "";
  const msg = q.length === 1
    ? "Keep going — type at least two letters."
    : `Type a word to search every lyric line across ${SONGS.length} songs.`;
  $("results").innerHTML = `<p class="sx-hint">${escapeHtml(msg)}</p>`;
}

function albumBar(groups) {
  const counts = new Map();
  for (const g of groups) counts.set(g.song.album, (counts.get(g.song.album) || 0) + g.hits.length);
  const albums = [...counts.keys()].sort((a, b) => ALBUM_INDEX.get(a) - ALBUM_INDEX.get(b));
  return albums.map((al) =>
    `<span style="flex:${counts.get(al)};background:${ALBUM_COLORS[al] || "#999"}" title="${escapeHtml(al)}: ${counts.get(al)}"></span>`).join("");
}

function hitHTML(h, flatMeta) {
  const ctx = (l) => l ? `<div class="sx-ctx">${escapeHtml(l)}</div>` : "";
  const ann = flatMeta
    ? `<div class="sx-ann sx-ann-flat">${flatMeta}</div>`
    : `<div class="sx-ann"><span class="sx-sec">${escapeHtml(h.sectionLabel)}</span><span class="sx-ln">l.${h.lineNo}</span></div>`;
  return `<div class="sx-hit${flatMeta ? " sx-hit-flat" : ""}">${ann}<div class="sx-lines">${ctx(h.prev)}<div class="sx-main">${h.html}</div>${ctx(h.next)}</div></div>`;
}

function render(q, groups) {
  const songs = groups.length;
  const lines = groups.reduce((n, g) => n + g.hits.length, 0);
  if (!songs) {
    const where = [];
    if (state.section !== "any") where.push(state.section.toLowerCase());
    if (state.pos === "start") where.push("at line start");
    if (state.pos === "end") where.push("at line end");
    const ctx = where.length ? ` (${where.join(", ")})` : "";
    const tip = state.mode !== "fuzzy" && !where.length ? " — try fuzzy for typos." : ".";
    $("counter").innerHTML = `<span class="sx-none">No lyrics match <b>${escapeHtml(q)}</b>${ctx}${tip}</span>`;
    $("bar").innerHTML = "";
    $("results").innerHTML = "";
    return;
  }
  $("counter").innerHTML = `found in <b>${plural(songs, "song")}</b> &middot; <b>${plural(lines, "line")}</b>`;
  $("bar").innerHTML = albumBar(groups);

  if (state.grouped) {
    // Group by album (a binder divider per album), songs within. Albums in release order.
    const byAlbum = new Map();
    for (const g of groups) {
      if (!byAlbum.has(g.song.album)) byAlbum.set(g.song.album, []);
      byAlbum.get(g.song.album).push(g);
    }
    const albums = [...byAlbum.keys()].sort((a, b) => ALBUM_INDEX.get(a) - ALBUM_INDEX.get(b));
    $("results").innerHTML = albums.map((al) => {
      const color = ALBUM_COLORS[al] || "#999";
      const songs = byAlbum.get(al).map((g) => {
        const hits = g.hits.map((h) => hitHTML(h, null)).join("");
        return `<div class="sx-song">
          <div class="sx-song-head">
            <span class="sx-song-title">${escapeHtml(g.song.title)}</span>
            <span class="sx-song-count">${plural(g.hits.length, "line")}</span>
          </div>${hits}</div>`;
      }).join("");
      return `<section class="sx-album" style="--album:${color}">
        <div class="sx-album-tab"><span class="sx-album-era">${escapeHtml(al)}</span></div>
        ${songs}</section>`;
    }).join("");
  } else {
    const rows = [];
    for (const g of groups) {
      const color = ALBUM_COLORS[g.song.album] || "#999";
      for (const h of g.hits) {
        const meta = `<span class="sx-dot" style="--album:${color}"></span><span class="sx-flat-title">${escapeHtml(g.song.title)}</span><span class="sx-flat-album">${escapeHtml(g.song.album)}</span><span class="sx-flat-loc">${escapeHtml(h.sectionLabel)} &middot; l.${h.lineNo}</span>`;
        rows.push(hitHTML(h, meta));
      }
    }
    $("results").innerHTML = `<div class="sx-flat" style="--album:#999">${rows.join("")}</div>`;
  }
}

/* ---------- deep links ---------- */
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("q")) state.q = p.get("q");
  if (["stem", "exact", "fuzzy"].includes(p.get("mode"))) state.mode = p.get("mode");
  if (p.get("view") === "flat") state.grouped = false;
  if (p.get("section") && SECTION_TYPES.includes(p.get("section"))) state.section = p.get("section");
  if (["start", "end"].includes(p.get("pos"))) state.pos = p.get("pos");
}
function writeHash() {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set("q", state.q.trim());
  if (state.mode !== "stem") p.set("mode", state.mode);
  if (!state.grouped) p.set("view", "flat");
  if (state.section !== "any") p.set("section", state.section);
  if (state.pos !== "any") p.set("pos", state.pos);
  history.replaceState(null, "", "#" + p.toString());
}

/* ---------- wiring ---------- */
function syncToggles() {
  for (const b of document.querySelectorAll("[data-mode]")) b.classList.toggle("on", b.dataset.mode === state.mode);
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("on", (b.dataset.view === "flat") === !state.grouped);
  $("section").classList.toggle("active", state.section !== "any");
  $("pos").classList.toggle("active", state.pos !== "any");
}

function init() {
  readHash();
  const input = $("q");
  input.value = state.q;

  // Populate the section-type filter from the types actually present in the data.
  $("section").innerHTML = `<option value="any">any section</option>` +
    SECTION_TYPES.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t.toLowerCase())}</option>`).join("");
  $("section").value = state.section;
  $("pos").value = state.pos;
  syncToggles();

  let t;
  input.addEventListener("input", () => {
    state.q = input.value;
    clearTimeout(t);
    t = setTimeout(runSearch, state.mode === "fuzzy" ? 220 : 120);
  });
  for (const b of document.querySelectorAll("[data-mode]")) {
    b.addEventListener("click", () => { state.mode = b.dataset.mode; syncToggles(); runSearch(); });
  }
  for (const b of document.querySelectorAll("[data-view]")) {
    b.addEventListener("click", () => { state.grouped = b.dataset.view !== "flat"; syncToggles(); runSearch(); });
  }
  $("section").addEventListener("change", (e) => { state.section = e.target.value; syncToggles(); runSearch(); });
  $("pos").addEventListener("change", (e) => { state.pos = e.target.value; syncToggles(); runSearch(); });
  runSearch();
  if (!state.q) input.focus();
}

loadData()
  .then(init)
  .catch((err) => {
    console.error(err);
    $("results").innerHTML = `<p class="sx-hint">Couldn't load the lyrics. ${escapeHtml(err.message)}</p>`;
  });

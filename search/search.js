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

const state = { q: "", mode: "stem", grouped: true };

/* ---------- data ---------- */
async function loadData() {
  const res = await fetch("../songs.json");
  if (!res.ok) throw new Error("Failed to load songs.json");
  const grouped = await res.json();
  grouped.forEach((g, i) => ALBUM_INDEX.set(g.album, i));
  SONGS = grouped.flatMap(({ album, songs }) =>
    songs.map((s) => ({ title: s.title, album, sections: Array.isArray(s.sections) ? s.sections : [] }))
  );
}

/* ---------- search ---------- */
function sectionName(label) { return label && label.trim() ? label : "(intro)"; }

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

function fuzzyHighlight(line, tok) {
  if (!tok) return escapeHtml(line);
  const idx = line.toLowerCase().indexOf(tok.toLowerCase());
  if (idx < 0) return escapeHtml(line);
  return escapeHtml(line.slice(0, idx)) + "<mark>" + escapeHtml(line.slice(idx, idx + tok.length)) +
    "</mark>" + escapeHtml(line.slice(idx + tok.length));
}

function searchSong(song, q, mode) {
  const hits = [];
  const disp = sectionDisplays(song);
  if (mode === "fuzzy") {
    const ql = q.toLowerCase();
    song.sections.forEach((sec, si) => {
      (sec.lines || []).forEach((line, li) => {
        let best = 0, bestTok = null;
        for (const tok of line.split(/[^A-Za-z']+/)) {
          if (tok.length < 2 || Math.abs(tok.length - ql.length) > 2) continue;   // cheap length prefilter
          const r = fuzzySubstringRatio(ql, tok.toLowerCase());
          if (r > best) { best = r; bestTok = tok; }
        }
        if (best >= FUZZY_MIN) hits.push(makeHit(sec, si, li, disp[si], fuzzyHighlight(line, bestTok)));
      });
    });
  } else {
    const strict = mode === "exact";
    const rx = wordRegex(q, strict);
    song.sections.forEach((sec, si) => {
      (sec.lines || []).forEach((line, li) => {
        if (rx.test(line)) hits.push(makeHit(sec, si, li, disp[si], highlightWord(line, q, strict)));
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
    $("counter").innerHTML = `<span class="sx-none">No lyrics match <b>${escapeHtml(q)}</b>${state.mode !== "fuzzy" ? " — try fuzzy for typos." : "."}</span>`;
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
}
function writeHash() {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set("q", state.q.trim());
  if (state.mode !== "stem") p.set("mode", state.mode);
  if (!state.grouped) p.set("view", "flat");
  history.replaceState(null, "", "#" + p.toString());
}

/* ---------- wiring ---------- */
function syncToggles() {
  for (const b of document.querySelectorAll("[data-mode]")) b.classList.toggle("on", b.dataset.mode === state.mode);
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("on", (b.dataset.view === "flat") === !state.grouped);
}

function init() {
  readHash();
  const input = $("q");
  input.value = state.q;
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
  runSearch();
  if (!state.q) input.focus();
}

loadData()
  .then(init)
  .catch((err) => {
    console.error(err);
    $("results").innerHTML = `<p class="sx-hint">Couldn't load the lyrics. ${escapeHtml(err.message)}</p>`;
  });

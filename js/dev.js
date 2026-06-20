// Dev cheats panel — loaded only behind the ?dev flag (see devActive in app.js).
// Deliberately un-notebook (dark, monospace, fixed corner) so it can never be
// confused with the game UI. Receives a curated `api` from app.js's buildDevApi.

export function initDev(api) {
  injectStyles();

  // ---- helpers ---------------------------------------------------------------
  const mk = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) e.append(kid && kid.nodeType ? kid : document.createTextNode(kid));
    return e;
  };
  const btn = (label, fn, cls = "") => mk("button", { class: "dv-btn " + cls, onclick: fn }, label);
  const select = (items, getVal, getLabel) => {
    const s = mk("select", { class: "dv-sel" });
    for (const it of items) s.append(mk("option", { value: getVal(it) }, getLabel(it)));
    return s;
  };
  const num = (val, w = 46) => mk("input", { type: "number", class: "dv-num", value: String(val), style: `width:${w}px` });
  const row = (...kids) => mk("div", { class: "dv-row" }, ...kids);
  const section = (title, ...kids) => mk("div", { class: "dv-sec" }, mk("div", { class: "dv-sec-t" }, title), ...kids);

  // ---- panel shell -----------------------------------------------------------
  const body = mk("div", { class: "dv-body" });
  const readout = mk("div", { class: "dv-readout" }, "—");
  const head = mk("div", { class: "dv-head" },
    mk("span", { class: "dv-title" }, "🔧 dev cheats"),
    readout,
    mk("button", { class: "dv-collapse", onclick: () => panel.classList.toggle("dv-min") }, "▾"));
  const panel = mk("div", { id: "dev-panel" }, head, body);
  document.body.append(panel);

  // ---- Inspect ---------------------------------------------------------------
  const answerBox = mk("pre", { class: "dv-pre", style: "display:none" });
  let revealOpen = false;
  body.append(section("inspect",
    row(btn("reveal answers", () => { revealOpen = !revealOpen; answerBox.style.display = revealOpen ? "" : "none"; renderReveal(); }),
        btn("log state", () => console.log("[dev] state", api.getState()))),
    answerBox));
  function renderReveal() {
    if (!revealOpen) return;
    const st = api.getState();
    if (!st.valid.length) { answerBox.textContent = `"${st.word || "—"}" — no valid songs (or not in a round)`; return; }
    answerBox.textContent = `"${st.word}" → ${st.valid.length} song(s)\n` +
      st.valid.map((v) => `• ${v.title}${v.album ? "  [" + v.album + "]" : ""}\n    “${v.line}”`).join("\n");
  }

  // ---- Round control ---------------------------------------------------------
  const wordInput = mk("input", { class: "dv-text", list: "dv-words", placeholder: "force word…", style: "width:120px" });
  const wordList = mk("datalist", { id: "dv-words" });
  api.words().forEach((w) => wordList.append(mk("option", { value: w })));
  const jumpN = num(1);
  const scoreN = num(0);
  body.append(section("round",
    row(btn("✓ correct", () => api.answer("correct")),
        btn("✗ wrong", () => api.answer("wrong")),
        btn("⏱ timeout", () => api.answer("timeout")),
        btn("↪ advance", () => api.advance())),
    row(wordInput, wordList, btn("set word", () => { if (wordInput.value.trim()) api.setWord(wordInput.value.trim()); })),
    row("jump→", jumpN, btn("go", () => api.jumpToRound(+jumpN.value)),
        "score=", scoreN, btn("set", () => api.setScore(+scoreN.value)),
        btn("end now", () => api.endNow(), "warn"))));

  // ---- Simulate --------------------------------------------------------------
  const simN = num(13);
  const simType = select(["classic", "infinite", "daily"], (x) => x, (x) => x);
  const simMode = select(api.MODE_ORDER, (x) => x, (x) => x);
  body.append(section("simulate full game",
    row("correct=", simN, "/13"),
    row(simType, simMode, btn("run", () => api.simulate(+simN.value, { type: simType.value, mode: simMode.value }))),
    row(btn("auto-win 13/13", () => api.simulate(13, { type: "classic", mode: simMode.value })),
        btn("auto-lose 0/13", () => api.simulate(0, { type: "classic", mode: simMode.value })))));

  // ---- Start games -----------------------------------------------------------
  const startMode = select(api.MODE_ORDER, (x) => x, (x) => x);
  const infVar = select(["3lives", "sudden"], (x) => x, (x) => x);
  body.append(section("start game",
    row(startMode, btn("start classic", () => api.start(startMode.value))),
    row(infVar, btn("start infinite", () => api.startInfinite(infVar.value)),
        btn("start daily", () => api.startDaily()))));

  // ---- Word / Era / Mode -----------------------------------------------------
  const eraSel = select(api.ERAS, (x) => x, (x) => x);
  const modeSel = select(api.MODE_ORDER, (x) => x, (x) => x);
  body.append(section("era / mode",
    row(eraSel, btn("apply era", () => api.setEra(eraSel.value)),
        modeSel, btn("set mode", () => api.setMode(modeSel.value)))));

  // ---- Timer -----------------------------------------------------------------
  let frozen = false;
  const freezeBtn = btn("freeze", () => {
    if (!frozen) { if (api.timer.freeze()) { frozen = true; freezeBtn.textContent = "unfreeze"; freezeBtn.classList.add("on"); } }
    else { api.timer.unfreeze(); frozen = false; freezeBtn.textContent = "freeze"; freezeBtn.classList.remove("on"); }
  });
  body.append(section("timer",
    row(freezeBtn, btn("+5s", () => api.timer.add(5)), btn("−5s", () => api.timer.add(-5)),
        btn("set 3s", () => api.timer.set(3)), btn("disable", () => { api.timer.disable(); frozen = false; freezeBtn.textContent = "freeze"; freezeBtn.classList.remove("on"); }, "warn"))));

  // ---- Daily -----------------------------------------------------------------
  const dateInput = mk("input", { type: "date", class: "dv-text", style: "width:124px" });
  const stCur = num(5), stBest = num(9);
  body.append(section("daily",
    row(btn("reset today (replay)", () => { api.daily.resetToday(); toast("today's daily cleared"); })),
    row(dateInput, btn("set date", () => { api.daily.setDate(dateInput.value); toast("date → " + (dateInput.value || "live")); }),
        btn("clear", () => { api.daily.setDate(null); dateInput.value = ""; toast("date → live"); })),
    row("streak cur", stCur, "best", stBest, btn("set", () => { api.daily.setStreak(+stCur.value, +stBest.value); toast("streak set"); }))));

  // ---- Seeding ---------------------------------------------------------------
  const achSel = select(api.ACHIEVEMENTS, (a) => a.id, (a) => a.name + (a.secret ? " (hidden)" : ""));
  const histN = num(25);
  const nameInput = mk("input", { class: "dv-text", placeholder: "name", style: "width:96px" });
  body.append(section("seed data",
    row(btn("fake records", () => { api.seed.records(); toast("records seeded"); }),
        btn("seed history", () => { api.seed.history(+histN.value); toast("history seeded"); }), histN),
    row(btn("seed tally", () => { api.seed.tally(); toast("tally seeded"); }),
        btn("unlock all ach", () => { api.seed.unlockAch(); toast("all achievements unlocked"); }),
        btn("lock all", () => { api.seed.lockAch(); toast("achievements cleared"); }, "warn")),
    row(achSel, btn("fire", () => api.seed.fireAch(achSel.value))),
    row(nameInput, btn("set name", () => { if (nameInput.value.trim()) { api.seed.setName(nameInput.value.trim()); toast("name set"); } }))));

  // ---- Visual eggs -----------------------------------------------------------
  const penSel = select(["", "quill", "fountain", "glitter"], (x) => x, (x) => x || "no pen");
  const doodleSel = select(["cat", "guitar", "scarf", "fence", "thirteen", "snake"], (x) => x, (x) => x);
  body.append(section("eggs",
    row(btn("snake", () => api.eggs.snake()), doodleSel, btn("doodle", () => api.eggs.doodle(doodleSel.value)),
        btn("sparkle", () => api.eggs.sparkle())),
    row(btn("star shower", () => api.eggs.starShower()), btn("blue wash", () => api.eggs.blueWash()),
        btn("secret 13", () => api.eggs.secret13())),
    row(penSel, btn("set pen", () => api.eggs.pen(penSel.value)))));

  // ---- Reset (danger) --------------------------------------------------------
  body.append(section("reset",
    row(btn("records", () => { api.reset.records(); toast("records reset"); }, "warn"),
        btn("stats", () => { api.reset.stats(); toast("stats reset"); }, "warn"),
        btn("ach", () => { api.reset.ach(); toast("achievements reset"); }, "warn"),
        btn("tally", () => { api.reset.tally(); toast("tally reset"); }, "warn"),
        btn("daily", () => { api.reset.daily(); toast("daily reset"); }, "warn")),
    row(btn("WIPE ALL + reload", () => { if (confirm("Wipe ALL app data?")) { api.reset.all(); api.reload(); } }, "danger"))));

  // ---- Footer ----------------------------------------------------------------
  const noLog = mk("input", { type: "checkbox", id: "dv-nolog", onchange: (e) => { api.setNoLog(e.target.checked); toast(e.target.checked ? "test runs won't be logged" : "logging on"); } });
  body.append(section("",
    row(mk("label", { class: "dv-check" }, noLog, " don't log runs"),
        btn("→ start", () => api.goStart()), btn("reload", () => api.reload()))));

  // ---- live readout + toast --------------------------------------------------
  function tick() {
    const s = api.getState();
    readout.textContent = `${s.screen} · r${s.round}/${s.total} · ${s.score}pt · ${s.mode}/${s.gameType} · ${s.era || "—"}` +
      (s.word ? ` · “${s.word}”` : "") + (s.devDate ? ` · date:${s.devDate}` : "") + (s.devNoLog ? " · NOLOG" : "");
    renderReveal();
  }
  tick();
  setInterval(tick, 600);

  let toastEl = null, toastT = null;
  function toast(msg) {
    if (!toastEl) { toastEl = mk("div", { class: "dv-toast" }); panel.append(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove("show"), 1600);
  }

  // Backtick toggles the whole panel; also expose for the console.
  document.addEventListener("keydown", (e) => {
    if (e.key === "`" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      panel.classList.toggle("dv-hidden");
    }
  });
  window.__dev = api;
  console.log("%c[dev] cheats armed — backtick (`) toggles the panel · window.__dev for the API", "color:#7cd");
}

function injectStyles() {
  if (document.getElementById("dev-styles")) return;
  const css = `
  #dev-panel { position: fixed; right: 10px; bottom: 10px; width: 312px; max-height: 86vh;
    display: flex; flex-direction: column; background: #14161b; color: #cdd3dc;
    font: 11px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    border: 1px solid #2c313c; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.5);
    z-index: 2147483000; overflow: hidden; }
  #dev-panel.dv-hidden { display: none; }
  .dv-head { display: flex; align-items: center; gap: 8px; padding: 7px 9px; background: #1b1e26;
    border-bottom: 1px solid #2c313c; cursor: default; }
  .dv-title { color: #7cd; font-weight: 700; white-space: nowrap; }
  .dv-readout { flex: 1; color: #8a93a3; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dv-collapse { background: none; border: none; color: #8a93a3; cursor: pointer; font-size: 13px; padding: 0 2px; }
  #dev-panel.dv-min .dv-body { display: none; }
  #dev-panel.dv-min .dv-collapse { transform: rotate(-90deg); }
  .dv-body { overflow-y: auto; padding: 4px 9px 9px; }
  .dv-sec { padding: 7px 0 2px; border-top: 1px solid #232833; margin-top: 5px; }
  .dv-sec:first-child { border-top: none; margin-top: 0; }
  .dv-sec-t { color: #5f6b7d; text-transform: uppercase; letter-spacing: .06em; font-size: 9px; margin-bottom: 5px; }
  .dv-sec-t:empty { display: none; }
  .dv-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 4px; }
  .dv-btn { background: #262c38; color: #d6dce6; border: 1px solid #38404f; border-radius: 5px;
    padding: 3px 7px; cursor: pointer; font: inherit; }
  .dv-btn:hover { background: #2f3747; border-color: #4a5468; }
  .dv-btn.on { background: #1d4e54; border-color: #2f7d86; color: #9fe9f0; }
  .dv-btn.warn { border-color: #5a4324; color: #e6c189; }
  .dv-btn.warn:hover { background: #3a2c16; }
  .dv-btn.danger { background: #4a1f24; border-color: #7d3138; color: #f0a9af; width: 100%; }
  .dv-btn.danger:hover { background: #5e272d; }
  .dv-sel, .dv-text, .dv-num { background: #0f1115; color: #cdd3dc; border: 1px solid #38404f;
    border-radius: 5px; padding: 2px 4px; font: inherit; }
  .dv-num { text-align: center; }
  .dv-check { display: inline-flex; align-items: center; gap: 3px; color: #9aa3b3; }
  .dv-pre { background: #0f1115; border: 1px solid #2c313c; border-radius: 5px; padding: 6px;
    margin: 2px 0 0; max-height: 160px; overflow: auto; white-space: pre-wrap; color: #aeb6c4; font-size: 10px; }
  .dv-toast { position: absolute; left: 9px; bottom: 9px; right: 9px; background: #1d4e54; color: #d6f6fa;
    padding: 5px 8px; border-radius: 5px; opacity: 0; transition: opacity .15s; pointer-events: none; text-align: center; }
  .dv-toast.show { opacity: 1; }
  `;
  const tag = document.createElement("style");
  tag.id = "dev-styles";
  tag.textContent = css;
  document.head.append(tag);
}

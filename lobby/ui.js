// ============================================================================
// VILLAIN ARC — Lobby UI controller
// ----------------------------------------------------------------------------
// Renders/updates DOM from LobbyState, wires every intent, runs the settings
// modal, the fake matchmaking timer, and the animated tickers. Screen switching
// is driven by #ui-root[data-screen]; CSS handles the fade/slide.
// ============================================================================
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const S = window.LobbyState;
  const I = window.LobbyIntents;

  let lastScreen = null;
  let lastVillainShown = null;
  let queueTimer = null;

  // ---- screen switching ----------------------------------------------------
  function setScreen(name) {
    $("#ui-root").setAttribute("data-screen", name);
  }

  // map screen -> the top-nav item that should glow
  function syncNav() {
    const map = { lobby: "play", select: "villains", leaderboard: "leaderboard" };
    const want = map[S.screen];
    $$(".nav-item").forEach((x) => x.classList.toggle("is-active", x.dataset.nav === want));
  }

  // ---- formatting ----------------------------------------------------------
  const fmtSol = (n) => (Math.round(n * 100) / 100).toFixed(n % 1 === 0 ? 1 : 2);
  function mmss(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  // ---- bar widget (playstyle / 1-5 dots) -----------------------------------
  function dots(n, max) {
    let h = '<span class="dots-bar">';
    for (let i = 1; i <= max; i++) h += '<i class="' + (i <= n ? "on" : "") + '"></i>';
    return h + "</span>";
  }

  // ---- render: lobby -------------------------------------------------------
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");

  function renderLobby() {
    const v = window.LobbyState_getSelected();

    // center stage label
    $("#lobby-villain-name").textContent = v.name;
    $("#lobby-villain-level").textContent = "LEVEL " + (v.level || 1);

    // top bar — profile + currencies
    $("#profile-handle").textContent = S.profile.handle;
    $("#profile-lvl").textContent = "LEVEL " + S.profile.level;
    $("#curr-token").textContent = fmtInt(S.currencies.token);
    $("#curr-gem").textContent = fmtInt(S.currencies.gem);

    // left rail — daily bounties (SOL rewards)
    $("#bo-reset").innerHTML = "&#9201; " + S.bountiesResetIn;
    $("#bo-list").innerHTML = S.bounties.map((b) => {
      const done = b.cur >= b.max;
      const pct = Math.max(0, Math.min(100, 100 * b.cur / b.max));
      return '<li class="bo-item' + (done ? " is-done" : "") + '">' +
        '<div class="bo-top"><span class="bo-text">' + b.text + '</span>' +
        '<span class="bo-prog">' + fmtInt(b.cur) + '/' + fmtInt(b.max) + '</span></div>' +
        '<div class="bo-bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="bo-reward">&#9670; ' + fmtSol(b.reward) + ' SOL' + (done ? ' &middot; CLAIM' : '') + '</div>' +
        '</li>';
    }).join("");

    // right rail — LATEST FROM X feed
    $("#feed-list").innerHTML = S.tweets.map((t) => {
      return '<li class="feed-item">' +
        '<div class="feed-row">' +
        '<span class="feed-avatar">&#9819;</span>' +
        '<span class="feed-handle-line">' + t.handle + '</span>' +
        '<span class="feed-time">' + t.time + '</span></div>' +
        '<div class="feed-text">' + t.text + '</div>' +
        '</li>';
    }).join("");

    // right rail — mode
    $("#mode-name").textContent = S.mode.name;
    $("#mode-sub").textContent = S.mode.sub;

    // bottom roster strip
    renderRosterStrip();
  }

  // ---- render: bottom roster strip -----------------------------------------
  function renderRosterStrip() {
    const strip = $("#roster-strip");
    if (!strip) return;
    strip.innerHTML = S.villains.map((v) => {
      if (v.locked) {
        return '<div class="rtile is-locked" data-villain="' + v.id + '">' +
          '<div class="rtile-art"></div>' +
          '<span class="rtile-silhouette">&#9760;</span>' +
          '<span class="rtile-lock">&#128274;</span>' +
          '<div class="rtile-name">SOON</div></div>';
      }
      const active = v.id === S.selectedVillain ? " is-active" : "";
      const art = v.portrait
        ? '<img class="rtile-art" src="' + v.portrait + '" alt="' + v.name + '" onerror="this.style.display=\'none\'" />'
        : '<div class="rtile-art"></div>';
      return '<div class="rtile' + active + '" data-villain="' + v.id + '">' +
        art +
        (active ? '<span class="rtile-check">&#10003;</span>' : "") +
        '<div class="rtile-name">' + v.name + '</div></div>';
    }).join("");
  }

  // ---- render: character select --------------------------------------------
  function renderSelect() {
    const sel = window.LobbyState_getSelected();
    // roster
    $("#roster").innerHTML = S.villains.map((v) => {
      const active = v.id === S.selectedVillain ? " is-active" : "";
      const locked = v.locked ? " is-locked" : "";
      const thumb = v.locked
        ? '<span class="roster-thumb is-locked">&#9760;</span>'
        : (v.portrait
            ? '<img class="roster-thumb" src="' + v.portrait + '" alt="' + v.name + '" onerror="this.style.visibility=\'hidden\'" />'
            : '<span class="roster-thumb"></span>');
      return '<button class="roster-item' + active + locked + '" data-villain="' + v.id + '"' +
        (v.locked ? " disabled" : "") + '>' +
        thumb +
        '<span class="roster-meta">' +
        '<span class="roster-name">' + v.name + '</span>' +
        '<span class="roster-arch">' + v.archetype + '</span>' +
        '</span>' +
        (v.locked ? '<span class="roster-lock">&#128274;</span>' : "") +
        '</button>';
    }).join("");

    $("#select-villain-name").textContent = sel.name;
    $("#select-villain-arch").textContent = sel.archetype;

    // loadout
    if (sel.locked) { $("#loadout").innerHTML = ""; return; }
    const ps = sel.playstyle;
    $("#loadout").innerHTML =
      '<div class="panel">' +
        '<div class="panel-head"><span>LOADOUT</span><span class="panel-sub">' + sel.weapon + '</span></div>' +
        skillRow("PASSIVE", sel.passive) +
        skillRow("Q", sel.q) +
        skillRow("E", sel.e) +
      '</div>' +
      '<div class="panel">' +
        '<div class="panel-head"><span>PLAYSTYLE</span><span class="panel-sub">' + ps.label + '</span></div>' +
        statBar("Mobility", ps.mobility) +
        statBar("Durability", ps.durability) +
        statBar("Damage", ps.damage) +
        '<p class="loadout-blurb">' + sel.blurb + '</p>' +
      '</div>';
  }
  function skillRow(key, sk) {
    return '<div class="skill-row">' +
      '<span class="skill-key">' + key + '</span>' +
      '<div class="skill-txt"><span class="skill-name">' + sk.name + '</span>' +
      '<span class="skill-desc">' + sk.desc + '</span></div></div>';
  }
  function statBar(label, n) {
    return '<div class="stat-line"><span class="stat-lbl">' + label + '</span>' + dots(n, 5) + '</div>';
  }

  // ---- render: results -----------------------------------------------------
  function renderResults() {
    const r = S.lastResult;
    $("#results-place").textContent = "#" + r.placement;
    $("#results-headline").textContent = r.placement === 1 ? "VICTORY" : "ELIMINATED";
    $("#results-place").classList.toggle("win", r.placement === 1);
    $("#rs-kills").textContent = r.kills;
    $("#rs-dmg").textContent = r.damage.toLocaleString();
    $("#rs-surv").textContent = mmss(r.survivedSec);
    $("#rs-earn").textContent = "+" + fmtSol(r.earnings) + " SOL";
  }

  // ---- render: leaderboard -------------------------------------------------
  function renderLeaderboard() {
    const rowHtml = (r, isYou) =>
      '<div class="lb-row' + (isYou ? " is-you" : "") + (r.rank <= 3 ? " is-top" : "") + '">' +
      '<span class="lb-rank">' + (r.rank <= 3 ? '<span class="lb-medal r' + r.rank + '">' + r.rank + '</span>' : r.rank) + '</span>' +
      '<span class="lb-name">' + r.name + '</span>' +
      '<span class="lb-num">' + fmtInt(r.wins) + '</span>' +
      '<span class="lb-num">' + fmtInt(r.kills) + '</span>' +
      '<span class="lb-num ember">' + fmtSol(r.earn) + ' SOL</span>' +
      '</div>';
    $("#lb-rows").innerHTML = S.leaderboard.map((r) => rowHtml(r, false)).join("");
    $("#lb-you").innerHTML = '<div class="lb-you-lbl">YOUR RANK</div>' +
      '<div class="lb-table">' + rowHtml(S.yourRank, true) + '</div>';
  }

  // ---- master render (subscriber) ------------------------------------------
  function render() {
    if (S.screen !== lastScreen) { setScreen(S.screen); lastScreen = S.screen; }

    // landing tickers update via animateTickers; static safety set here too
    $("#tk-online").textContent = Math.round(S.online).toLocaleString();
    $("#tk-pot").textContent = fmtSol(S.todayPot);

    if (S.screen === "lobby") renderLobby();
    if (S.screen === "select") renderSelect();
    if (S.screen === "leaderboard") renderLeaderboard();
    if (S.screen === "results") renderResults();

    // keep top nav highlight in sync with the active screen
    syncNav();

    // update 3D villain when selection changes (lobby & select share the canvas)
    if (S.screen === "lobby" || S.screen === "select") {
      if (lastVillainShown !== S.selectedVillain) {
        lastVillainShown = S.selectedVillain;
        if (window.LobbyScene) window.LobbyScene.showVillain(window.LobbyState_getSelected());
      }
    }
  }

  // ---- settings modal ------------------------------------------------------
  let activeTab = "controls";
  function openSettings() { $("#settings-modal").hidden = false; renderSettings(); }
  function closeSettings() { $("#settings-modal").hidden = true; }

  function renderSettings() {
    $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === activeTab));
    const body = $("#settings-body");
    const st = S.settings;
    if (activeTab === "controls") {
      const c = st.controls;
      const rows = [
        ["Move Up", "moveUp"], ["Move Down", "moveDown"], ["Move Left", "moveLeft"], ["Move Right", "moveRight"],
        ["Attack", "attack"], ["Skill Q", "skillQ"], ["Skill E", "skillE"], ["Sprint", "sprint"], ["Loot", "loot"],
        ["Inventory 1", "slot1"], ["Inventory 2", "slot2"], ["Inventory 3", "slot3"], ["Inventory 4", "slot4"], ["Inventory 5", "slot5"],
      ];
      body.innerHTML = '<div class="kb-grid">' + rows.map(([lbl, k]) =>
        '<div class="kb-row"><span class="kb-lbl">' + lbl + '</span>' +
        '<button class="kb-key" data-bind="' + k + '">' + c[k] + '</button></div>').join("") + '</div>';
    } else if (activeTab === "mouse") {
      const m = st.mouse;
      body.innerHTML =
        sliderRow("Sensitivity", "mouse", "sensitivity", m.sensitivity, 1, 100) +
        toggleRow("Invert Y", "mouse", "invertY", m.invertY);
    } else if (activeTab === "audio") {
      const a = st.audio;
      body.innerHTML =
        sliderRow("Master", "audio", "master", a.master, 0, 100) +
        sliderRow("Music", "audio", "music", a.music, 0, 100) +
        sliderRow("SFX", "audio", "sfx", a.sfx, 0, 100);
    } else if (activeTab === "graphics") {
      const q = st.graphics.quality;
      body.innerHTML = '<div class="seg-row"><span class="kb-lbl">Quality</span><div class="seg">' +
        ["LOW", "MED", "HIGH"].map((opt) =>
          '<button class="seg-opt' + (q === opt ? " is-active" : "") + '" data-gfx="' + opt + '">' + opt + '</button>').join("") +
        '</div></div>';
    }
    wireSettingsBody();
  }
  function sliderRow(lbl, grp, key, val, min, max) {
    return '<div class="slider-row"><span class="kb-lbl">' + lbl + '</span>' +
      '<input type="range" min="' + min + '" max="' + max + '" value="' + val + '" data-grp="' + grp + '" data-key="' + key + '">' +
      '<span class="slider-val num" data-valfor="' + grp + "." + key + '">' + val + '</span></div>';
  }
  function toggleRow(lbl, grp, key, val) {
    return '<div class="slider-row"><span class="kb-lbl">' + lbl + '</span>' +
      '<button class="toggle' + (val ? " on" : "") + '" data-grp="' + grp + '" data-key="' + key + '" data-toggle="1"></button></div>';
  }
  function wireSettingsBody() {
    // sliders
    $$('#settings-body input[type=range]').forEach((el) => {
      el.addEventListener("input", () => {
        const v = Number(el.value);
        I.setSetting(el.dataset.grp, el.dataset.key, v);
        const out = $('[data-valfor="' + el.dataset.grp + "." + el.dataset.key + '"]');
        if (out) out.textContent = v;
      });
    });
    // toggles
    $$('#settings-body [data-toggle]').forEach((el) => {
      el.addEventListener("click", () => {
        const cur = S.settings[el.dataset.grp][el.dataset.key];
        I.setSetting(el.dataset.grp, el.dataset.key, !cur);
        el.classList.toggle("on", !cur);
      });
    });
    // graphics segmented
    $$('#settings-body [data-gfx]').forEach((el) => {
      el.addEventListener("click", () => { I.setSetting("graphics", "quality", el.dataset.gfx); renderSettings(); });
    });
    // keybind capture (basic): click → press a key
    $$('#settings-body .kb-key').forEach((el) => {
      el.addEventListener("click", () => {
        el.textContent = "...";
        el.classList.add("capturing");
        const onKey = (e) => {
          e.preventDefault();
          let label = e.key === " " ? "Space" : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
          I.setSetting("controls", el.dataset.bind, label);
          el.textContent = label;
          el.classList.remove("capturing");
          window.removeEventListener("keydown", onKey, true);
        };
        window.addEventListener("keydown", onKey, true);
      });
    });
  }

  // ---- fake matchmaking ----------------------------------------------------
  function startQueue() {
    stopQueue();
    const statusEl = $("#queue-status");
    const set = (txt) => { statusEl.innerHTML = txt; };
    set('FINDING A LOBBY<span class="dots"><i>.</i><i>.</i><i>.</i></span>');
    queueTimer = setInterval(() => {
      if (S.screen !== "queue") { stopQueue(); return; }
      if (S.queue.found < S.queue.target) {
        S.queue.found += Math.random() < 0.6 ? 1 : 2;
        if (S.queue.found > S.queue.target) S.queue.found = S.queue.target;
        $("#queue-found").textContent = S.queue.found;
        $("#queue-fill").style.width = (100 * S.queue.found / S.queue.target) + "%";
        if (S.queue.found >= S.queue.target) {
          stopQueue();
          dropCountdown(set);
        }
      }
    }, 420);
  }
  function dropCountdown(set) {
    let n = 3;
    set("LOBBY FULL");
    const tick = () => {
      if (S.screen !== "queue") return;
      if (n > 0) { set('DROPPING IN <span class="ember">' + n + "</span>"); n--; setTimeout(tick, 850); }
      else { set("DROP!"); setTimeout(() => { if (S.screen === "queue") I.showResults(); }, 700); }
    };
    setTimeout(tick, 700);
  }
  function stopQueue() { if (queueTimer) { clearInterval(queueTimer); queueTimer = null; } }

  // ---- animated landing tickers --------------------------------------------
  function animateTickers() {
    // ease mock numbers toward live-ish targets with gentle jitter
    const onlineTarget = 2480, potTarget = 312.5;
    S.online = S.online || 0; S.todayPot = S.todayPot || 0;
    setInterval(() => {
      S.online += (onlineTarget - S.online) * 0.08 + (Math.random() - 0.5) * 6;
      S.todayPot += (potTarget - S.todayPot) * 0.08 + (Math.random() - 0.5) * 0.4;
      if (S.online < 0) S.online = 0; if (S.todayPot < 0) S.todayPot = 0;
      const o = $("#tk-online"), p = $("#tk-pot");
      if (o) o.textContent = Math.round(S.online).toLocaleString();
      if (p) p.textContent = fmtSol(S.todayPot);
    }, 90);
  }

  // ---- wire static controls ------------------------------------------------
  function wire() {
    // landing
    $("#btn-connect").addEventListener("click", () => I.connectWallet());
    $("#btn-guest").addEventListener("click", () => I.playGuest());

    // lobby nav (PLAY / VILLAINS / LEADERBOARD / SETTINGS)
    $$(".nav-item").forEach((b) => b.addEventListener("click", () => {
      const nav = b.dataset.nav;
      if (nav === "settings-nav") { openSettings(); return; }
      if (nav === "play") I.goto("lobby");
      else if (nav === "villains") I.goto("select");
      else if (nav === "leaderboard") I.goto("leaderboard");
    }));
    $("#btn-find").addEventListener("click", () => { I.findMatch(); startQueue(); });

    // right rail: game-mode cycle
    $("#btn-mode").addEventListener("click", () => I.cycleMode());
    // left rail: bounties card → open the full leaderboard
    $("#btn-all-bounties").addEventListener("click", () => I.goto("leaderboard"));
    // leaderboard screen back button
    $("#btn-lb-back").addEventListener("click", () => I.goto("lobby"));

    // bottom roster strip (delegated; selecting swaps the 3D hero)
    $("#roster-strip").addEventListener("click", (e) => {
      const tile = e.target.closest("[data-villain]");
      if (tile && !tile.classList.contains("is-locked")) I.selectVillain(tile.dataset.villain);
    });

    // settings
    $("#btn-settings").addEventListener("click", openSettings);
    $("#settings-close").addEventListener("click", closeSettings);
    $("#settings-done").addEventListener("click", closeSettings);
    $("#settings-reset").addEventListener("click", () => { I.resetSettings(); renderSettings(); });
    $$(".tab").forEach((t) => t.addEventListener("click", () => { activeTab = t.dataset.tab; renderSettings(); }));
    $("#settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") closeSettings(); });

    // character select (roster wired via delegation since it re-renders)
    $("#roster").addEventListener("click", (e) => {
      const item = e.target.closest("[data-villain]");
      if (item && !item.disabled) I.selectVillain(item.dataset.villain);
    });
    $("#btn-select-back").addEventListener("click", () => I.goto("lobby"));
    $("#btn-lock-in").addEventListener("click", () => I.goto("lobby"));

    // queue
    $("#btn-cancel-queue").addEventListener("click", () => { stopQueue(); I.cancelQueue(); });

    // results
    $("#btn-again").addEventListener("click", () => { I.findMatch(); startQueue(); });
    $("#btn-tolobby").addEventListener("click", () => I.goto("lobby"));
    $("#btn-share").addEventListener("click", () => {});
  }

  function init() {
    wire();
    window.LobbyState_subscribe(render);
    animateTickers();
    render();
  }

  window.LobbyUI = { init };
})();

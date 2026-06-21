"use strict";
// hud.js — DOM HUD updates for the neon-noir battle-royale overlay.
// Reads window.room, window.mySid.
// Exposes: window.GANKHud = { update }
//
// JS hooks (same IDs as the contract):
//   timer       — textContent = "M:SS"   (storm / match time left)
//   alivev      — textContent = N        (villains still alive — BR signature stat)
//   hpv         — textContent = HP integer (label beside the HP gauge)
//   mpv         — textContent = MP integer (label beside the MP gauge)
//   goldv       — textContent = gold + "g"
//   respawn     — style.display = "block" / "none"
//   board       — innerHTML with div.row (and .me for local player)
//   hpfill      — style.width = pct%   (drives the green→magenta HP gauge fill)
//   mpfill      — style.width = pct%   (drives the violet→cyan MP gauge fill)
//   upgpanel    — innerHTML with .upgslot tiles (keys 1-5: dmg/hp/mp/pow/cd)
//
// Extra (added for BR, all optional — guarded if element missing):
//   healthbar   — toggles .low class when HP <= 30%
//   stormbox    — toggles .urgent class when time left <= 30s

const GANKHud = (() => {

  // ---- upgrade config (mirrors server UPGRADE_COSTS / UPGRADE_MAX) ----
  const UPG = [
    { key: "dmg", ico: "&#9876;",  label: "DMG",  costs: [40, 80, 140, 220],  max: 4 },
    { key: "hp",  ico: "&#10084;", label: "HP",   costs: [50, 100, 180, 280], max: 4 },
    { key: "mp",  ico: "&#128965;",label: "MP",   costs: [40, 80, 140, 220],  max: 4 },
    { key: "pow", ico: "&#128293;",label: "POW",  costs: [60, 120, 200, 300], max: 4 },
    { key: "cd",  ico: "&#8987;",  label: "CD",   costs: [50, 100, 180, 280], max: 4 },
  ];

  function fmtTime(s) {
    s = Math.max(0, s | 0);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function update() {
    const room  = window.room;
    const mySid = window.mySid;
    if (!room || !room.state) return;
    const st = room.state;

    // ---- Storm timer ----
    const timeLeft = st.timeLeft | 0;
    document.getElementById("timer").textContent = fmtTime(timeLeft);
    const stormbox = document.getElementById("stormbox");
    if (stormbox) stormbox.classList.toggle("urgent",
      st.phase === "playing" && timeLeft <= 30);

    // ---- ALIVE counter (battle-royale signature stat) ----
    const aliveEl = document.getElementById("alivev");
    if (aliveEl) aliveEl.textContent = Math.max(0, st.alive | 0);

    // ---- Local player state ----
    const me = st.players.get(mySid);

    // HP gauge (width-driven; green → magenta when low)
    const hp    = me ? Math.max(0, me.hp   | 0) : 0;
    const maxhp = me ? Math.max(1, me.maxhp | 0) : 1;
    const hpPct = Math.min(100, Math.round((hp / maxhp) * 100));
    document.getElementById("hpv").textContent     = hp;
    document.getElementById("hpfill").style.width  = hpPct + "%";
    const hbar = document.getElementById("healthbar");
    if (hbar) hbar.classList.toggle("low", hpPct <= 30);

    // MP gauge (width-driven)
    const mp    = me ? Math.max(0, me.mp   | 0) : 0;
    const maxmp = me ? Math.max(1, me.maxmp | 0) : 1;
    const mpPct = Math.min(100, Math.round((mp / maxmp) * 100));
    document.getElementById("mpv").textContent     = mp;
    document.getElementById("mpfill").style.width  = mpPct + "%";

    // Gold counter
    const gold = me ? (me.gold | 0) : 0;
    document.getElementById("goldv").textContent = gold + "g";

    // Respawn overlay
    document.getElementById("respawn").style.display =
      (me && !me.alive && st.phase === "playing") ? "block" : "none";

    // ---- Leaderboard ----
    const arr = [];
    st.players.forEach((p, sid) => arr.push({ name: p.name || "?", kills: p.kills | 0, sid }));
    arr.sort((a, b) => b.kills - a.kills);
    document.getElementById("board").innerHTML = arr.slice(0, 6).map((r) =>
      `<div class="row ${r.sid === mySid ? "me" : ""}">` +
      `<span>${r.name}</span><span>${r.kills}</span></div>`
    ).join("");

    // ---- Upgrade panel ----
    updateUpgradePanel(me, gold);
  }

  function updateUpgradePanel(me, gold) {
    const panel = document.getElementById("upgpanel");
    if (!panel) return;

    const lvls = me ? {
      dmg: me.dmgLvl | 0,
      hp:  me.hpLvl  | 0,
      mp:  me.mpLvl  | 0,
      pow: me.powLvl | 0,
      cd:  me.cdLvl  | 0,
    } : { dmg: 0, hp: 0, mp: 0, pow: 0, cd: 0 };

    // Build innerHTML fresh each frame (upgrade states change rarely — acceptable)
    panel.innerHTML = UPG.map((u, i) => {
      const lvl    = lvls[u.key];
      const maxed  = lvl >= u.max;
      const cost   = maxed ? "MAX" : u.costs[lvl];
      const canBuy = !maxed && gold >= u.costs[lvl];

      // Stars representing current level
      const stars = lvl > 0 ? ("&#9733;".repeat(lvl)) : "";

      let cls = "upgslot";
      if (maxed)       cls += " maxed";
      else if (canBuy) cls += " afford";
      else             cls += " poor";

      return (
        `<div class="${cls}" data-what="${u.key}">` +
        `<span class="uico">${u.ico}</span>` +
        `<span class="ulvl">${stars || u.label}</span>` +
        `<span class="ucost">${maxed ? "MAX" : cost + "g"}</span>` +
        `<span class="ukey">${i + 1}</span>` +
        `</div>`
      );
    }).join("");

    // Re-attach click handlers (fresh elements each update)
    panel.querySelectorAll(".upgslot:not(.maxed):not(.poor)").forEach((el) => {
      el.style.pointerEvents = "auto";
      el.onclick = () => {
        if (window.room) window.room.send("buy", { what: el.dataset.what });
      };
    });
  }

  return { update };
})();

window.GANKHud = GANKHud;

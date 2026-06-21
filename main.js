"use strict";
// main.js — title screen, hero select, boot wiring.
// Depends on: scene.js, entities.js, hud.js, input.js, net.js (all loaded before this).

// Villain Arc roster — index 0 = villain_a, 1 = villain_b (Artem's Tripo models).
// Placeholder original names (IP-safe archetypes); finalize with owner.
const CLASS_NAMES = ["WARLORD", "SORCERER"];

let chosenHero = 0;

// ---- title screen ----
function buildTitle() {
  const wrap = document.getElementById("heroes");
  CLASS_NAMES.forEach((n, i) => {
    const d = document.createElement("div");
    d.className = "hero" + (i === 0 ? " sel" : "");
    d.textContent = n;
    d.onclick = () => {
      chosenHero = i;
      [...wrap.children].forEach((c) => c.classList.remove("sel"));
      d.classList.add("sel");
    };
    wrap.appendChild(d);
  });

  document.getElementById("playBtn").onclick = start;
  document.getElementById("nameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") start();
  });
}

async function start() {
  const name = (document.getElementById("nameInput").value || "VILLAIN").slice(0, 14);
  document.getElementById("playBtn").disabled = true;

  // Hide title, show the match lobby while we connect + wait for the drop.
  document.getElementById("title").style.display = "none";
  document.getElementById("lobby").style.display = "flex";

  const canvas = document.getElementById("renderCanvas");
  // No hub island anymore — straight into the arena (lobby overlay until match starts).
  await initArena(canvas, name, chosenHero);
}

// Called by HUB3D once the portal is entered. Creates the arena scene and connects.
async function initArena(canvas, name, heroIdx) {
  try {
    // init scene (creates new Engine + arena scene on the same canvas)
    GANKScene.initScene(canvas);

    // wire input (needs canvas + GANKScene reference); focus so key events fire immediately
    GANKInput.setup(canvas);
    GANKCamera.reset();
    canvas.tabIndex = 0;
    canvas.focus();

    // Preload hero + creep GLBs immediately after scene init so they're ready
    // before the first player/creep spawns. Fire-and-forget — loadTemplate is idempotent.
    (function preloadTemplates() {
      const cfgs = [...GANKEntities._MODEL_CONFIG_HEROES, ...GANKEntities._MODEL_CONFIG_CREEPS];
      cfgs.forEach((cfg) => { if (cfg && cfg.file) GANKEntities._loadTemplate(cfg).catch(() => {}); });
    })();

    // connect to room
    const room = await NET.connect(name, heroIdx);

    // expose for HUD / entity modules
    window.room  = room;
    window.mySid = NET.mySid;

    // HUD vs lobby visibility is driven per-frame by updateLobby() based on phase.

    // arena render loop
    GANKScene.engine.runRenderLoop(() => {
      const dtMs = GANKScene.engine.getDeltaTime();
      GANKEntities.tick(dtMs);
      updateCamera(dtMs);
      updateLobby();
      GANKHud.update();
      GANKScene.scene.render();
    });
  } catch (e) {
    console.error("[initArena] failed:", e && e.message || e);
  }
}

// ---- match lobby overlay (runs every frame; toggles lobby vs HUD by phase) ----
function updateLobby() {
  const room = window.room;
  if (!room || !room.state) return;
  const lobby = document.getElementById("lobby");
  const hud   = document.getElementById("hud");
  const phase = room.state.phase;

  if (phase === "playing") {
    if (lobby.style.display !== "none")  lobby.style.display = "none";
    if (hud.style.display   !== "block") hud.style.display   = "block";
    return;
  }

  // waiting / countdown / ended → show the lobby overlay
  if (lobby.style.display !== "flex") lobby.style.display = "flex";
  if (hud.style.display   !== "none") hud.style.display   = "none";

  const kicker = lobby.querySelector(".lobby-kicker");
  const timerEl = document.getElementById("lobby-timer");
  const countEl = document.getElementById("lobby-count");
  if (phase === "ended") {
    if (kicker) kicker.textContent = room.state.winner ? (room.state.winner + " WINS") : "MATCH OVER";
    if (timerEl) timerEl.textContent = "☠"; // skull
  } else {
    if (kicker) kicker.textContent = "ENTERING THE ARENA";
    if (timerEl) timerEl.textContent = phase === "countdown" ? String(room.state.countdown || 0) : "…";
  }
  if (countEl) countEl.textContent = room.state.players.size + " / 6";
}

// ---- camera follow (runs every frame inside render loop) ----
// Third-person PUBG-style follow lives in camera.js; this just feeds it the
// local player's predicted position.
function updateCamera(dtMs) {
  const me = GANKEntities.pviews[window.mySid];
  if (!me) return;
  GANKCamera.update(me.predX, me.predZ);
}

buildTitle();

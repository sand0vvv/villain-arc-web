// ============================================================================
// VILLAIN ARC — Lobby state + intents (mock layer)
// ----------------------------------------------------------------------------
// Single source of truth for the front-end. Real data (wallet, matchmaker,
// leaderboard) binds onto these same shapes later without rewriting the UI.
// All mutating actions go through Intents.* so the swap to real backends is
// a one-file change.
// ============================================================================
(function () {
  "use strict";

  // ---- villain roster (2 playable + locked roadmap slots) ------------------
  const VILLAINS = [
    {
      id: "sorcerer",
      name: "SORCERER",
      archetype: "pale · caster",
      model: "models/villains/villain_a.glb",
      portrait: "lobby/assets/portrait_sorcerer.png",
      idleIndex: 0,
      level: 10,
      locked: false,
      weapon: "Spell Bolt",
      playstyle: { label: "burst mage", mobility: 4, durability: 2, damage: 5 },
      passive: { name: "Siphon", desc: "Kills instantly refill max mana." },
      q: { name: "Frost Nova", desc: "AoE frost burst that slows nearby foes." },
      e: { name: "Blink", desc: "Short-range teleport dash to reposition." },
      blurb: "A pale conjurer who trades health for raw spell pressure.",
    },
    {
      id: "warlord",
      name: "WARLORD",
      archetype: "armored · melee",
      model: "models/villains/villain_b.glb",
      portrait: "lobby/assets/portrait_warlord.png",
      idleIndex: 2,
      level: 7,
      locked: false,
      weapon: "Cleaver",
      playstyle: { label: "frontline bruiser", mobility: 2, durability: 5, damage: 4 },
      passive: { name: "Dread Armor", desc: "Flat damage reduction + slow health regen." },
      q: { name: "Charge", desc: "Dash forward and stun the first enemy hit." },
      e: { name: "Quake Slam", desc: "Slam the ground, knocking back all around you." },
      blurb: "An armored dark-lord that walks through fire to reach you.",
    },
    { id: "locked1", name: "SOON", archetype: "unrevealed", locked: true },
    { id: "locked2", name: "SOON", archetype: "unrevealed", locked: true },
    { id: "locked3", name: "SOON", archetype: "unrevealed", locked: true },
    { id: "locked4", name: "SOON", archetype: "unrevealed", locked: true },
    { id: "locked5", name: "SOON", archetype: "unrevealed", locked: true },
  ];

  const LobbyState = {
    screen: "landing", // landing | lobby | select | queue | results
    connected: false,
    guest: false,
    balance: 0.0, // SOL
    stakeSol: 0.1,
    estPot: 1.2, // SOL (mock; ~12 villains * stake)
    online: 0, // animated mock
    todayPot: 0, // animated mock
    selectedVillain: "sorcerer",
    villains: VILLAINS,

    // ---- profile + currencies (top bar) ----
    profile: { handle: "VILLAIN#666", level: 42 },
    currencies: { token: 12450, gem: 890 },

    // ---- daily bounties (left rail) — fits the villain theme, SOL rewards ----
    bountiesResetIn: "12:45:33",
    bounties: [
      { text: "Eliminate 5 rivals", cur: 3, max: 5, reward: 0.05 },
      { text: "Win a wager match", cur: 0, max: 1, reward: 0.10 },
      { text: "Deal 2000 damage", cur: 1250, max: 2000, reward: 0.04 },
    ],

    // ---- LATEST FROM X (right rail) — mock tweets ----
    // TODO: wire to the real Twitter/X feed later. An x-agent (host persona)
    // posts roasts / pot hype / round countdowns; pull the latest 2-3 here.
    tweets: [
      { handle: "@VillainArc", text: "NOXFANG just took a 12.4 SOL pot off three challengers. Brutal. 💀", time: "2m" },
      { handle: "@VillainArc", text: "Next wager round drops in 5 min. Stake your SOL, last villain standing takes it all.", time: "18m" },
      { handle: "@VillainArc", text: "Clip of the day: a triple-kill comeback from 1 HP. GG GRIMVEIL.", time: "1h" },
    ],

    // ---- game mode (right rail) ----
    mode: { name: "BATTLE ROYALE", sub: "SOLO" },

    // ---- full leaderboard (rank / handle / wins / kills / earnings SOL) ----
    leaderboard: [
      { rank: 1, name: "NOXFANG", wins: 184, kills: 1422, earn: 142.6 },
      { rank: 2, name: "GRIMVEIL", wins: 167, kills: 1310, earn: 131.2 },
      { rank: 3, name: "ASHMAW", wins: 151, kills: 1188, earn: 124.9 },
      { rank: 4, name: "DREADMOOR", wins: 139, kills: 1097, earn: 98.4 },
      { rank: 5, name: "VOIDREAVER", wins: 128, kills: 1004, earn: 87.1 },
      { rank: 6, name: "HOLLOWFANG", wins: 121, kills: 962, earn: 79.6 },
      { rank: 7, name: "SABLECROWN", wins: 114, kills: 905, earn: 71.3 },
      { rank: 8, name: "MORROWBANE", wins: 108, kills: 871, earn: 64.8 },
      { rank: 9, name: "GLOOMHEX", wins: 97, kills: 802, earn: 58.2 },
      { rank: 10, name: "WRAITHKIN", wins: 90, kills: 744, earn: 51.7 },
    ],
    yourRank: { rank: 1287, name: "VILLAIN#666", wins: 0, kills: 0, earn: 0.0 },
    queue: { found: 0, target: 12 },
    lastResult: {
      placement: 1,
      kills: 6,
      damage: 4820,
      survivedSec: 487,
      earnings: 5.4,
    },
    settings: loadSettings(),
  };

  // ---- defaults + persistence ----------------------------------------------
  function defaultSettings() {
    return {
      controls: {
        moveUp: "W", moveDown: "S", moveLeft: "A", moveRight: "D",
        attack: "LMB", skillQ: "Q", skillE: "E", sprint: "Shift", loot: "F",
        slot1: "1", slot2: "2", slot3: "3", slot4: "4", slot5: "5",
      },
      mouse: { sensitivity: 50, invertY: false },
      audio: { master: 80, music: 60, sfx: 90 },
      graphics: { quality: "HIGH" },
    };
  }
  function loadSettings() {
    try {
      const raw = localStorage.getItem("va_settings");
      if (!raw) return defaultSettings();
      const parsed = JSON.parse(raw);
      // shallow-merge over defaults so new keys don't break old saves
      const d = defaultSettings();
      return {
        controls: Object.assign(d.controls, parsed.controls || {}),
        mouse: Object.assign(d.mouse, parsed.mouse || {}),
        audio: Object.assign(d.audio, parsed.audio || {}),
        graphics: Object.assign(d.graphics, parsed.graphics || {}),
      };
    } catch (_e) { return defaultSettings(); }
  }
  function saveSettings() {
    try { localStorage.setItem("va_settings", JSON.stringify(LobbyState.settings)); } catch (_e) {}
  }

  // ---- tiny pub/sub so UI re-renders on state change -----------------------
  const subs = [];
  function subscribe(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; }
  function emit() { subs.forEach((fn) => { try { fn(LobbyState); } catch (e) { console.error(e); } }); }

  function getSelected() {
    return LobbyState.villains.find((v) => v.id === LobbyState.selectedVillain) || LobbyState.villains[0];
  }

  // ---- intents (the only way to mutate) ------------------------------------
  const Intents = {
    goto(screen) { LobbyState.screen = screen; emit(); },

    connectWallet() {
      // STUB: real Phantom connect binds here later.
      LobbyState.connected = true;
      LobbyState.guest = false;
      LobbyState.balance = 8.42; // mock funded wallet
      LobbyState.screen = "lobby";
      emit();
    },

    playGuest() {
      LobbyState.connected = false;
      LobbyState.guest = true;
      LobbyState.balance = 0.0;
      LobbyState.screen = "lobby";
      emit();
    },

    selectVillain(id) {
      const v = LobbyState.villains.find((x) => x.id === id);
      if (!v || v.locked) return;
      LobbyState.selectedVillain = id;
      emit();
    },

    setStake(sol) { LobbyState.stakeSol = sol; emit(); },

    cycleMode() {
      const modes = [
        { name: "BATTLE ROYALE", sub: "SOLO" },
        { name: "BATTLE ROYALE", sub: "DUOS" },
        { name: "DEATHMATCH", sub: "FFA" },
      ];
      const i = modes.findIndex((m) => m.name === LobbyState.mode.name && m.sub === LobbyState.mode.sub);
      LobbyState.mode = modes[(i + 1) % modes.length];
      emit();
    },

    findMatch() {
      LobbyState.queue = { found: 1, target: 12 };
      LobbyState.screen = "queue";
      emit();
    },

    cancelQueue() {
      LobbyState.queue = { found: 0, target: 12 };
      LobbyState.screen = "lobby";
      emit();
    },

    showResults() { LobbyState.screen = "results"; emit(); },

    setSetting(group, key, value) {
      if (!LobbyState.settings[group]) return;
      LobbyState.settings[group][key] = value;
      saveSettings();
      emit();
    },

    resetSettings() {
      LobbyState.settings = defaultSettings();
      saveSettings();
      emit();
    },

    _emit: emit, // internal: for animated tickers
  };

  window.LobbyState = LobbyState;
  window.LobbyIntents = Intents;
  window.LobbyState_subscribe = subscribe;
  window.LobbyState_getSelected = getSelected;
})();

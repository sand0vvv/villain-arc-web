"use strict";
// net.js — colyseus connect + room/state access + input pump
// Exposes: window.room, window.mySid, NET.connect()

const NET = (() => {
  let _client, _room, _mySid = null;
  let _inputPumpId = null;

  // Called by main.js after scene is ready and input module is loaded.
  // Returns the joined room.
  async function connect(name, hero) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    _client = new Colyseus.Client(`${proto}://${location.host}`);
    _room = await _client.joinOrCreate("arena", { name, hero });
    _mySid = _room.sessionId;

    // expose for debug + other modules
    window.room  = _room;
    window.mySid = _mySid;

    // no-op handlers — we poll state in tick() rather than use callbacks,
    // mirroring the original approach for robustness across colyseus.js 0.15
    _room.onMessage("kill",      () => {});
    _room.onMessage("melee",     () => {});
    _room.onMessage("matchEnd",  () => {});

    // input pump: send latest intent 20x/s.
    // moveX/moveY are already camera-relative world-space (computed in input.js
    // from mouse yaw); the server normalizes + clamps, so floats are fine.
    _inputPumpId = setInterval(() => {
      if (!_room || !window.GANKInput) return;
      const inp = window.GANKInput;
      _room.send("input", { ix: inp.moveX, iy: inp.moveY, angle: inp.aimAngle });
    }, 50);

    return _room;
  }

  function disconnect() {
    if (_inputPumpId) { clearInterval(_inputPumpId); _inputPumpId = null; }
    if (_room) { _room.leave(); _room = null; }
    window.room = null; window.mySid = null;
  }

  return { connect, disconnect,
    get room()  { return _room; },
    get mySid() { return _mySid; },
  };
})();

window.NET = NET;

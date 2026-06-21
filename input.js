"use strict";
// input.js — TPS controls: pointer-lock mouse-look + camera-relative WASD.
// PUBG/Fortnite style: mouse rotates the view (yaw/pitch), WASD moves relative
// to where you're looking, the character faces forward, LMB fires forward.
// Reads window.room, window.mySid. Exposes:
//   window.GANKInput = { setup, keys, yaw, pitch, moveX, moveY, aimAngle }

const GANKInput = (() => {
  const keys = { up: false, down: false, left: false, right: false };
  let yaw = 0;          // look direction in world space (atan2(z,x) convention)
  let pitch = 0.35;     // camera tilt; higher = looking more from above
  let lastShot = 0, lastRoot = 0;
  const SHOOT_CD = 320, ROOT_CD = 5500; // client-side feel gate; server re-validates
  const SENS = 0.0026;                  // mouse-look sensitivity
  const PITCH_MIN = -0.15, PITCH_MAX = 0.95;
  // Flip if A/D ends up reversed on a real GPU (handedness gotcha — bit us before).
  const STRAFE_SIGN = 1;
  let locked = false;

  function setup(canvas) {
    const kd = (e, down) => {
      const k = e.code;
      if (k === "KeyW" || k === "ArrowUp")         keys.up    = down;
      else if (k === "KeyS" || k === "ArrowDown")  keys.down  = down;
      else if (k === "KeyA" || k === "ArrowLeft")  keys.left  = down;
      else if (k === "KeyD" || k === "ArrowRight") keys.right = down;
      else if (down && k === "Space") doShoot();
      else if (down && k === "KeyE")  doRoot();
      else if (down && k.startsWith("Digit")) {
        const n = +k.slice(5);
        if (n >= 1 && n <= 5 && window.room) {
          window.room.send("buy", { what: ["dmg", "hp", "mp", "pow", "cd"][n - 1] });
        }
      }
    };
    window.addEventListener("keydown", (e) => kd(e, true));
    window.addEventListener("keyup",   (e) => kd(e, false));

    // Click to capture the mouse (pointer lock); clicking while locked fires.
    canvas.addEventListener("click", () => {
      if (!locked) { if (canvas.requestPointerLock) canvas.requestPointerLock(); }
      else doShoot();
    });
    document.addEventListener("pointerlockchange", () => {
      locked = document.pointerLockElement === canvas;
    });
    canvas.addEventListener("mousemove", (e) => {
      if (!locked) return;
      yaw   += e.movementX * SENS;
      pitch += e.movementY * SENS; // drag down → look down (camera lifts up)
      if (pitch < PITCH_MIN) pitch = PITCH_MIN;
      if (pitch > PITCH_MAX) pitch = PITCH_MAX;
    });
  }

  // Camera-relative WASD → normalized world-space move vector.
  function computeMove() {
    const f = (keys.up    ? 1 : 0) - (keys.down ? 1 : 0);
    const s = ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * STRAFE_SIGN;
    // forward (world) = (cos yaw, sin yaw); right = (sin yaw, -cos yaw)
    let mx = Math.cos(yaw) * f + Math.sin(yaw) * s;
    let my = Math.sin(yaw) * f - Math.cos(yaw) * s;
    const m = Math.hypot(mx, my);
    if (m > 0) { mx /= m; my /= m; }
    return { mx, my };
  }

  function alivePlaying() {
    const r = window.room;
    if (!r || !r.state) return false;
    const me = r.state.players.get(window.mySid);
    return !!(me && me.alive && r.state.phase === "playing");
  }

  function doShoot() {
    if (!alivePlaying()) return;
    const now = performance.now();
    if (now - lastShot < SHOOT_CD) return;
    lastShot = now;
    window.room.send("shoot", { angle: yaw });
  }

  function doRoot() {
    if (!alivePlaying()) return;
    const now = performance.now();
    if (now - lastRoot < ROOT_CD) return;
    lastRoot = now;
    window.room.send("root", { angle: yaw });
  }

  return {
    setup, keys,
    get yaw()      { return yaw; },
    get pitch()    { return pitch; },
    get aimAngle() { return yaw; },
    get moveX()    { return computeMove().mx; },
    get moveY()    { return computeMove().my; },
  };
})();

window.GANKInput = GANKInput;

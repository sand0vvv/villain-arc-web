"use strict";
// camera.js — third-person (PUBG / Fortnite-style) follow camera.
// Sits behind the local player; yaw/pitch driven by mouse-look (GANKInput).
// Drives the existing TargetCamera created in scene.js — no new camera needed.
// Exposes: window.GANKCamera = { update(px, pz), reset(), DIST, HEIGHT }

const GANKCamera = (() => {
  // World units are large here (arena ~2880 wide, SPEED 250) — keep the camera
  // close enough for an over-the-shoulder feel but high enough to read the fight.
  const DIST     = 470;   // horizontal distance behind the player
  const HEIGHT   = 200;   // base camera height above the player
  const TARGET_Y = 130;   // look at roughly chest/head height
  const FOLLOW   = 0.35;  // position smoothing per frame (1 = snap)

  let curX = null, curY = null, curZ = null;

  function update(px, pz) {
    const cam = window.GANKScene && window.GANKScene.camera;
    if (!cam) return;
    const inp = window.GANKInput;
    const yaw   = inp ? inp.yaw   : 0;
    const pitch = inp ? inp.pitch : 0.35;

    // Offset the camera backwards along the look direction, lifted by pitch.
    const horiz = DIST * Math.cos(pitch);
    const vert  = HEIGHT + DIST * Math.sin(pitch);
    const tx = px - Math.cos(yaw) * horiz;
    const ty = vert;
    const tz = pz - Math.sin(yaw) * horiz;

    if (curX === null) { curX = tx; curY = ty; curZ = tz; }
    curX += (tx - curX) * FOLLOW;
    curY += (ty - curY) * FOLLOW;
    curZ += (tz - curZ) * FOLLOW;

    cam.position.set(curX, curY, curZ);
    cam.setTarget(new BABYLON.Vector3(px, TARGET_Y, pz));
  }

  function reset() { curX = curY = curZ = null; }

  return { update, reset, DIST, HEIGHT };
})();

window.GANKCamera = GANKCamera;

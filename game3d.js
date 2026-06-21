// GANK 3D arena — vertical slice (Babylon.js client on the SAME Colyseus "arena" room).
// Gameplay/netcode is reused 1:1 from the 2D build: the server simulates a 2880x2880
// top-down plane; here we just render it in 3D with a Dota/HotS-style angled camera.
// Placeholder primitives for now — real low-poly models (Quaternius/Mixamo) swap in later.
"use strict";

const ARENA = 2880;                 // world plane size (matches server ARENA_W/H)
const PLANE_TO_3D = 1;              // world units == 3D units (z = world y)
const CLASS_COLOR = [
  [0.85, 0.78, 0.55], // 0 knight - gold
  [0.55, 0.75, 0.95], // 1 ranger - blue
  [0.95, 0.55, 0.55], // 2 mage - red
  [0.6, 0.9, 0.6],    // 3 paladin - green
  [0.85, 0.6, 0.95],  // 4 warrior - purple
  [0.95, 0.75, 0.45], // 5 orc - orange
];
const CLASS_NAMES = ["Knight", "Ranger", "Mage", "Paladin", "Warrior", "Orc"];

let client, room, mySid = null;
let engine, scene, camera, ground;
let chosenHero = 0;
const keys = { up: false, down: false, left: false, right: false };
let aimAngle = 0;
let lastShot = 0, lastRoot = 0;
const SHOOT_CD = 320, ROOT_CD = 5500;

// rendered entities
const pviews = {}; // sid -> { root, body, dir, hpbar, targetX, targetZ, predX, predZ }
const cviews = {}; // id -> mesh
const projViews = {}; // id -> mesh

// ---------- title ----------
function buildTitle() {
  const wrap = document.getElementById("heroes");
  CLASS_NAMES.forEach((n, i) => {
    const d = document.createElement("div");
    d.className = "hero" + (i === 0 ? " sel" : "");
    d.textContent = n;
    d.onclick = () => { chosenHero = i; [...wrap.children].forEach((c) => c.classList.remove("sel")); d.classList.add("sel"); };
    wrap.appendChild(d);
  });
  document.getElementById("playBtn").onclick = start;
  document.getElementById("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
}

async function start() {
  const name = (document.getElementById("nameInput").value || "GANKER").slice(0, 14);
  document.getElementById("playBtn").disabled = true;
  initScene();
  await connect(name, chosenHero);
  document.getElementById("title").style.display = "none";
  document.getElementById("hud").style.display = "block";
}

// ---------- scene ----------
function initScene() {
  const canvas = document.getElementById("renderCanvas");
  engine = new BABYLON.Engine(canvas, true, { adaptToDeviceRatio: true });
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color3(0.05, 0.06, 0.09);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogColor = new BABYLON.Color3(0.05, 0.06, 0.09);
  scene.fogDensity = 0.0005;

  // angled top-down follow camera (Dota / HotS vibe)
  camera = new BABYLON.TargetCamera("cam", new BABYLON.Vector3(0, 900, 600), scene);
  camera.fov = 0.7;
  camera.minZ = 1; camera.maxZ = 6000;

  // lights
  const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.75; hemi.groundColor = new BABYLON.Color3(0.2, 0.18, 0.15);
  const dir = new BABYLON.DirectionalLight("dir", new BABYLON.Vector3(-0.6, -1, -0.4), scene);
  dir.intensity = 1.1; dir.position = new BABYLON.Vector3(1000, 2000, 1000);

  // ground plane mapped so world (x,y) -> (x, 0, y)
  ground = BABYLON.MeshBuilder.CreateGround("ground", { width: ARENA, height: ARENA, subdivisions: 8 }, scene);
  ground.position.set(ARENA / 2, 0, ARENA / 2);
  const gm = new BABYLON.StandardMaterial("gm", scene);
  gm.diffuseColor = new BABYLON.Color3(0.16, 0.14, 0.12);
  gm.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
  ground.material = gm;

  // center dais marker
  const dais = BABYLON.MeshBuilder.CreateCylinder("dais", { diameter: 520, height: 14, tessellation: 48 }, scene);
  dais.position.set(ARENA / 2, 7, ARENA / 2);
  const dm = new BABYLON.StandardMaterial("dm", scene);
  dm.diffuseColor = new BABYLON.Color3(0.32, 0.26, 0.16);
  dm.emissiveColor = new BABYLON.Color3(0.12, 0.08, 0.02);
  dais.material = dm;

  // simple grid lines on the floor for spatial readability
  for (let i = 1; i < 6; i++) {
    const ln1 = BABYLON.MeshBuilder.CreateBox("g", { width: ARENA, height: 1, depth: 4 }, scene);
    ln1.position.set(ARENA / 2, 0.5, (ARENA / 6) * i);
    const ln2 = BABYLON.MeshBuilder.CreateBox("g", { width: 4, height: 1, depth: ARENA }, scene);
    ln2.position.set((ARENA / 6) * i, 0.5, ARENA / 2);
    const lm = new BABYLON.StandardMaterial("lm", scene);
    lm.diffuseColor = new BABYLON.Color3(0.22, 0.2, 0.17); lm.specularColor = BABYLON.Color3.Black();
    ln1.material = lm; ln2.material = lm;
  }

  setupInput(canvas);
  engine.runRenderLoop(() => { tick(); scene.render(); });
  window.addEventListener("resize", () => engine.resize());
}

// material cache
const matCache = {};
function colorMat(name, rgb, emissive) {
  const key = name + rgb.join(",");
  if (matCache[key]) return matCache[key];
  const m = new BABYLON.StandardMaterial(key, scene);
  m.diffuseColor = new BABYLON.Color3(rgb[0], rgb[1], rgb[2]);
  if (emissive) m.emissiveColor = new BABYLON.Color3(rgb[0] * 0.25, rgb[1] * 0.25, rgb[2] * 0.25);
  m.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
  matCache[key] = m; return m;
}

function makePlayerView(sid, p) {
  const root = new BABYLON.TransformNode("p" + sid, scene);
  const body = BABYLON.MeshBuilder.CreateCapsule("b" + sid, { height: 110, radius: 34 }, scene);
  body.parent = root; body.position.y = 55;
  body.material = colorMat("hero", CLASS_COLOR[p.hero | 0] || [0.8, 0.8, 0.8], sid === mySid);
  // facing pointer
  const dir = BABYLON.MeshBuilder.CreateCylinder("d" + sid, { diameterTop: 0, diameterBottom: 28, height: 56, tessellation: 4 }, scene);
  dir.parent = root; dir.rotation.x = Math.PI / 2; dir.position.set(0, 55, 44);
  dir.material = colorMat("hero", CLASS_COLOR[p.hero | 0] || [0.8, 0.8, 0.8], true);
  // hp bar (billboard plane)
  const hp = BABYLON.MeshBuilder.CreatePlane("hp" + sid, { width: 90, height: 12 }, scene);
  hp.parent = root; hp.position.y = 140; hp.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  const hm = new BABYLON.StandardMaterial("hm" + sid, scene); hm.emissiveColor = new BABYLON.Color3(0.9, 0.2, 0.2); hm.disableLighting = true;
  hp.material = hm;
  const v = { root, body, dir, hp, hm, targetX: p.x, targetZ: p.y, predX: p.x, predZ: p.y };
  root.position.set(p.x, 0, p.y);
  pviews[sid] = v; return v;
}

// ---------- connect / state ----------
async function connect(name, hero) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  client = new Colyseus.Client(`${proto}://${location.host}`);
  room = await client.joinOrCreate("arena", { name, hero });
  mySid = room.sessionId;
  window.room = room; window.mySid = mySid; // debug hooks

  // NOTE: poll-based sync (create on first sight in tick(), GC missing ids) — robust across
  // colyseus.js 0.15 callback-API changes; mirrors the 2D client's forEach approach.
  room.onMessage("kill", () => {});
  room.onMessage("melee", () => {});
  room.onMessage("matchEnd", () => {});

  // input pump (server reads latest intent)
  setInterval(() => {
    if (!room) return;
    const ix = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const iy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    room.send("input", { ix, iy, angle: aimAngle });
  }, 50);
}

// ---------- input ----------
function setupInput(canvas) {
  const kd = (e, d) => {
    const k = e.code;
    if (k === "KeyW" || k === "ArrowUp") keys.up = d;
    else if (k === "KeyS" || k === "ArrowDown") keys.down = d;
    else if (k === "KeyA" || k === "ArrowLeft") keys.left = d;
    else if (k === "KeyD" || k === "ArrowRight") keys.right = d;
    else if (d && k === "Space") doShoot();
    else if (d && (k === "KeyE")) doRoot();
    else if (d && k.startsWith("Digit")) { const n = +k.slice(5); if (n >= 1 && n <= 5) room && room.send("buy", { what: ["dmg", "hp", "mp", "pow", "cd"][n - 1] }); }
  };
  window.addEventListener("keydown", (e) => kd(e, true));
  window.addEventListener("keyup", (e) => kd(e, false));
  canvas.addEventListener("pointermove", updateAim);
  canvas.addEventListener("pointerdown", (e) => { updateAim(e); if (e.button === 0) doShoot(); });
}

function updateAim(e) {
  const me = pviews[mySid]; if (!me || !scene) return;
  const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === ground);
  if (!pick || !pick.hit) return;
  const wp = pick.pickedPoint; // x, 0, z   (z == world y)
  aimAngle = Math.atan2(wp.z - me.predZ, wp.x - me.predX);
}

function doShoot() {
  const me = room && room.state.players.get(mySid);
  if (!me || !me.alive || room.state.phase !== "playing") return;
  const now = performance.now(); if (now - lastShot < SHOOT_CD) return; lastShot = now;
  room.send("shoot", { angle: aimAngle });
}
function doRoot() {
  const me = room && room.state.players.get(mySid);
  if (!me || !me.alive || room.state.phase !== "playing") return;
  const now = performance.now(); if (now - lastRoot < ROOT_CD) return; lastRoot = now;
  room.send("root", { angle: aimAngle });
}

// ---------- per-frame ----------
const SPEED = 250; // matches server SPEED
function tick() {
  if (!room || !room.state) return;
  const dt = engine.getDeltaTime() / 1000;
  const lerp = 1 - Math.pow(0.0001, dt);

  // players
  room.state.players.forEach((p, sid) => {
    let v = pviews[sid]; if (!v) v = makePlayerView(sid, p);
    if (sid === mySid && p.alive && !p.rooted && room.state.phase === "playing") {
      // client prediction for local hero
      const ix = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      const iy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
      if (ix || iy) {
        const len = Math.hypot(ix, iy) || 1;
        v.predX += (ix / len) * SPEED * dt;
        v.predZ += (iy / len) * SPEED * dt;
      }
      // gently reconcile toward server truth
      v.predX += (p.x - v.predX) * Math.min(1, lerp * 0.5);
      v.predZ += (p.y - v.predZ) * Math.min(1, lerp * 0.5);
      v.predX = Math.max(40, Math.min(ARENA - 40, v.predX));
      v.predZ = Math.max(40, Math.min(ARENA - 40, v.predZ));
    } else {
      v.predX += (p.x - v.predX) * lerp;
      v.predZ += (p.y - v.predZ) * lerp;
    }
    v.root.position.set(v.predX, 0, v.predZ);
    v.root.rotation.y = -((sid === mySid ? aimAngle : p.angle)) + Math.PI / 2;
    v.body.visibility = p.alive ? 1 : 0.15;
    v.dir.visibility = p.alive ? 1 : 0;
    // hp bar scale
    const frac = Math.max(0, Math.min(1, p.hp / (p.maxhp || 100)));
    v.hp.scaling.x = frac; v.hp.visibility = p.alive ? 1 : 0;
    v.hm.emissiveColor = new BABYLON.Color3(0.9 - 0.6 * frac, 0.2 + 0.5 * frac, 0.2);
  });

  // creeps
  room.state.creeps.forEach((c, id) => {
    let m = cviews[id];
    if (!m) {
      m = BABYLON.MeshBuilder.CreateCapsule("c" + id, { height: 60, radius: 22 }, scene);
      m.material = colorMat("creep", [0.7, 0.55, 0.85]);
      m._tx = c.x; m._tz = c.y; cviews[id] = m;
    }
    m._tx += (c.x - m._tx) * lerp; m._tz += (c.y - m._tz) * lerp;
    m.position.set(m._tx, 30, m._tz);
    m.visibility = c.alive ? 1 : 0;
  });

  // projectiles
  room.state.projectiles.forEach((pr, id) => {
    let m = projViews[id];
    if (!m) {
      m = BABYLON.MeshBuilder.CreateSphere("pr" + id, { diameter: 26 }, scene);
      const ow = room.state.players.get(pr.owner);
      const col = ow ? (CLASS_COLOR[ow.hero | 0] || [1, 1, 1]) : [1, 0.9, 0.5];
      m.material = colorMat("proj", pr.kind === "root" ? [0.4, 0.95, 0.5] : col, true);
      projViews[id] = m;
    }
    m.position.set(pr.x, 50, pr.y);
  });

  // GC views whose ids vanished from state
  for (const sid in pviews) { if (!room.state.players.get(sid)) { const v = pviews[sid]; v.root.dispose(); v.body.dispose(); v.dir.dispose(); v.hp.dispose(); delete pviews[sid]; } }
  for (const id in cviews) { if (!room.state.creeps.get(id)) { cviews[id].dispose(); delete cviews[id]; } }
  for (const id in projViews) { if (!room.state.projectiles.get(id)) { projViews[id].dispose(); delete projViews[id]; } }

  updateCamera(dt);
  updateHUD();
}

function updateCamera(dt) {
  const me = pviews[mySid]; if (!me) return;
  // angled top-down: above and "behind" (+z), looking down at the hero
  const desired = new BABYLON.Vector3(me.predX, 1000, me.predZ + 680);
  camera.position = BABYLON.Vector3.Lerp(camera.position, desired, Math.min(1, dt * 4));
  camera.setTarget(new BABYLON.Vector3(me.predX, 0, me.predZ));
}

function fmtTime(s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
function updateHUD() {
  const st = room.state;
  document.getElementById("timer").textContent = fmtTime(st.timeLeft);
  const me = st.players.get(mySid);
  document.getElementById("hpv").textContent = me ? Math.max(0, me.hp | 0) : 0;
  document.getElementById("mpv").textContent = me ? (me.mp | 0) : 0;
  document.getElementById("goldv").textContent = (me ? (me.gold | 0) : 0) + "g";
  document.getElementById("respawn").style.display = me && !me.alive && st.phase === "playing" ? "block" : "none";
  // leaderboard
  const arr = [];
  st.players.forEach((p, sid) => arr.push({ name: p.name || "?", kills: p.kills | 0, sid }));
  arr.sort((a, b) => b.kills - a.kills);
  document.getElementById("board").innerHTML = arr.slice(0, 6).map((r) =>
    `<div class="row ${r.sid === mySid ? "me" : ""}"><span>${r.name}</span><span>${r.kills}</span></div>`).join("");
}

buildTitle();

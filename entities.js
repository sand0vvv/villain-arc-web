"use strict";
// entities.js — player, creep, and projectile rendering with GLB model-loading + fallback.
//
// MODEL LOADING SYSTEM:
//   MODEL_CONFIG maps hero class index (0-5) and creep kind (0-2) to an optional GLB.
//   If the file loads OK -> clone per entity, drive AnimationGroups.
//   If the file is missing or errors -> silently fall back to capsule/sphere primitives.
//
//   BBOX NORMALIZATION: after ImportMeshAsync, the loader computes the mesh hierarchy's
//   natural bounding box and sets computedScale so the model's height (or, for keep,
//   its widest horizontal extent) matches targetHeight in world units.
//   computedYOffset = -bboxMinY * computedScale so the model sits on y=0.
//   Quaternius GLBs face +Z; hero/creep instances rotate around Y if needed.
//
//   TOLERANT ANIMATION MATCHER: given a config token, resolveAnim picks the
//   AnimationGroup whose name === token, else endsWith("|"+token), else
//   case-insensitively includes the token, else returns the first group.
//   This makes config robust to armature prefixes like "CharacterArmature|Idle".
//
// Exposes: window.GANKEntities = { pviews, cviews, projViews, tick }

// ============================================================
// MODEL CONFIG TABLE — targetHeight in world units (2880-unit arena)
// ============================================================
// anims: config tokens; tolerant matcher resolves prefixed names at runtime.
const MODEL_CONFIG = {
  // Villain Arc playables — Artem's Tripo low-poly villains.
  // Clip NAMES collide across both files ("NlaTrack.00x") but the INDEX ORDER
  // differs per file, so animations are selected by INDEX (animIdx), not name.
  // Determined via rotation-energy analysis (cross-validated across both files):
  //   villain_a: 0 idle, 1 death, 2 run, 3 walk, 4 attack
  //   villain_b: 0 death, 1 attack, 2 idle, 3 run, 4 walk
  // (anims tokens kept only as a fallback if animIdx ever misses.)
  heroes: [
    // 0 — villain_a (Tripo)
    { file: "models/villains/villain_a.glb", targetHeight: 130,
      anims: { idle: "idle", run: "run", walk: "walk", attack: "attack", death: "death" },
      animIdx: { idle: 0, death: 1, run: 2, walk: 3, attack: 4 } },
    // 1 — villain_b (Tripo)
    { file: "models/villains/villain_b.glb", targetHeight: 130,
      anims: { idle: "idle", run: "run", walk: "walk", attack: "attack", death: "death" },
      animIdx: { death: 0, attack: 1, idle: 2, run: 3, walk: 4 } },
    // 2-5 — reuse the two villains so every server class index still renders a model
    { file: "models/villains/villain_a.glb", targetHeight: 130,
      anims: { idle: "idle", run: "run", walk: "walk", attack: "attack", death: "death" },
      animIdx: { idle: 0, death: 1, run: 2, walk: 3, attack: 4 } },
    { file: "models/villains/villain_b.glb", targetHeight: 130,
      anims: { idle: "idle", run: "run", walk: "walk", attack: "attack", death: "death" },
      animIdx: { death: 0, attack: 1, idle: 2, run: 3, walk: 4 } },
    { file: "models/villains/villain_a.glb", targetHeight: 130,
      anims: { idle: "idle", run: "run", walk: "walk", attack: "attack", death: "death" },
      animIdx: { idle: 0, death: 1, run: 2, walk: 3, attack: 4 } },
    { file: "models/villains/villain_b.glb", targetHeight: 130,
      anims: { idle: "idle", run: "run", walk: "walk", attack: "attack", death: "death" },
      animIdx: { death: 0, attack: 1, idle: 2, run: 3, walk: 4 } },
  ],
  // Creep kinds (index 0-2 matching server CREEP_KINDS: 0=slime, 1=bat, 2=ghost)
  creeps: [
    // 0 Slime — MonsterArmature|* prefix
    { file: "models/creeps/slime.glb",   targetHeight: 75,
      anims: { idle: "Idle", run: "Walk", attack: "Bite_Front",   death: "Death" } },
    // 1 Bat — BatArmature|* prefix
    { file: "models/creeps/bat.glb",     targetHeight: 75,
      anims: { idle: "Bat_Flying", run: "Bat_Flying", attack: "Bat_Attack", death: "Bat_Death" } },
    // 2 Ghost — no standard armature prefix
    { file: "models/creeps/ghost.glb",   targetHeight: 75,
      anims: { idle: "Flying_Idle", run: "Fast_Flying", attack: "Headbutt", death: "Death" } },
  ],
};

const CLASS_COLOR = [
  [0.85, 0.78, 0.55], // 0 knight  - gold
  [0.55, 0.75, 0.95], // 1 ranger  - blue
  [0.95, 0.55, 0.55], // 2 mage    - red
  [0.6,  0.9,  0.6 ], // 3 paladin - green
  [0.85, 0.6,  0.95], // 4 warrior - purple
  [0.95, 0.75, 0.45], // 5 orc     - orange
];
const CREEP_COLOR = [
  [0.4, 0.9, 0.4],   // 0 slime  - green
  [0.5, 0.6, 0.9],   // 1 bat    - blue
  [0.8, 0.5, 0.9],   // 2 ghost  - purple
];

const ARENA = 2880;
const SPEED = 250; // mirrors server SPEED for local prediction

// ---- template cache: key -> Promise | { meshes, animGroups, computedScale, computedYOffset } | null ----
const _templateCache = {};

// ---- material cache ----
const _matCache = {};
function colorMat(name, rgb, emissive) {
  const key = name + rgb.join(",") + (emissive ? "e" : "");
  if (_matCache[key]) return _matCache[key];
  const scene = window.GANKScene.scene;
  const m = new BABYLON.StandardMaterial(key, scene);
  m.diffuseColor  = new BABYLON.Color3(rgb[0], rgb[1], rgb[2]);
  m.specularColor = new BABYLON.Color3(0.08, 0.08, 0.08);
  if (emissive) m.emissiveColor = new BABYLON.Color3(rgb[0] * 0.3, rgb[1] * 0.3, rgb[2] * 0.3);
  _matCache[key] = m;
  return m;
}

// ---- primitive fallbacks ----
function makePrimitivePlayer(sid, p) {
  const scene = window.GANKScene.scene;
  const root = new BABYLON.TransformNode("p" + sid, scene);
  const rgb = CLASS_COLOR[p.hero | 0] || [0.8, 0.8, 0.8];
  const isSelf = sid === window.mySid;
  const body = BABYLON.MeshBuilder.CreateCapsule("pb" + sid,
    { height: 110, radius: 34 }, scene);
  body.parent = root; body.position.y = 55;
  body.material = colorMat("hero" + sid, rgb, isSelf);

  // facing arrow
  const dir = BABYLON.MeshBuilder.CreateCylinder("pd" + sid,
    { diameterTop: 0, diameterBottom: 28, height: 56, tessellation: 4 }, scene);
  dir.parent = root; dir.rotation.x = Math.PI / 2;
  dir.position.set(0, 55, 44);
  dir.material = colorMat("heroD" + sid, rgb, true);

  return { root, body, dir, glb: false };
}

function makePrimitiveCreep(id, c) {
  const scene = window.GANKScene.scene;
  const rgb = CREEP_COLOR[c.kind | 0] || [0.7, 0.55, 0.85];
  const m = BABYLON.MeshBuilder.CreateCapsule("cb" + id,
    { height: 60, radius: 22 }, scene);
  m.material = colorMat("creep" + (c.kind | 0), rgb, false);
  m._tx = c.x; m._tz = c.y;
  return m;
}

function makePrimitiveBolt(id, pr) {
  const scene = window.GANKScene.scene;
  const m = BABYLON.MeshBuilder.CreateSphere("pr" + id, { diameter: 26 }, scene);
  const room = window.room;
  const ow = room ? room.state.players.get(pr.owner) : null;
  const col = ow ? (CLASS_COLOR[ow.hero | 0] || [1, 1, 1]) : [1, 0.9, 0.5];
  m.material = colorMat("proj" + pr.kind,
    pr.kind === "root" ? [0.4, 0.95, 0.5] : col, true);
  return m;
}

// ---- HP bar (shared billboard plane, always primitive) ----
function makeHPBar(sid) {
  const scene = window.GANKScene.scene;
  const hp = BABYLON.MeshBuilder.CreatePlane("hp" + sid, { width: 90, height: 12 }, scene);
  hp.position.y = 155;
  hp.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  const hm = new BABYLON.StandardMaterial("hm" + sid, scene);
  hm.emissiveColor  = new BABYLON.Color3(0.9, 0.2, 0.2);
  hm.disableLighting = true;
  hp.material = hm;
  return { hp, hm };
}

// ---- bbox normalization: compute natural height of a set of meshes ----
// Returns { minY, maxY, minX, maxX, minZ, maxZ } in local/world coords at scale=1.
// Works on invisible meshes since bounding info is geometry-based.
function computeBBoxExtents(meshes) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  meshes.forEach((m) => {
    if (!m.getBoundingInfo) return;
    try {
      // Force the world matrix so minimumWorld/maximumWorld include parent (__root__)
      // scale. Without this, models with a large native root scale (Quaternius creeps)
      // report their LOCAL height → naturalHeight too small → scale double-counted → GIANT.
      m.computeWorldMatrix(true);
      m.refreshBoundingInfo();
      const bi = m.getBoundingInfo();
      const bMin = bi.boundingBox.minimumWorld;
      const bMax = bi.boundingBox.maximumWorld;
      if (bMin.x < minX) minX = bMin.x;
      if (bMax.x > maxX) maxX = bMax.x;
      if (bMin.y < minY) minY = bMin.y;
      if (bMax.y > maxY) maxY = bMax.y;
      if (bMin.z < minZ) minZ = bMin.z;
      if (bMax.z > maxZ) maxZ = bMax.z;
    } catch (_) {}
  });
  // guard against degenerate results (e.g. no-geometry nodes)
  if (!isFinite(minY) || !isFinite(maxY)) { minY = 0; maxY = 1; }
  if (!isFinite(minX) || !isFinite(maxX)) { minX = 0; maxX = 1; }
  if (!isFinite(minZ) || !isFinite(maxZ)) { minZ = 0; maxZ = 1; }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

// ---- tolerant animation resolver ----
// Given a config token (e.g. "Idle", "Bat_Flying"), finds the best matching
// AnimationGroup even when names are prefixed like "CharacterArmature|Idle".
function resolveAnim(animGroups, token) {
  if (!token || !animGroups || !animGroups.length) return null;
  // 1. exact match
  let ag = animGroups.find((a) => a.name === token);
  if (ag) return ag;
  // 2. endsWith "|token"
  ag = animGroups.find((a) => a.name.endsWith("|" + token));
  if (ag) return ag;
  // 3. case-insensitive includes
  const lower = token.toLowerCase();
  ag = animGroups.find((a) => a.name.toLowerCase().includes(lower));
  if (ag) return ag;
  // 4. fall back to first group
  return animGroups[0] || null;
}

// ---- async GLB loader with cache ----
// Probe via HEAD before handing to Babylon so a 404 never reaches the loader.
// Computes bbox-based scale so model height matches cfg.targetHeight in world units.
// Returns a promise resolving to tmpl object or null.
async function loadTemplate(cfg) {
  const key = cfg.file;
  if (key in _templateCache) {
    return _templateCache[key]; // may be in-flight Promise, tmpl, or null
  }

  let resolve;
  const inflight = new Promise((r) => { resolve = r; });
  _templateCache[key] = inflight;

  try {
    // HEAD-check: avoids Babylon loader seeing a 404
    const probe = await fetch(key, { method: "HEAD" }).catch(() => null);
    if (!probe || !probe.ok) {
      _templateCache[key] = null;
      resolve(null);
      return null;
    }

    const scene = window.GANKScene.scene;
    // Load as an AssetContainer (kept OUT of the scene as a template). Per-entity we
    // call container.instantiateModelsToScene(), which clones meshes+skeleton AND
    // retargets animation groups to each clone — the correct way to animate many
    // instances of one skinned model. (The old ImportMeshAsync path read the wrong
    // property and never retargeted clones, so instances had zero animations.)
    const container = await BABYLON.SceneLoader.LoadAssetContainerAsync("", key, scene);
    if (!container || !container.meshes || !container.meshes.length) throw new Error("empty result");

    // compute natural height/extents (container meshes carry geometry + transforms)
    const ext = computeBBoxExtents(container.meshes);
    const naturalHeight = ext.maxY - ext.minY;

    // choose target dimension: if cfg says to scale by width, use horizontal max extent
    let computedScale;
    if (cfg.scaleByWidth) {
      const naturalWidth = Math.max(ext.maxX - ext.minX, ext.maxZ - ext.minZ);
      computedScale = naturalWidth > 0.001 ? cfg.targetHeight / naturalWidth : 1;
    } else {
      computedScale = naturalHeight > 0.001 ? cfg.targetHeight / naturalHeight : 1;
    }
    // sit model on ground: shift up by -minY * scale
    const computedYOffset = -ext.minY * computedScale;

    const tmpl = { container, cfg, computedScale, computedYOffset };
    _templateCache[key] = tmpl;
    resolve(tmpl);
    return tmpl;
  } catch (_e) {
    // any loader error -> primitive fallback, never retry
    _templateCache[key] = null;
    resolve(null);
    return null;
  }
}

// ---- instance a loaded GLB template for one entity ----
// Clones the GLB's root node (preserving the full internal hierarchy so helmet/weapon
// sub-meshes stay correctly positioned), re-targets animation groups.
// Uses computedScale/computedYOffset from bbox normalization.
function instanceTemplate(tmpl, name) {
  if (!tmpl || !tmpl.container) return null;
  const scene = window.GANKScene.scene;

  // Clone the whole model (meshes + skeleton) into the scene; animationGroups come
  // back already retargeted to THIS clone.
  const entries = tmpl.container.instantiateModelsToScene(
    (n) => name + "_" + n, false, { doNotInstantiate: false });
  if (!entries || !entries.rootNodes || !entries.rootNodes.length) return null;

  // Wrap in a single transform so we can apply scale + yOffset cleanly
  const root = new BABYLON.TransformNode(name, scene);
  root.scaling.setAll(tmpl.computedScale);
  root.position.y = tmpl.computedYOffset; // ground offset in local space

  entries.rootNodes.forEach((rn) => {
    rn.parent = root;
    rn.setEnabled(true);
    if (rn.getChildMeshes) rn.getChildMeshes(false).forEach((cm) => { cm.isVisible = true; });
    if (rn.isVisible !== undefined) rn.isVisible = true;
  });

  return { root, animGroups: entries.animationGroups || [] };
}

// ---- animation helpers ----
// Drives an animation group by config token using the tolerant resolver.
function playAnim(animGroups, cfgAnims, animName, loop, cfgAnimIdx) {
  if (!animGroups || !animGroups.length) return;
  let target = null;
  // Prefer explicit index mapping (used by villains whose clip names collide).
  if (cfgAnimIdx && Number.isInteger(cfgAnimIdx[animName])) {
    target = animGroups[cfgAnimIdx[animName]] || null;
  }
  if (!target) {
    const token = cfgAnims ? cfgAnims[animName] : null;
    if (token) target = resolveAnim(animGroups, token);
  }
  if (!target) return;
  animGroups.forEach((ag) => {
    if (ag === target) {
      if (!ag.isPlaying) { ag.start(loop, 1.0); }
    } else {
      if (ag.isPlaying) ag.stop();
    }
  });
}

// ---- entity view objects ----
// pviews: sid -> { root, hp, hm, targetX, targetZ, predX, predZ,
//                  glb, animGroups, cfgAnims, wasMoving }
// cviews: id -> mesh (primitive) or { root, animGroups, cfgAnims, _tx, _tz, glb:true }
// projViews: id -> mesh

const pviews    = {};
const cviews    = {};
const projViews = {};

// Create a player view. GLB load is async; start with primitive, replace on arrival.
async function spawnPlayer(sid, p) {
  const prim  = makePrimitivePlayer(sid, p);
  const { hp, hm } = makeHPBar(sid);
  hp.parent = prim.root;
  const v = {
    root: prim.root, body: prim.body, dir: prim.dir,
    hp, hm,
    targetX: p.x, targetZ: p.y,
    predX: p.x,   predZ: p.y,
    glb: false, animGroups: null, cfgAnims: null, cfgAnimIdx: null, wasMoving: false,
  };
  pviews[sid] = v;

  const cfg = MODEL_CONFIG.heroes[p.hero | 0];
  if (cfg && cfg.file) {
    const tmpl = await loadTemplate(cfg);
    if (tmpl && pviews[sid] === v) { // entity still alive
      const inst = instanceTemplate(tmpl, "player_" + sid);
      if (inst) {
        prim.body.isVisible = false;
        if (prim.dir) prim.dir.isVisible = false;
        // inst.root is self-contained (scale + yOffset already applied inside instanceTemplate).
        // Parent it to v.root; v.root controls world XZ position and Y-rotation only.
        inst.root.parent = v.root;
        v.glb = true;
        v.animGroups = inst.animGroups;
        v.cfgAnims   = cfg.anims;
        v.cfgAnimIdx = cfg.animIdx || null;
      }
    }
  }
}

async function spawnCreep(id, c) {
  const prim = makePrimitiveCreep(id, c);
  cviews[id] = prim;

  // Creeps stay as primitives for now: the skinned creep GLBs render as a full-screen
  // green blanket (occlusion/skinning glitch). Heroes keep their GLB models. Restore
  // creep models once a fix (or real models) is verified on a real GPU.
  return;

  // eslint-disable-next-line no-unreachable
  const cfg = MODEL_CONFIG.creeps[c.kind | 0];
  if (cfg && cfg.file) {
    const tmpl = await loadTemplate(cfg);
    if (tmpl && cviews[id] === prim) {
      const inst = instanceTemplate(tmpl, "creep_" + id);
      if (inst) {
        prim.isVisible = false;
        // bat/ghost hover above ground; yOffset already baked into inst.root.position.y
        const hover = (c.kind === 1 || c.kind === 2) ? 30 : 0;
        const cv = {
          root: inst.root, animGroups: inst.animGroups,
          cfgAnims: cfg.anims, _tx: c.x, _tz: c.y, glb: true, hover,
          yOffset: 0, // baked into inst.root already; root is positioned directly
        };
        cviews[id] = cv;
        playAnim(cv.animGroups, cv.cfgAnims, "idle", true);
      }
    }
  }
}

// ---- storm zone ring (battle-royale shrinking safe circle) ----
let _zoneRing = null;
function ensureZoneRing() {
  if (_zoneRing) return _zoneRing;
  const scene = window.GANKScene.scene;
  const ring = BABYLON.MeshBuilder.CreateTorus("zoneRing",
    { diameter: 2, thickness: 0.05, tessellation: 90 }, scene);
  const m = new BABYLON.StandardMaterial("zoneMat", scene);
  m.emissiveColor   = new BABYLON.Color3(1.0, 0.16, 0.42); // hot magenta danger wall
  m.diffuseColor    = new BABYLON.Color3(0.15, 0.02, 0.08);
  m.disableLighting = true;
  m.alpha           = 0.5;
  ring.material   = m;
  ring.isPickable = false;
  _zoneRing = ring;
  return ring;
}
function updateZoneRing(room) {
  const st = room.state;
  if (!st || !st.zoneR || st.phase !== "playing") {
    if (_zoneRing) _zoneRing.setEnabled(false);
    return;
  }
  const ring = ensureZoneRing();
  ring.setEnabled(true);
  const zr = st.zoneR;
  ring.scaling.set(zr, Math.max(45, zr * 0.05), zr);
  ring.position.set(st.zoneX || 1440, 22, st.zoneY || 1440);
}

// ---- per-frame update ----
function tick(dtMs) {
  const room = window.room;
  if (!room || !room.state) return;

  const dt   = dtMs / 1000;
  const lerp = 1 - Math.pow(0.0001, Math.min(dtMs, 50) / 1000);

  const aimAngle = window.GANKInput ? window.GANKInput.aimAngle : 0;
  const keys     = window.GANKInput ? window.GANKInput.keys     : {};
  const mySid    = window.mySid;

  // ---- players ----
  const seenP = {};
  room.state.players.forEach((p, sid) => {
    seenP[sid] = true;
    if (!pviews[sid]) { spawnPlayer(sid, p); return; }
    const v = pviews[sid];

    if (sid === mySid && p.alive && !p.rooted && room.state.phase === "playing") {
      // client-side prediction for local hero — use the SAME camera-relative world
      // move vector we send to the server (already normalized), not raw keys.
      const ix = window.GANKInput ? window.GANKInput.moveX : 0;
      const iy = window.GANKInput ? window.GANKInput.moveY : 0;
      if (ix || iy) {
        v.predX += ix * SPEED * dt;
        v.predZ += iy * SPEED * dt;
      }
      v.predX += (p.x - v.predX) * Math.min(1, lerp * 0.5);
      v.predZ += (p.y - v.predZ) * Math.min(1, lerp * 0.5);
      v.predX = Math.max(40, Math.min(ARENA - 40, v.predX));
      v.predZ = Math.max(40, Math.min(ARENA - 40, v.predZ));
    } else {
      v.predX += (p.x - v.predX) * lerp;
      v.predZ += (p.y - v.predZ) * lerp;
    }

    v.root.position.set(v.predX, 0, v.predZ);
    // GLB yOffset sits on the child inst.root (local y), so view root stays at world y=0
    v.root.rotation.y = -((sid === mySid ? aimAngle : p.angle)) + Math.PI / 2;

    const frac = Math.max(0, Math.min(1, p.hp / (p.maxhp || 100)));
    v.hp.scaling.x  = frac;
    v.hp.visibility = p.alive ? 1 : 0;
    // reuse Color3 to avoid per-frame allocation
    v.hm.emissiveColor.r = 0.9 - 0.6 * frac;
    v.hm.emissiveColor.g = 0.2 + 0.5 * frac;
    v.hm.emissiveColor.b = 0.2;

    if (v.glb && v.animGroups) {
      const moving = !!(keys.up || keys.down || keys.left || keys.right) && (sid === mySid);
      const anim   = p.alive ? (moving ? "run" : "idle") : "death";
      playAnim(v.animGroups, v.cfgAnims, anim, anim !== "death", v.cfgAnimIdx);
      v.wasMoving = moving;
    } else if (v.body) {
      v.body.visibility = p.alive ? 1 : 0.15;
      if (v.dir) v.dir.visibility = p.alive ? 1 : 0;
    }
  });

  // ---- creeps ----
  const seenC = {};
  room.state.creeps.forEach((c, id) => {
    seenC[id] = true;
    if (!cviews[id]) { spawnCreep(id, c); return; }
    const cv = cviews[id];
    if (cv.glb) {
      cv._tx += (c.x - cv._tx) * lerp;
      cv._tz += (c.y - cv._tz) * lerp;
      cv.root.position.set(cv._tx, cv.yOffset + (cv.hover || 0), cv._tz);
      cv.root.setEnabled(c.alive);
      // drive animations: moving vs idle
      if (cv.animGroups && cv.cfgAnims) {
        const dx = c.x - cv._tx, dz = c.y - cv._tz;
        const moving = (Math.abs(dx) + Math.abs(dz)) > 2;
        playAnim(cv.animGroups, cv.cfgAnims, moving ? "run" : "idle", true);
      }
    } else {
      cv._tx += (c.x - cv._tx) * lerp;
      cv._tz += (c.y - cv._tz) * lerp;
      cv.position.set(cv._tx, 30, cv._tz);
      cv.visibility = c.alive ? 1 : 0;
    }
  });

  // ---- projectiles ----
  const seenPr = {};
  room.state.projectiles.forEach((pr, id) => {
    seenPr[id] = true;
    if (!projViews[id]) projViews[id] = makePrimitiveBolt(id, pr);
    // projectiles move fast — lerp harder so they don't lag
    const m = projViews[id];
    m.position.x += (pr.x - m.position.x) * Math.min(1, lerp * 1.8);
    m.position.z += (pr.y - m.position.z) * Math.min(1, lerp * 1.8);
    m.position.y  = 50;
  });

  // ---- storm zone ring ----
  updateZoneRing(room);

  // ---- GC views whose ids vanished from state ----
  for (const sid in pviews) {
    if (seenP[sid]) continue;
    const v = pviews[sid];
    v.root.dispose(false, true);
    delete pviews[sid];
  }
  for (const id in cviews) {
    if (seenC[id]) continue;
    const cv = cviews[id];
    if (cv.glb) cv.root.dispose(false, true);
    else cv.dispose();
    delete cviews[id];
  }
  for (const id in projViews) {
    if (seenPr[id]) continue;
    projViews[id].dispose();
    delete projViews[id];
  }
}

window.GANKEntities = {
  pviews, cviews, projViews, tick,
  // exposed for preloading in main.js — fire before first spawn to avoid hitch
  _loadTemplate: loadTemplate,
  _MODEL_CONFIG_HEROES: MODEL_CONFIG.heroes,
  _MODEL_CONFIG_CREEPS: MODEL_CONFIG.creeps,
};

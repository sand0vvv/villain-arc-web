"use strict";
// hub3d.js — 3D island hub scene.
// Flow: title → HUB3D.boot() → player walks into portal → HUB3D._enterArena() → arena.
//
// Rules:
//   • Owns its own Babylon Scene (separate from arena scene).
//   • Uses the same Engine/canvas as the arena (engine is created here, reused by arena).
//   • Never touches GANKScene / GANKInput / GANKEntities — those are arena-only.
//   • Fish counter appears ONLY after the first successful catch.
//   • Portal transition: dispose hub scene, call GANKScene.initScene + GANKInput.setup + NET.connect.
//   • All async GLB loads HEAD-probe first, fall back to primitives on any failure.

const HUB3D = (() => {

  // ---- tuning ----
  const ISLAND_R     = 1600;   // island radius (grass disc)
  const BEACH_R      = 1750;   // beach disc just outside grass
  const OCEAN_HALF   = 8000;   // ocean plane half-size
  const PLAYER_SPEED = 400;    // world units / second
  const CAM_HEIGHT   = 900;
  const CAM_DIST     = 700;
  const PORTAL_X     = 0;
  const PORTAL_Z     = -820;   // near south shore
  const PORTAL_ENTER_R = 180;  // trigger radius
  const FISH_ZONE_R  = 1300;   // water starts here; fish swim beyond this
  const FISH_ENTER_R = 220;    // how close to water edge to fish
  const DOCK_X       = 800;
  const DOCK_Z       = 1200;

  let _engine, _scene;
  let _playerRoot, _heroMesh; // player visual
  let _playerX = 0, _playerZ = 0;
  let _keys     = { up: false, down: false, left: false, right: false };
  let _portal, _portalGlow;
  let _portalT  = 0;          // for animation
  let _entered  = false;       // one-shot portal trigger
  let _onArena  = null;        // callback set by boot()

  // fishing state machine
  let _fishState = "idle"; // idle | casting | biting | catching
  let _fishTimer = 0;
  let _fishCount = 0;
  let _fishFirstCatch = false; // only show counter after first catch
  let _fishBobber = null;
  let _fKey = false, _fKeyPrev = false;

  // fish meshes
  const _fishViews = [];
  const FISH_COUNT = 12;

  // ---- material helpers (local, hub-scene only) ----
  function pbr(name, r, g, b, metallic, roughness) {
    const m = new BABYLON.PBRMaterial(name + "_h", _scene);
    m.albedoColor = new BABYLON.Color3(r, g, b);
    m.metallic    = metallic !== undefined ? metallic : 0.0;
    m.roughness   = roughness !== undefined ? roughness : 0.85;
    return m;
  }
  function std(name, r, g, b, er, eg, eb) {
    const m = new BABYLON.StandardMaterial(name + "_h", _scene);
    m.diffuseColor  = new BABYLON.Color3(r, g, b);
    m.emissiveColor = new BABYLON.Color3(er || 0, eg || 0, eb || 0);
    m.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04);
    return m;
  }

  // ---- seeded PRNG ----
  function rng(seed) {
    let s = (seed | 0) + 1;
    return () => {
      s ^= s << 13; s &= 0x7fffffff;
      s ^= s >> 17; s &= 0x7fffffff;
      s ^= s << 5;  s &= 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  // ---- HEAD-probe GLB loader for hub scene ----
  async function loadGLB(file, targetH) {
    try {
      const probe = await fetch(file, { method: "HEAD" }).catch(() => null);
      if (!probe || !probe.ok) return null;
      const result = await BABYLON.SceneLoader.ImportMeshAsync("", "", file, _scene);
      if (!result || !result.meshes || !result.meshes.length) return null;

      // bbox normalise
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      result.meshes.forEach((m) => {
        try {
          m.refreshBoundingInfo();
          const bi = m.getBoundingInfo();
          const lo = bi.boundingBox.minimumWorld, hi = bi.boundingBox.maximumWorld;
          if (lo.y < minY) minY = lo.y; if (hi.y > maxY) maxY = hi.y;
          if (lo.x < minX) minX = lo.x; if (hi.x > maxX) maxX = hi.x;
          if (lo.z < minZ) minZ = lo.z; if (hi.z > maxZ) maxZ = hi.z;
        } catch (_) {}
      });
      if (!isFinite(minY)) minY = 0;
      if (!isFinite(maxY)) maxY = 1;
      const naturalH = maxY - minY;
      const scale = naturalH > 0.001 ? targetH / naturalH : 1;
      const yOff  = -minY * scale;
      result.meshes.forEach((m) => { m.isVisible = false; });
      if (result.animGroups) result.animGroups.forEach((ag) => ag.stop());
      return { meshes: result.meshes, animGroups: result.animGroups || [], scale, yOff };
    } catch (_e) {
      return null;
    }
  }

  // Clone a loaded template into the hub scene at (wx, wz).
  function placeClone(tmpl, name, wx, wz, rotY, scaleOverride) {
    const root = new BABYLON.TransformNode(name, _scene);
    root.position.set(wx, tmpl.yOff, wz);
    const sc = scaleOverride || tmpl.scale;
    root.scaling.setAll(sc);
    if (rotY) root.rotation.y = rotY;
    tmpl.meshes.forEach((src) => {
      if (!src.geometry && src.getChildMeshes().length === 0) return;
      const inst = src.clone(name + "_" + src.name, root);
      if (inst) inst.isVisible = true;
    });
    return root;
  }

  // ---- atmosphere ----
  function setupAtmosphere() {
    _scene.clearColor = new BABYLON.Color4(0.48, 0.68, 0.92, 1.0); // warm sky blue
    _scene.fogMode    = BABYLON.Scene.FOGMODE_EXP2;
    _scene.fogColor   = new BABYLON.Color3(0.72, 0.82, 0.95);
    _scene.fogDensity = 0.00018;
    _scene.ambientColor = new BABYLON.Color3(0.18, 0.20, 0.24);
  }

  // ---- lights ----
  function buildLights() {
    const hemi = new BABYLON.HemisphericLight("hubHemi", new BABYLON.Vector3(0, 1, 0), _scene);
    hemi.intensity   = 0.75;
    hemi.diffuse     = new BABYLON.Color3(1.0, 0.95, 0.85);
    hemi.groundColor = new BABYLON.Color3(0.22, 0.28, 0.20);
    hemi.specular    = new BABYLON.Color3(0.05, 0.05, 0.05);

    const sun = new BABYLON.DirectionalLight("hubSun", new BABYLON.Vector3(-0.4, -1, -0.3), _scene);
    sun.intensity = 1.4;
    sun.diffuse   = new BABYLON.Color3(1.0, 0.95, 0.80);
    sun.specular  = new BABYLON.Color3(0.35, 0.30, 0.20);
    sun.position  = new BABYLON.Vector3(3000, 5000, 3000);
  }

  // ---- post-processing ----
  function buildPipeline(camera) {
    try {
      const pip = new BABYLON.DefaultRenderingPipeline("hubPip", true, _scene, [camera]);
      // bloom
      pip.bloomEnabled    = true;
      pip.bloomThreshold  = 0.78;
      pip.bloomWeight     = 0.38;
      pip.bloomKernel     = 64;
      pip.bloomScale      = 0.5;
      // FXAA
      pip.fxaaEnabled     = true;
      // tone mapping / image process
      pip.imageProcessingEnabled = true;
      pip.imageProcessing.toneMappingEnabled = true;
      pip.imageProcessing.toneMappingType    = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
      pip.imageProcessing.exposure           = 1.15;
      pip.imageProcessing.contrast           = 1.10;
    } catch (_e) {
      // SwiftShader headless may not support post; silently skip
    }
  }

  // ---- camera ----
  let _camera;
  function buildCamera() {
    _camera = new BABYLON.TargetCamera("hubCam",
      new BABYLON.Vector3(0, CAM_HEIGHT, CAM_DIST), _scene);
    _camera.fov  = 0.62;
    _camera.minZ = 1;
    _camera.maxZ = 20000;
    _camera.setTarget(BABYLON.Vector3.Zero());
    return _camera;
  }

  // ---- terrain ----
  function buildTerrain() {
    // grass island (large disc = organic island shape via tessellation segments)
    const grass = BABYLON.MeshBuilder.CreateGround("hubGrass",
      { width: ISLAND_R * 2, height: ISLAND_R * 2, subdivisions: 8 }, _scene);
    grass.position.set(0, 0, 0);
    const gm = pbr("grass", 0.24, 0.52, 0.18, 0.0, 0.92);
    grass.material = gm;
    grass.receiveShadows = true;

    // beach ring — slightly larger disc, sand colour, sits just below grass
    const beach = BABYLON.MeshBuilder.CreateDisc("hubBeach",
      { radius: BEACH_R, tessellation: 48 }, _scene);
    beach.position.set(0, -1, 0);
    beach.rotation.x = Math.PI / 2;
    const bm = pbr("beach", 0.82, 0.76, 0.55, 0.0, 0.88);
    beach.material = bm;
    beach.receiveShadows = true;

    // ocean plane — animated in tick via UV offset on a StandardMaterial
    const ocean = BABYLON.MeshBuilder.CreateGround("hubOcean",
      { width: OCEAN_HALF * 2, height: OCEAN_HALF * 2, subdivisions: 2 }, _scene);
    ocean.position.set(0, -8, 0);
    const om = new BABYLON.StandardMaterial("ocean_h", _scene);
    om.diffuseColor  = new BABYLON.Color3(0.12, 0.38, 0.72);
    om.emissiveColor = new BABYLON.Color3(0.04, 0.14, 0.32);
    om.specularColor = new BABYLON.Color3(0.9, 0.9, 0.9);
    om.specularPower = 64;
    om.alpha = 0.90;
    // animated via scene beforeRender (UV offset for wave shimmer)
    let _uvT = 0;
    _scene.registerBeforeRender(() => {
      _uvT += 0.00015;
      om.diffuseTexture && (om.diffuseTexture.uOffset = _uvT);
    });
    ocean.material = om;

    // rocky shore ring: scattered rock primitives at island edge for organic feel
    const rockMat = pbr("shoreRock", 0.42, 0.39, 0.35, 0.05, 0.85);
    const r = rng(99);
    for (let i = 0; i < 28; i++) {
      const ang  = (i / 28) * Math.PI * 2 + r() * 0.3;
      const dist = ISLAND_R + 20 + r() * 180;
      const sx   = Math.cos(ang) * dist;
      const sz   = Math.sin(ang) * dist;
      const sz2  = r() * 0.4 + 0.6;
      const rock = BABYLON.MeshBuilder.CreateSphere("srock" + i,
        { diameter: 30 + r() * 70, segments: 4 }, _scene);
      rock.scaling.set(r() * 0.6 + 0.7, sz2, r() * 0.5 + 0.8);
      rock.position.set(sx, -4 + r() * 6, sz);
      rock.rotation.y = r() * Math.PI * 2;
      rock.material = rockMat;
    }
  }

  // ---- dock ----
  function buildDock() {
    const woodMat = pbr("dock", 0.42, 0.30, 0.18, 0.0, 0.90);
    // planks
    const plank = BABYLON.MeshBuilder.CreateBox("dockBase",
      { width: 160, height: 10, depth: 380 }, _scene);
    plank.position.set(DOCK_X, 2, DOCK_Z + 120);
    plank.material = woodMat;
    // posts
    [-70, 70].forEach((ox, i) => {
      [0, 140, 280].forEach((oz, j) => {
        const post = BABYLON.MeshBuilder.CreateCylinder("dpost" + i + j,
          { diameter: 18, height: 80, tessellation: 8 }, _scene);
        post.position.set(DOCK_X + ox, -30, DOCK_Z + oz);
        post.material = woodMat;
      });
    });
    // railing
    [-70, 70].forEach((ox, ri) => {
      const rail = BABYLON.MeshBuilder.CreateBox("rail" + ri,
        { width: 10, height: 12, depth: 300 }, _scene);
      rail.position.set(DOCK_X + ox, 22, DOCK_Z + 140);
      rail.material = woodMat;
    });
  }

  // ---- portal ----
  function buildPortal() {
    // outer ring
    const ring = BABYLON.MeshBuilder.CreateTorus("hubPortalRing",
      { diameter: 200, thickness: 18, tessellation: 40 }, _scene);
    ring.position.set(PORTAL_X, 120, PORTAL_Z);
    const ringMat = std("portalRing", 0.7, 0.3, 1.0, 0.4, 0.1, 0.8);
    ring.material = ringMat;
    _portal = ring;

    // inner glowing disc
    const disc = BABYLON.MeshBuilder.CreateDisc("hubPortalDisc",
      { radius: 90, tessellation: 40 }, _scene);
    disc.position.set(PORTAL_X, 120, PORTAL_Z - 2);
    disc.rotation.y = Math.PI;
    const discMat = new BABYLON.StandardMaterial("portalDisc_h", _scene);
    discMat.emissiveColor    = new BABYLON.Color3(0.5, 0.1, 1.0);
    discMat.disableLighting  = true;
    discMat.alpha            = 0.72;
    disc.material = discMat;
    _portalGlow = disc;

    // second counter-rotating inner ring
    const inner = BABYLON.MeshBuilder.CreateTorus("hubPortalInner",
      { diameter: 140, thickness: 8, tessellation: 32 }, _scene);
    inner.position.set(PORTAL_X, 120, PORTAL_Z - 4);
    inner.material = std("portalInner", 0.9, 0.5, 1.0, 0.6, 0.2, 1.0);
    inner.rotation.x = Math.PI / 4;

    // point light at portal
    const plight = new BABYLON.PointLight("portalLight",
      new BABYLON.Vector3(PORTAL_X, 120, PORTAL_Z), _scene);
    plight.diffuse  = new BABYLON.Color3(0.7, 0.3, 1.0);
    plight.specular = new BABYLON.Color3(0.5, 0.1, 0.8);
    plight.intensity = 4000;
    plight.range = 600;

    // label — only if BABYLON.GUI CDN is present (optional enhancement)
    try {
      if (typeof BABYLON !== "undefined" && BABYLON.GUI && BABYLON.GUI.AdvancedDynamicTexture) {
        const advTex = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("hubUI", true, _scene);
        const lbl = new BABYLON.GUI.TextBlock("portalLbl", "ENTER ARENA");
        lbl.color = "#d0a0ff"; lbl.fontSize = 18; lbl.fontWeight = "700";
        lbl.paddingTop = "6px";
        const rect = new BABYLON.GUI.Rectangle("portalRect");
        rect.width = "180px"; rect.height = "36px";
        rect.cornerRadius = 8; rect.color = "#7030b0";
        rect.background = "#1a0030cc"; rect.thickness = 1;
        rect.addControl(lbl);
        advTex.addControl(rect);
        rect.linkWithMesh(_portal);
        rect.linkOffsetY = -160;
      }
    } catch (_e) {}

    // animate in tick: ring rotates + disc pulses
    _scene.registerBeforeRender(() => {
      _portalT += _engine.getDeltaTime() * 0.001;
      ring.rotation.z = _portalT * 0.8;
      inner.rotation.z = -_portalT * 1.2;
      inner.rotation.x = Math.PI / 4 + Math.sin(_portalT * 2) * 0.15;
      const pulse = 0.6 + Math.sin(_portalT * 3) * 0.15;
      discMat.alpha = pulse;
      discMat.emissiveColor = new BABYLON.Color3(
        0.4 + 0.2 * Math.sin(_portalT * 2.5),
        0.1,
        0.9 + 0.1 * Math.sin(_portalT * 3.5)
      );
      plight.intensity = 3500 + Math.sin(_portalT * 4) * 500;
    });
  }

  // ---- torch primitive (visual only, no extra point lights) ----
  function placeTorch(x, z) {
    const mat = std("hTorch", 1.0, 0.6, 0.1, 0.8, 0.4, 0.05);
    const pole = BABYLON.MeshBuilder.CreateCylinder("htpole",
      { diameter: 10, height: 80, tessellation: 6 }, _scene);
    pole.position.set(x, 40, z);
    pole.material = pbr("hTorchPole", 0.3, 0.22, 0.15, 0.1, 0.7);
    const flame = BABYLON.MeshBuilder.CreateSphere("htflame", { diameter: 20 }, _scene);
    flame.position.set(x, 84, z);
    flame.material = mat;
    // subtle flicker via beforeRender
    let _ft = Math.random() * Math.PI * 2;
    _scene.registerBeforeRender(() => {
      _ft += _engine.getDeltaTime() * 0.004 + Math.random() * 0.003;
      flame.scaling.setAll(0.85 + Math.sin(_ft * 7) * 0.15);
      mat.emissiveColor = new BABYLON.Color3(
        0.8 + Math.sin(_ft * 5) * 0.1,
        0.35 + Math.sin(_ft * 7) * 0.05,
        0.05
      );
    });
  }

  // ---- player capsule (fallback if GLB fails) ----
  function buildPlayerPrimitive(heroIdx) {
    const COLORS = [
      [0.85, 0.78, 0.55], // Knight gold
      [0.55, 0.75, 0.95], // Warrior blue
      [0.95, 0.55, 0.55], // Mage red
      [0.60, 0.90, 0.60], // Paladin green
      [0.85, 0.60, 0.95], // Ranger purple
      [0.95, 0.75, 0.45], // Orc orange
    ];
    const rgb = COLORS[heroIdx % COLORS.length];
    const root = new BABYLON.TransformNode("hubPlayer", _scene);
    const body = BABYLON.MeshBuilder.CreateCapsule("hubBody",
      { height: 110, radius: 34 }, _scene);
    body.parent = root;
    body.position.y = 55;
    const bm = new BABYLON.StandardMaterial("hubBodyMat", _scene);
    bm.diffuseColor  = new BABYLON.Color3(rgb[0], rgb[1], rgb[2]);
    bm.emissiveColor = new BABYLON.Color3(rgb[0] * 0.2, rgb[1] * 0.2, rgb[2] * 0.2);
    body.material = bm;
    _playerRoot = root;
    _heroMesh   = body;
  }

  // ---- async: spawn hero GLB for hub player ----
  async function spawnHeroGLB(heroIdx) {
    const files = [
      "models/heroes/knight.glb",  "models/heroes/warrior.glb",
      "models/heroes/mage.glb",    "models/heroes/paladin.glb",
      "models/heroes/ranger.glb",  "models/heroes/orc.glb",
    ];
    const file = files[heroIdx % files.length];
    const tmpl = await loadGLB(file, 120);
    if (!tmpl || !_playerRoot) return; // already disposed or failed

    // create child under _playerRoot
    const child = new BABYLON.TransformNode("hubHeroModel", _scene);
    child.parent = _playerRoot;
    tmpl.meshes.forEach((src) => {
      if (!src.geometry && src.getChildMeshes().length === 0) return;
      const inst = src.clone("hhero_" + src.name, child);
      if (inst) inst.isVisible = true;
    });
    child.scaling.setAll(tmpl.scale);
    child.position.y = tmpl.yOff;
    if (_heroMesh) { _heroMesh.isVisible = false; }

    // handle idle animation
    const animGroups = tmpl.animGroups.map((ag) => ag.clone("hhero_ag_" + ag.name));
    const idle = animGroups.find((ag) =>
      ag.name.toLowerCase().includes("idle")) || animGroups[0];
    if (idle) idle.start(true, 1.0);
  }

  // ---- async trees/rocks/keep/torch ----
  async function buildEnvGLB() {
    // load in parallel; each placement uses the hub scene's _scene
    const [treeTmpl, pineTmpl, rockTmpl, keepTmpl, torchTmpl] = await Promise.all([
      loadGLB("models/env/tree.glb",  260),
      loadGLB("models/env/pine.glb",  220),
      loadGLB("models/env/rock.glb",  100),
      loadGLB("models/env/keep.glb",  600),
      loadGLB("models/env/torch.glb", 100),
    ]);

    const r = rng(42);

    // keep near center-north
    if (keepTmpl) {
      placeClone(keepTmpl, "hubKeep", -60, -400, 0);
    } else {
      // primitive keep tower
      const box = BABYLON.MeshBuilder.CreateBox("hubKeepPrim",
        { width: 300, height: 500, depth: 300 }, _scene);
      box.position.set(-60, 250, -400);
      box.material = pbr("hKeep", 0.30, 0.27, 0.22, 0.05, 0.85);
    }

    // house (primitive since no house GLB)
    const houseMat = pbr("hHouse", 0.55, 0.38, 0.25, 0.0, 0.88);
    const roofMat  = pbr("hRoof",  0.60, 0.20, 0.15, 0.0, 0.80);
    const house = BABYLON.MeshBuilder.CreateBox("hubHouse",
      { width: 220, height: 180, depth: 260 }, _scene);
    house.position.set(700, 90, -200);
    house.material = houseMat;
    const roof = BABYLON.MeshBuilder.CreateCylinder("hubRoof",
      { diameter: 280, height: 160, tessellation: 4, diameterTop: 0 }, _scene);
    roof.position.set(700, 250, -200);
    roof.rotation.y = Math.PI / 4;
    roof.material = roofMat;

    // trees in clusters
    const treePositions = [
      { x: -700, z: -600 }, { x: -900, z: -200 }, { x: -800, z: 200 },
      { x: 500,  z: -700 }, { x: 900,  z: -500 }, { x: -500, z:  700 },
      { x: 200,  z:  900 }, { x: 800,  z:  600 }, { x: -1000, z: 500 },
      { x: 1000, z: 200 },  { x: -300, z: -950 }, { x: 400,  z: 1000 },
      { x: -600, z: 1000 }, { x: 1100, z: -300 }, { x: -1100, z:-400 },
    ];
    const tmplT = treeTmpl || pineTmpl;
    const tmplP = pineTmpl || treeTmpl;
    if (tmplT || tmplP) {
      treePositions.forEach((pos, i) => {
        // ring of 3-4 trees
        const count = 3 + (i % 2);
        for (let k = 0; k < count; k++) {
          const ang  = (k / count) * Math.PI * 2 + r() * 0.5;
          const dist = 40 + r() * 80;
          const tx   = pos.x + Math.cos(ang) * dist;
          const tz   = pos.z + Math.sin(ang) * dist;
          if (Math.hypot(tx, tz) > ISLAND_R - 80) continue; // keep on island
          const tmpl = (k % 3 === 2) ? tmplP : tmplT;
          if (!tmpl) continue;
          placeClone(tmpl, "htree" + i + "_" + k, tx, tz, r() * Math.PI * 2);
        }
      });
    } else {
      // primitive tree fallback
      const trunkMat = pbr("hTrunk", 0.25, 0.16, 0.09, 0, 0.95);
      const canopyMat = pbr("hCanopy", 0.12, 0.38, 0.10, 0, 0.85);
      treePositions.forEach((pos, i) => {
        const trunk = BABYLON.MeshBuilder.CreateCylinder("phtree" + i,
          { diameter: 22, height: 150, tessellation: 8 }, _scene);
        trunk.position.set(pos.x, 75, pos.z);
        trunk.material = trunkMat;
        const canopy = BABYLON.MeshBuilder.CreateCylinder("phcan" + i,
          { diameterTop: 0, diameterBottom: 150, height: 180, tessellation: 8 }, _scene);
        canopy.position.set(pos.x, 210, pos.z);
        canopy.material = canopyMat;
      });
    }

    // rocks
    if (rockTmpl) {
      for (let i = 0; i < 16; i++) {
        const ang  = r() * Math.PI * 2;
        const dist = ISLAND_R * 0.35 + r() * ISLAND_R * 0.55;
        const rx   = Math.cos(ang) * dist;
        const rz   = Math.sin(ang) * dist;
        if (Math.hypot(rx, rz) > ISLAND_R - 60) continue;
        placeClone(rockTmpl, "hrock" + i, rx, rz, r() * Math.PI * 2,
          rockTmpl.scale * (0.6 + r() * 0.8));
      }
    }

    // torches: at portal + along dock + 4 island accent positions
    const torchSpots = [
      { x: PORTAL_X - 120, z: PORTAL_Z + 10 },
      { x: PORTAL_X + 120, z: PORTAL_Z + 10 },
      { x: DOCK_X - 70,    z: DOCK_Z - 30   },
      { x: DOCK_X + 70,    z: DOCK_Z - 30   },
      { x: -400,  z: -600 },
      { x:  400,  z: -400 },
    ];
    torchSpots.forEach((tp, ti) => {
      if (torchTmpl) {
        placeClone(torchTmpl, "htorch" + ti, tp.x, tp.z, r() * Math.PI * 2);
      } else {
        placeTorch(tp.x, tp.z); // primitive fallback
      }
    });

    // torch point lights at portal entrances (only 2 to stay in budget)
    torchSpots.slice(0, 2).forEach((tp, ti) => {
      const tl = new BABYLON.PointLight("hTorchL" + ti,
        new BABYLON.Vector3(tp.x, 90, tp.z), _scene);
      tl.diffuse  = new BABYLON.Color3(1.0, 0.65, 0.25);
      tl.specular = new BABYLON.Color3(0.4, 0.2, 0.05);
      tl.intensity = 2800;
      tl.range = 400;
    });
  }

  // ---- fish ----
  function buildFish() {
    const fishMat = std("hFish", 0.9, 0.65, 0.1, 0.15, 0.12, 0.0);
    const fishMat2 = std("hFish2", 0.2, 0.65, 0.9, 0.05, 0.20, 0.30);
    const r = rng(7);
    for (let i = 0; i < FISH_COUNT; i++) {
      const ang  = r() * Math.PI * 2;
      const dist = ISLAND_R + 120 + r() * 600; // all in water
      const fx   = Math.cos(ang) * dist;
      const fz   = Math.sin(ang) * dist;
      const fish = BABYLON.MeshBuilder.CreateBox("hfish" + i,
        { width: 28, height: 10, depth: 12 }, _scene);
      fish.position.set(fx, -4, fz);
      fish.material = i % 2 === 0 ? fishMat : fishMat2;
      const tail = BABYLON.MeshBuilder.CreateBox("hftail" + i,
        { width: 12, height: 12, depth: 8 }, _scene);
      tail.parent = fish;
      tail.position.z = -10;
      tail.rotation.y = Math.PI / 6;
      tail.material = fish.material;
      // store swim data
      fish._ang    = ang;
      fish._dist   = dist;
      fish._speed  = 0.12 + r() * 0.18; // rad/sec
      fish._yBob   = r() * Math.PI * 2;
      fish._tail   = tail;
      _fishViews.push(fish);
    }
  }

  // Update fish swim positions each frame
  function tickFish(dtMs) {
    const dt = Math.min(dtMs, 50) / 1000;
    _fishViews.forEach((f) => {
      f._ang   += f._speed * dt;
      f._yBob  += dt * 1.5;
      const fx  = Math.cos(f._ang) * f._dist;
      const fz  = Math.sin(f._ang) * f._dist;
      f.position.set(fx, -4 + Math.sin(f._yBob) * 2.5, fz);
      // face direction of travel
      f.rotation.y = -f._ang + Math.PI / 2;
      // tail wag
      if (f._tail) f._tail.rotation.y = Math.sin(f._yBob * 4) * 0.4;
    });
  }

  // ---- fishing state machine ----
  let _fishPromptDiv = null; // "Press F to fish" prompt
  let _fishCountDiv  = null; // "Fish caught: N" counter
  let _fishPopupDiv  = null; // bite/catch popup

  function buildFishingUI() {
    // prompt shown near water
    _fishPromptDiv = document.createElement("div");
    Object.assign(_fishPromptDiv.style, {
      position: "fixed", bottom: "90px", left: "50%",
      transform: "translateX(-50%)",
      background: "#0b0e14cc", border: "1px solid #6a5530",
      borderRadius: "8px", padding: "8px 18px",
      color: "#f0e6d2", fontSize: "15px", fontWeight: "600",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      pointerEvents: "none", display: "none",
      zIndex: "30",
    });
    _fishPromptDiv.textContent = "Press F to fish";
    document.body.appendChild(_fishPromptDiv);

    // counter — HIDDEN until first catch
    _fishCountDiv = document.createElement("div");
    Object.assign(_fishCountDiv.style, {
      position: "fixed", top: "14px", right: "14px",
      background: "#0b0e14cc", border: "1px solid #6a5530",
      borderRadius: "8px", padding: "6px 14px",
      color: "#ffcf5c", fontSize: "14px", fontWeight: "700",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      pointerEvents: "none", display: "none",
      zIndex: "30",
    });
    document.body.appendChild(_fishCountDiv);

    // popup
    _fishPopupDiv = document.createElement("div");
    Object.assign(_fishPopupDiv.style, {
      position: "fixed", top: "35%", left: "50%",
      transform: "translateX(-50%)",
      background: "#0b0e14ee", border: "2px solid #ffcf5c",
      borderRadius: "12px", padding: "14px 28px",
      color: "#ffcf5c", fontSize: "20px", fontWeight: "700",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      pointerEvents: "none", display: "none",
      zIndex: "35", textAlign: "center",
    });
    document.body.appendChild(_fishPopupDiv);
  }

  function showPopup(text, durationMs) {
    if (!_fishPopupDiv) return;
    _fishPopupDiv.textContent = text;
    _fishPopupDiv.style.display = "block";
    clearTimeout(_fishPopupDiv._timer);
    _fishPopupDiv._timer = setTimeout(() => {
      if (_fishPopupDiv) _fishPopupDiv.style.display = "none";
    }, durationMs);
  }

  function spawnBobber(x, z) {
    if (_fishBobber) { _fishBobber.dispose(); _fishBobber = null; }
    const b = BABYLON.MeshBuilder.CreateSphere("fishBobber",
      { diameter: 16 }, _scene);
    b.position.set(x, 2, z);
    const bm = new BABYLON.StandardMaterial("bobberMat", _scene);
    bm.diffuseColor  = new BABYLON.Color3(1, 0.2, 0.2);
    bm.emissiveColor = new BABYLON.Color3(0.4, 0.05, 0.05);
    b.material = bm;
    _fishBobber = b;
    return b;
  }

  function tickFishing(dtMs) {
    if (!_fishPromptDiv) return;
    const dt = Math.min(dtMs, 50) / 1000;
    // check distance to water edge
    const distFromCenter = Math.hypot(_playerX, _playerZ);
    const nearWater = distFromCenter > (ISLAND_R - FISH_ENTER_R);
    _fishPromptDiv.style.display = (nearWater && _fishState === "idle") ? "block" : "none";

    // bobber bob animation
    if (_fishBobber) {
      _fishBobber.position.y = 2 + Math.sin(performance.now() * 0.003) * 4;
    }

    // F key edge detection
    const fDown = _fKey && !_fKeyPrev;
    _fKeyPrev = _fKey;

    switch (_fishState) {
      case "idle":
        if (fDown && nearWater) {
          // cast: throw bobber into water
          const ang = Math.atan2(_playerZ, _playerX); // toward water
          const bDist = ISLAND_R + 120;
          const bx = Math.cos(ang) * bDist;
          const bz = Math.sin(ang) * bDist;
          spawnBobber(bx, bz);
          _fishState = "casting";
          _fishTimer = 0;
          showPopup("Casting...", 1200);
        }
        break;

      case "casting":
        _fishTimer += dtMs;
        if (_fishTimer > 1200) {
          // wait for bite: 1.5-4 seconds
          _fishState = "biting";
          _fishTimer = 1500 + Math.random() * 2500;
        }
        break;

      case "biting":
        _fishTimer -= dtMs;
        if (_fishTimer <= 0) {
          // BITE!
          showPopup("Fish on! Press F to catch!", 3000);
          _fishState = "catching";
          _fishTimer = 3000; // 3s window to catch
        }
        break;

      case "catching":
        _fishTimer -= dtMs;
        if (fDown) {
          // caught
          _fishCount++;
          if (!_fishFirstCatch) {
            _fishFirstCatch = true;
          }
          if (_fishFirstCatch && _fishCountDiv) {
            _fishCountDiv.textContent = "Fish: " + _fishCount;
            _fishCountDiv.style.display = "block";
          }
          showPopup("Got a fish! (" + _fishCount + ")", 2000);
          if (_fishBobber) { _fishBobber.dispose(); _fishBobber = null; }
          _fishState = "idle";
          _fishTimer = 0;
        } else if (_fishTimer <= 0) {
          // missed
          showPopup("Got away!", 1500);
          if (_fishBobber) { _fishBobber.dispose(); _fishBobber = null; }
          _fishState = "idle";
          _fishTimer = 0;
        }
        break;
    }
  }

  // ---- hub-local WASD ----
  function setupHubKeys() {
    const setKey = (e, down) => {
      if (_entered) return;
      const k = e.code;
      if      (k === "KeyW" || k === "ArrowUp")    _keys.up    = down;
      else if (k === "KeyS" || k === "ArrowDown")  _keys.down  = down;
      else if (k === "KeyA" || k === "ArrowLeft")  _keys.left  = down;
      else if (k === "KeyD" || k === "ArrowRight") _keys.right = down;
      else if (k === "KeyF") { _fKey = down; }
    };
    // separate wrappers so `down` is bound correctly
    _hubKeyDown = (e) => setKey(e, true);
    _hubKeyUp   = (e) => setKey(e, false);
    window.addEventListener("keydown", _hubKeyDown);
    window.addEventListener("keyup",   _hubKeyUp);
  }
  let _hubKeyDown = null, _hubKeyUp = null;

  // ---- player movement tick ----
  function tickPlayer(dtMs) {
    const dt = Math.min(dtMs, 50) / 1000;
    const ix = (_keys.right ? 1 : 0) - (_keys.left ? 1 : 0);
    const iy = (_keys.down  ? 1 : 0) - (_keys.up   ? 1 : 0);
    if (ix || iy) {
      const len = Math.hypot(ix, iy) || 1;
      const nx  = _playerX + (ix / len) * PLAYER_SPEED * dt;
      const nz  = _playerZ + (iy / len) * PLAYER_SPEED * dt;
      // keep on island (soft clamp to ISLAND_R + small buffer)
      const distNew = Math.hypot(nx, nz);
      if (distNew < ISLAND_R + 40) {
        _playerX = nx;
        _playerZ = nz;
      }
      if (_playerRoot) {
        const ang = Math.atan2(ix, iy);
        _playerRoot.rotation.y = ang;
      }
    }
    if (_playerRoot) {
      _playerRoot.position.set(_playerX, 0, _playerZ);
    }
  }

  // ---- camera follow ----
  function tickCamera(dtMs) {
    if (!_camera) return;
    const dt   = Math.min(dtMs, 50) / 1000;
    const k    = 1 - Math.pow(0.0001, dt * 4);
    const desX = _playerX;
    const desY = CAM_HEIGHT;
    const desZ = _playerZ + CAM_DIST;
    _camera.position.x += (desX - _camera.position.x) * k;
    _camera.position.y += (desY - _camera.position.y) * k;
    _camera.position.z += (desZ - _camera.position.z) * k;
    _camera.setTarget(new BABYLON.Vector3(_playerX, 60, _playerZ));
  }

  // ---- portal proximity check ----
  function tickPortal() {
    // expose for headless diagnostics
    window._hubPlayerX = _playerX;
    window._hubPlayerZ = _playerZ;
    window._hubEntered = _entered;
    if (_entered) return;
    const dx = _playerX - PORTAL_X;
    const dz = _playerZ - PORTAL_Z;
    const dist = Math.hypot(dx, dz);
    if (dist < PORTAL_ENTER_R) {
      _entered = true;
      enterArena();
    }
  }

  // ---- ambient birds (flat billboards, simple motion) ----
  function buildBirds() {
    const birdMat = new BABYLON.StandardMaterial("birdMat", _scene);
    birdMat.diffuseColor  = new BABYLON.Color3(0.1, 0.1, 0.12);
    birdMat.emissiveColor = new BABYLON.Color3(0.05, 0.05, 0.06);
    birdMat.disableLighting = true;
    const birds = [];
    for (let i = 0; i < 6; i++) {
      const b = BABYLON.MeshBuilder.CreateBox("bird" + i,
        { width: 22, height: 5, depth: 10 }, _scene);
      b.material = birdMat;
      b.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y;
      b._bAng  = (i / 6) * Math.PI * 2;
      b._bR    = 600 + i * 80;
      b._bH    = 380 + i * 30;
      b._bSpd  = 0.08 + i * 0.012;
      birds.push(b);
    }
    _scene.registerBeforeRender(() => {
      const dt = _engine.getDeltaTime() / 1000;
      birds.forEach((b) => {
        b._bAng += b._bSpd * dt;
        b.position.set(
          Math.cos(b._bAng) * b._bR,
          b._bH + Math.sin(b._bAng * 3) * 20,
          Math.sin(b._bAng) * b._bR
        );
        b.rotation.y = -b._bAng;
      });
    });
  }

  // ---- transition into arena ----
  function enterArena() {
    // clean up hub UI elements
    if (_fishPromptDiv) { _fishPromptDiv.remove(); _fishPromptDiv = null; }
    if (_fishCountDiv)  { _fishCountDiv.remove();  _fishCountDiv  = null; }
    if (_fishPopupDiv)  { _fishPopupDiv.remove();  _fishPopupDiv  = null; }
    if (_fishBobber)    { _fishBobber.dispose();   _fishBobber    = null; }

    // stop hub render loop, dispose hub scene
    _engine.stopRenderLoop();

    // short flash/fade transition
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0",
      background: "rgba(80,0,180,0.0)",
      transition: "background 0.5s ease",
      zIndex: "50",
      pointerEvents: "none",
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.style.background = "rgba(80,0,180,0.9)";
    });

    setTimeout(() => {
      // dispose hub scene + engine so GANKScene can create a fresh Engine on the same canvas
      if (_scene)  { _scene.dispose();  _scene  = null; }
      if (_engine) { _engine.dispose(); _engine = null; }
      // now boot the arena via the callback
      if (_onArena) _onArena();
      // fade out overlay
      overlay.style.background = "rgba(80,0,180,0.0)";
      setTimeout(() => overlay.remove(), 600);
    }, 500);
  }

  // ---- public boot ----
  // canvas: the renderCanvas element
  // name, heroIdx: from title screen
  // onArena: function() — called when player enters the portal; caller boots the arena
  function boot(canvas, name, heroIdx, onArena) {
    _onArena = onArena;

    // create or reuse engine — GANKScene hasn't called initScene yet, so there is no engine yet
    _engine = new BABYLON.Engine(canvas, true, { adaptToDeviceRatio: true });
    _scene  = new BABYLON.Scene(_engine);

    window.addEventListener("resize", () => _engine && _engine.resize());

    setupAtmosphere();
    buildLights();
    const cam = buildCamera();

    buildPipeline(cam);
    buildTerrain();
    buildDock();
    buildPortal();
    buildFish();
    buildFishingUI();
    buildBirds();

    // player — primitive immediately, GLB swapped in async
    buildPlayerPrimitive(heroIdx);
    _playerX = 0;
    _playerZ = 300; // start a bit south of center, near dock side

    spawnHeroGLB(heroIdx).catch(() => {}); // non-blocking

    // async env (trees, rocks, keep, torches)
    buildEnvGLB().catch(() => {});

    setupHubKeys();

    // hub render loop
    _engine.runRenderLoop(() => {
      if (!_scene) return;
      const dtMs = _engine.getDeltaTime();
      tickPlayer(dtMs);
      tickCamera(dtMs);
      tickFish(dtMs);
      tickFishing(dtMs);
      tickPortal();
      _scene.render();
    });
  }

  // Test/debug hook: teleport player to a world position.
  // Used by headless smoke tests to verify portal transition without relying on slow SwiftShader rAF.
  function teleport(x, z) {
    _playerX = x;
    _playerZ = z;
    if (_playerRoot) _playerRoot.position.set(x, 0, z);
  }

  return { boot, teleport };
})();

window.HUB3D = HUB3D;

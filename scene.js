"use strict";
// scene.js — Babylon engine, camera, lights, ground, and full arena environment.
// Exposes: window.GANKScene = { scene, engine, camera, groundMesh, initScene }
//
// World coordinate mapping: server (x, y) -> 3D (x, 0, z=y).
// Arena is 2880x2880 world units; center is (1440, 0, 1440).
//
// ART DIRECTION: BRIGHT golden-hour stylized COLISEUM. Sunny sky-blue background,
// warm sandstone ground, golden directional light, villain-accent (arcane violet
// + ember orange) emissive trim. Villainy comes from characters, NOT darkness.
//
// ENVIRONMENT: modular Kenney GLB kits (CC0) under models/env/kenney_arena, etc.
// Pieces are tiny (~1 unit). They are bbox-normalized to world-unit targets and
// placed as HARDWARE INSTANCES (shared geometry) for the perimeter ring / columns /
// cover. Loaded async after initScene() returns so the scene renders immediately.

const GANKScene = (() => {
  const ARENA = 2880;
  const CX = ARENA / 2; // 1440
  const CZ = ARENA / 2; // 1440
  const KIT = "models/env/"; // base path for GLB kits

  // ---- ARENA_OBSTACLES (mirrored from ArenaRoom.js) ----
  const ARENA_OBSTACLES = [
    { x:1101, y:1101, w:52, h:52 }, { x:1156, y:1052, w:32, h:32 },
    { x:1779, y:1101, w:52, h:52 }, { x:1724, y:1052, w:32, h:32 },
    { x:1101, y:1779, w:52, h:52 }, { x:1156, y:1828, w:32, h:32 },
    { x:1779, y:1779, w:52, h:52 }, { x:1724, y:1828, w:32, h:32 },
    { x:1210, y:1180, w:230, h:28 }, { x:1670, y:1180, w:230, h:28 },
    { x:1210, y:1700, w:230, h:28 }, { x:1670, y:1700, w:230, h:28 },
    { x:1180, y:1210, w:28, h:230 }, { x:1180, y:1670, w:28, h:230 },
    { x:1700, y:1210, w:28, h:230 }, { x:1700, y:1670, w:28, h:230 },
    { x:370,  y:370,  w:60, h:60 }, { x:436,  y:320,  w:36, h:36 },
    { x:2510, y:370,  w:60, h:60 }, { x:2444, y:320,  w:36, h:36 },
    { x:370,  y:2510, w:60, h:60 }, { x:436,  y:2560, w:36, h:36 },
    { x:2510, y:2510, w:60, h:60 }, { x:2444, y:2560, w:36, h:36 },
  ];

  // Neutral camp positions (kind: 0=slime, 1=bat, 2=ghost)
  const NEUTRAL_CAMPS = [
    { x: 1440, y: 940,  kind: 1 },
    { x: 1440, y: 1940, kind: 1 },
    { x: 940,  y: 1440, kind: 0 },
    { x: 1940, y: 1440, kind: 0 },
    { x: 860,  y: 720,  kind: 2 },
    { x: 2020, y: 720,  kind: 2 },
    { x: 860,  y: 2160, kind: 2 },
    { x: 2020, y: 2160, kind: 2 },
  ];

  const SPAWN_POS = [
    { x: 1440, y: 460 },
    { x: 2281, y: 980 },
    { x: 2281, y: 1900 },
    { x: 1440, y: 2420 },
    { x: 599,  y: 1900 },
    { x: 599,  y: 980 },
  ];

  let _scene, _engine, _camera, _groundMesh;
  let _shadowGen = null;
  let _dirLight = null;

  // material cache
  const _mats = {};
  function getMat(key, setup) {
    if (_mats[key]) return _mats[key];
    const m = setup(); _mats[key] = m; return m;
  }
  function stdMat(name, dr, dg, db, er=0, eg=0, eb=0) {
    return getMat(name, () => {
      const m = new BABYLON.StandardMaterial(name, _scene);
      m.diffuseColor  = new BABYLON.Color3(dr, dg, db);
      m.emissiveColor = new BABYLON.Color3(er, eg, eb);
      m.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
      return m;
    });
  }

  // Deterministic PRNG — used by texture generators and prop placement.
  function seededRand2(seed) {
    let s = seed | 0;
    return function() {
      s = (s ^ (s << 13)) & 0x7fffffff;
      s = (s ^ (s >> 17)) & 0x7fffffff;
      s = (s ^ (s << 5))  & 0x7fffffff;
      return (s & 0x7fffffff) / 0x7fffffff;
    };
  }

  // ============================================================
  // SANDSTONE GROUND TEXTURE — light warm flagstone variation.
  // Multiplied by the material's sandstone diffuseColor → stays bright.
  // ============================================================
  function makeSandstoneTexture() {
    const TEX = 512;
    const dt = new BABYLON.DynamicTexture("sandTex", { width: TEX, height: TEX }, _scene, false);
    dt.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    const ctx = dt.getContext();

    // light warm base (kept bright so multiply stays sandstone, never dark)
    ctx.fillStyle = "#dccfba";
    ctx.fillRect(0, 0, TEX, TEX);

    const rng = seededRand2(7);
    // soft mottling — lighter sand spots + subtle tan spots
    for (let i = 0; i < 240; i++) {
      const x = rng() * TEX, y = rng() * TEX, r = 5 + rng() * 24;
      ctx.globalAlpha = 0.05 + rng() * 0.11;
      ctx.fillStyle = rng() > 0.5 ? "#f1e8d6" : "#c2b193";
      ctx.beginPath();
      ctx.ellipse(x, y, r * (0.6 + rng()), r, rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // faint flagstone grout grid
    ctx.globalAlpha = 0.10;
    ctx.strokeStyle = "#ab9c80";
    ctx.lineWidth = 2;
    for (let i = 0; i <= TEX; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, TEX); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(TEX, i); ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
    dt.update();
    return dt;
  }

  // ============================================================
  // GLB KIT LOADER — bbox-normalize + bake transforms so pieces can be
  // hardware-instanced. Returns { meshes, scale, yOffset, dx, dz, longAxisZ }
  // or null on failure (caller falls back gracefully, never crashes).
  // ============================================================
  const _kitCache = {};

  async function loadKit(file, target, byWidth, overrideMat) {
    if (file in _kitCache) return _kitCache[file];
    let resolve;
    const inflight = new Promise((r) => { resolve = r; });
    _kitCache[file] = inflight;
    try {
      const url = KIT + file;
      // ImportMeshAsync throws on a missing file -> caught below -> graceful null.
      const res = await BABYLON.SceneLoader.ImportMeshAsync("", "", url, _scene);
      const real = (res.meshes || []).filter(
        (m) => m.getTotalVertices && m.getTotalVertices() > 0);
      if (real.length === 0) throw new Error("no geometry");

      // flatten hierarchy + bake world transform into vertices (incl glTF flip)
      // so each template mesh sits at identity local and can be instanced cleanly.
      real.forEach((m) => {
        m.setParent(null);
        try { m.bakeCurrentTransformIntoVertices(); } catch (_) {}
        m.computeWorldMatrix(true);
        m.refreshBoundingInfo();
      });

      // combined bbox (meshes now at origin in world space)
      let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
      real.forEach((m) => {
        const bi = m.getBoundingInfo().boundingBox;
        const lo = bi.minimumWorld, hi = bi.maximumWorld;
        if (lo.x<minX) minX=lo.x; if (hi.x>maxX) maxX=hi.x;
        if (lo.y<minY) minY=lo.y; if (hi.y>maxY) maxY=hi.y;
        if (lo.z<minZ) minZ=lo.z; if (hi.z>maxZ) maxZ=hi.z;
      });
      const natW = Math.max(maxX-minX, maxZ-minZ);
      const natH = maxY-minY;
      const denom = byWidth ? natW : natH;
      const scale = denom > 0.0001 ? target / denom : 1;

      // override the GLB material with an intentional stylized one (the kits ship
      // without their colormap atlas, so default materials would be untextured/white).
      if (overrideMat) real.forEach((m) => { m.material = overrideMat; });

      // hide + park templates far away so any stray shadow-pass render is offscreen.
      // (Instances reference geometry + their own matrices, so moving the source
      //  template does NOT move the placed instances.)
      real.forEach((m) => { m.isVisible = false; m.position.y = -50000; });
      if (res.animationGroups) res.animationGroups.forEach((a) => a.stop());

      const tmpl = {
        meshes: real,
        scale,
        yOffset: -minY * scale,
        dx: (maxX-minX) * scale,
        dz: (maxZ-minZ) * scale,
        longAxisZ: (maxZ-minZ) > (maxX-minX),
        _castReg: false,
      };
      _kitCache[file] = tmpl;
      resolve(tmpl);
      return tmpl;
    } catch (_e) {
      _kitCache[file] = null;
      resolve(null);
      return null;
    }
  }

  // Place a kit template as hardware instances under a frozen TransformNode.
  function placeKit(tmpl, name, x, z, rotY, scaleMul, cast) {
    if (!tmpl) return null;
    const mul = scaleMul || 1;
    const node = new BABYLON.TransformNode(name, _scene);
    node.position.set(x, tmpl.yOffset * mul, z);
    node.scaling.setAll(tmpl.scale * mul);
    if (rotY) node.rotation.y = rotY;
    node.computeWorldMatrix(true);

    if (cast && _shadowGen && !tmpl._castReg) {
      tmpl.meshes.forEach((s) => _shadowGen.addShadowCaster(s, false));
      tmpl._castReg = true;
    }
    tmpl.meshes.forEach((src, i) => {
      const inst = src.createInstance(name + "_" + i);
      inst.parent = node;
      inst.isVisible = true;
      inst.receiveShadows = true;
      inst.computeWorldMatrix(true);
      inst.freezeWorldMatrix();
    });
    node.freezeWorldMatrix();
    return node;
  }

  // Scale a template so its horizontal footprint matches a server collision rect.
  function placeFootprint(tmpl, name, o, cast) {
    if (!tmpl) return null;
    const foot = Math.max(o.w, o.h);
    const cur  = Math.max(tmpl.dx, tmpl.dz) || 1;
    const mul  = foot / cur;
    // orient long axis along the obstacle's long axis
    let rot;
    if (o.w >= o.h) rot = tmpl.longAxisZ ? Math.PI/2 : 0;
    else            rot = tmpl.longAxisZ ? 0 : Math.PI/2;
    return placeKit(tmpl, name, o.x, o.y, rot, mul, cast);
  }

  // ============================================================
  // GROUND — bright warm sandstone field.
  // ============================================================
  function buildGround() {
    _groundMesh = BABYLON.MeshBuilder.CreateGround("ground",
      { width: ARENA, height: ARENA, subdivisions: 8 }, _scene);
    _groundMesh.position.set(CX, 0, CZ);
    _groundMesh.receiveShadows = true;

    const m = new BABYLON.StandardMaterial("gndMat", _scene);
    m.diffuseColor  = new BABYLON.Color3(0.78, 0.66, 0.47); // warm sandstone
    m.specularColor = new BABYLON.Color3(0.04, 0.04, 0.03); // matte
    const tex = makeSandstoneTexture();
    tex.uScale = 10; tex.vScale = 10;
    m.diffuseTexture = tex;
    _groundMesh.material = m;
    _groundMesh.freezeWorldMatrix();
    _mats["gndMat"] = m;
  }

  // ============================================================
  // CENTER — raised sandstone dais + ember-orange objective ring.
  // ============================================================
  function buildCenter() {
    const dais = BABYLON.MeshBuilder.CreateCylinder("centerDais",
      { diameter: 540, height: 44, tessellation: 48 }, _scene);
    dais.position.set(CX, 22, CZ);
    const dm = new BABYLON.StandardMaterial("daisMat", _scene);
    dm.diffuseColor  = new BABYLON.Color3(0.84, 0.72, 0.53);
    dm.specularColor = new BABYLON.Color3(0.05, 0.05, 0.04);
    dais.material = dm;
    dais.receiveShadows = true;
    if (_shadowGen) _shadowGen.addShadowCaster(dais, false);
    dais.freezeWorldMatrix();

    // ember-orange center ring (lies flat in XZ) — the showdown objective marker
    const ring = BABYLON.MeshBuilder.CreateTorus("centerRing",
      { diameter: 500, thickness: 16, tessellation: 64 }, _scene);
    ring.position.set(CX, 48, CZ);
    const rm = new BABYLON.StandardMaterial("centerRingMat", _scene);
    rm.emissiveColor   = new BABYLON.Color3(1.0, 0.48, 0.10); // ember orange
    rm.diffuseColor    = new BABYLON.Color3(0.25, 0.10, 0.0);
    rm.disableLighting = true;
    ring.material = rm;
    ring.freezeWorldMatrix();
  }

  // ============================================================
  // CAMP MARKERS — bright colored objective rings (always present).
  // ============================================================
  function buildCampMarkers() {
    const markerMats = [
      stdMat("mk0", 0.35, 0.95, 0.40, 0.10, 0.45, 0.12), // slime green
      stdMat("mk1", 0.35, 0.62, 1.00, 0.10, 0.25, 0.55), // bat blue
      stdMat("mk2", 0.72, 0.40, 1.00, 0.30, 0.12, 0.55), // ghost violet
    ];
    const templates = markerMats.map((mat, ki) => {
      const t = BABYLON.MeshBuilder.CreateTorus("campMarkerTmpl" + ki,
        { diameter: 90, thickness: 7, tessellation: 24 }, _scene);
      t.material = mat;
      t.isVisible = false;
      return t;
    });
    NEUTRAL_CAMPS.forEach((camp, ci) => {
      const mk = templates[camp.kind].createInstance("mk" + ci);
      mk.position.set(camp.x, 3, camp.y);
      mk.freezeWorldMatrix();
    });
  }

  // ============================================================
  // ACCENT BANNERS — villain emissive trim (arcane violet + ember orange).
  // Standing emissive quads spaced around the perimeter, facing inward.
  // ============================================================
  function buildAccents() {
    const violet = getMat("bannerViolet", () => {
      const m = new BABYLON.StandardMaterial("bannerViolet", _scene);
      m.diffuseColor    = new BABYLON.Color3(0.20, 0.06, 0.32);
      m.emissiveColor   = new BABYLON.Color3(0.635, 0.235, 0.941); // #A23CF0
      m.specularColor   = new BABYLON.Color3(0, 0, 0);
      m.backFaceCulling = false;
      return m;
    });
    const ember = getMat("bannerEmber", () => {
      const m = new BABYLON.StandardMaterial("bannerEmber", _scene);
      m.diffuseColor    = new BABYLON.Color3(0.32, 0.12, 0.0);
      m.emissiveColor   = new BABYLON.Color3(1.0, 0.478, 0.102); // #FF7A1A
      m.specularColor   = new BABYLON.Color3(0, 0, 0);
      m.backFaceCulling = false;
      return m;
    });

    const inset = 110;
    const spots = [
      // mid-edges (face inward)
      { x: CX,           z: inset,         r: 0 },
      { x: CX,           z: ARENA-inset,   r: Math.PI },
      { x: inset,        z: CZ,            r: Math.PI/2 },
      { x: ARENA-inset,  z: CZ,            r: -Math.PI/2 },
      // quarter points along N/S
      { x: CX-640,       z: inset,         r: 0 },
      { x: CX+640,       z: inset,         r: 0 },
      { x: CX-640,       z: ARENA-inset,   r: Math.PI },
      { x: CX+640,       z: ARENA-inset,   r: Math.PI },
    ];
    spots.forEach((s, i) => {
      const b = BABYLON.MeshBuilder.CreatePlane("banner" + i,
        { width: 80, height: 220 }, _scene);
      b.position.set(s.x, 150, s.z);
      b.rotation.y = s.r;
      b.material = (i % 2 === 0) ? violet : ember;
      b.freezeWorldMatrix();
    });
  }

  // ============================================================
  // ASYNC COLISEUM — modular Kenney GLB build (streams in after init).
  // Tracks how many env pieces were placed for the verify report.
  // ============================================================
  let _placedCount = 0;
  function tally(node) { if (node) _placedCount++; return node; }

  async function buildArenaAsync() {
    // stylized materials (kits ship without their colormap atlas — we set our own).
    const matStone  = stdMat("kitStone",  0.86, 0.78, 0.62);                 // warm sandstone
    const matBronze = stdMat("kitBronze", 0.62, 0.45, 0.20, 0.10, 0.07, 0.0); // golden bronze
    const matRock   = stdMat("kitRock",   0.56, 0.53, 0.47);                 // grey-brown rock
    const matWood   = stdMat("kitWood",   0.45, 0.30, 0.16);                 // wood
    matBronze.specularColor = new BABYLON.Color3(0.35, 0.28, 0.12);

    // load templates in parallel (each fails gracefully -> null)
    const [wall, column, statue, trophy, rack, rocks] = await Promise.all([
      loadKit("kenney_arena/wall.glb",        240, true,  matStone),  // by width -> tiles cleanly
      loadKit("kenney_arena/column.glb",      230, false, matStone),  // by height
      loadKit("kenney_arena/statue.glb",      300, false, matBronze),
      loadKit("kenney_arena/trophy.glb",      190, false, matBronze),
      loadKit("kenney_arena/weapon-rack.glb", 130, false, matWood),
      loadKit("kenney_castle/rocks-large.glb", 110, false, matRock),
    ]);

    const inset = 80;

    // ---- perimeter coliseum wall ring (instances, no shadow for perf) ----
    if (wall) {
      const seg = Math.max(wall.dx, wall.dz) || 240;
      const baseRot = wall.longAxisZ ? Math.PI/2 : 0; // long axis -> +X
      for (let x = seg/2; x < ARENA; x += seg) {
        tally(placeKit(wall, "perimN_" + Math.round(x), x, inset,        baseRot,             1, false));
        tally(placeKit(wall, "perimS_" + Math.round(x), x, ARENA-inset,  baseRot,             1, false));
      }
      for (let z = seg/2; z < ARENA; z += seg) {
        tally(placeKit(wall, "perimW_" + Math.round(z), inset,       z,  baseRot + Math.PI/2, 1, false));
        tally(placeKit(wall, "perimE_" + Math.round(z), ARENA-inset, z,  baseRot + Math.PI/2, 1, false));
      }
    }

    // ---- columns at intervals around the ring (cast shadows — strong silhouettes) ----
    if (column) {
      const step = 480;
      for (let x = inset; x <= ARENA - inset + 1; x += step) {
        tally(placeKit(column, "colN_" + Math.round(x), x, inset,       0, 1, true));
        tally(placeKit(column, "colS_" + Math.round(x), x, ARENA-inset, 0, 1, true));
      }
      for (let z = inset + step; z < ARENA - inset; z += step) {
        tally(placeKit(column, "colW_" + Math.round(z), inset,       z, 0, 1, true));
        tally(placeKit(column, "colE_" + Math.round(z), ARENA-inset, z, 0, 1, true));
      }
    }

    // ---- mid-edge statues + corner trophies (landmarks) ----
    if (statue) {
      tally(placeKit(statue, "statueN", CX, inset + 90, 0,         1, true));
      tally(placeKit(statue, "statueS", CX, ARENA-inset-90, Math.PI, 1, true));
      tally(placeKit(statue, "statueW", inset + 90, CZ, Math.PI/2, 1, true));
      tally(placeKit(statue, "statueE", ARENA-inset-90, CZ, -Math.PI/2, 1, true));
      // dais centerpiece statue
      tally(placeKit(statue, "statueCenter", CX, CZ, 0, 1.3, true));
    }
    if (trophy) {
      const c = inset + 90;
      tally(placeKit(trophy, "trophyNW", c, c, 0, 1, true));
      tally(placeKit(trophy, "trophyNE", ARENA-c, c, 0, 1, true));
      tally(placeKit(trophy, "trophySW", c, ARENA-c, 0, 1, true));
      tally(placeKit(trophy, "trophySE", ARENA-c, ARENA-c, 0, 1, true));
    }

    // ---- cover props at server collision rects ----
    ARENA_OBSTACLES.forEach((o, i) => {
      const isCorner = (o.x < 600 || o.x > 2280) && (o.y < 600 || o.y > 2280);
      const isPillar = (o.w === o.h);
      if (isCorner && rocks)      tally(placeFootprint(rocks,  "obsRock" + i, o, false));
      else if (isPillar && column) tally(placeFootprint(column, "obsCol" + i, o, true));
      else if (wall)               tally(placeFootprint(wall,   "obsWall" + i, o, false));
    });

    // ---- camp landmark props (weapon racks near neutral camps) ----
    if (rack) {
      NEUTRAL_CAMPS.forEach((camp, ci) => {
        const rng = seededRand2(ci * 131 + 5);
        tally(placeKit(rack, "campProp" + ci, camp.x + 55, camp.y + 55,
          rng() * Math.PI * 2, 1, false));
      });
    }

    if (window && window.console) {
      console.log("[scene] coliseum env placed:", _placedCount, "pieces");
    }
  }

  // ============================================================
  // ATMOSPHERE / LIGHTS / SHADOWS / POST — bright golden-hour values.
  // ============================================================
  function setupAtmosphere() {
    _scene.clearColor   = new BABYLON.Color4(0.525, 0.733, 0.859, 1.0); // bright sky #86BBDB
    _scene.fogMode      = BABYLON.Scene.FOGMODE_EXP2;
    _scene.fogColor     = new BABYLON.Color3(0.78, 0.82, 0.81);
    _scene.fogDensity   = 0.00008; // very light
    _scene.ambientColor = new BABYLON.Color3(0.35, 0.34, 0.31);
  }

  function buildLights() {
    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), _scene);
    hemi.intensity   = 0.90;
    hemi.diffuse     = new BABYLON.Color3(0.95, 0.93, 0.86);
    hemi.groundColor = new BABYLON.Color3(0.45, 0.36, 0.28);
    hemi.specular    = new BABYLON.Color3(0.30, 0.30, 0.28);

    _dirLight = new BABYLON.DirectionalLight("dir",
      new BABYLON.Vector3(-0.5, -0.85, -0.3), _scene);
    _dirLight.intensity = 2.20;
    _dirLight.diffuse   = new BABYLON.Color3(1.0, 0.92, 0.76); // warm golden key
    _dirLight.specular  = new BABYLON.Color3(1.0, 0.95, 0.85);
    _dirLight.position  = new BABYLON.Vector3(2400, 3000, 2000);

    // cool sky-blue rim from the opposite side for separation
    const rim = new BABYLON.DirectionalLight("rim",
      new BABYLON.Vector3(0.55, -0.4, 0.5), _scene);
    rim.intensity = 0.40;
    rim.diffuse   = new BABYLON.Color3(0.55, 0.60, 0.95);
    rim.specular  = new BABYLON.Color3(0.45, 0.50, 0.85);
  }

  function buildShadows() {
    if (!_dirLight) return;
    _shadowGen = new BABYLON.ShadowGenerator(1024, _dirLight);
    _shadowGen.usePoissonSampling = true;
    _shadowGen.bias     = 0.004;
    _shadowGen.darkness = 0.45;
  }

  function buildPostProcess() {
    if (typeof BABYLON.DefaultRenderingPipeline === "undefined") return;
    const pipeline = new BABYLON.DefaultRenderingPipeline(
      "gankPP", true /* hdr */, _scene, [_camera]);

    pipeline.fxaaEnabled = true;

    pipeline.bloomEnabled   = true;
    pipeline.bloomThreshold = 0.85; // only bright trim/emissive blooms
    pipeline.bloomWeight    = 0.45;
    pipeline.bloomKernel    = 48;
    pipeline.bloomScale     = 0.5;

    pipeline.imageProcessingEnabled = true;
    pipeline.imageProcessing.toneMappingEnabled = true;
    pipeline.imageProcessing.toneMappingType =
      BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
    pipeline.imageProcessing.contrast = 1.10;
    pipeline.imageProcessing.exposure = 1.10;

    pipeline.imageProcessing.vignetteEnabled = true;
    pipeline.imageProcessing.vignetteWeight  = 0.40;
    pipeline.imageProcessing.vignetteCameraFov = 0.6;
    pipeline.imageProcessing.vignetteColor   = new BABYLON.Color4(0, 0, 0, 0);
    pipeline.imageProcessing.vignetteBlendMode =
      BABYLON.ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
  }

  // ---- camera ----
  function buildCamera() {
    _camera = new BABYLON.TargetCamera("cam",
      new BABYLON.Vector3(CX, 1000, CZ + 700), _scene);
    _camera.fov  = 0.7;
    _camera.minZ = 1;
    _camera.maxZ = 8000;
    _camera.setTarget(new BABYLON.Vector3(CX, 0, CZ));
  }

  // Freeze world matrices on static synchronous meshes (skip dynamic entities).
  function freezeStaticScene() {
    _scene.meshes.forEach((m) => {
      if (m.isWorldMatrixFrozen) return;
      const n = m.name;
      if (n.startsWith("pb") || n.startsWith("pd") || n.startsWith("hp")) return; // players
      if (n.startsWith("cb") || n.startsWith("pr")) return; // creeps/projectiles
      m.freezeWorldMatrix();
    });
  }

  // ---- public ----
  function initScene(canvas) {
    _engine = new BABYLON.Engine(canvas, true, { adaptToDeviceRatio: true });
    _scene  = new BABYLON.Scene(_engine);

    setupAtmosphere();   // bright sky-blue clearColor + very light fog
    buildLights();       // golden key + sky rim + warm hemi
    buildShadows();      // ShadowGenerator from dir — before env builders
    buildCamera();       // TargetCamera (Dota/HotS top-down)
    buildPostProcess();  // bloom (high threshold), ACES, FXAA, light vignette
    buildGround();       // warm sandstone field
    buildCenter();       // sandstone dais + ember-orange objective ring
    buildCampMarkers();  // bright colored camp rings
    buildAccents();      // villain emissive banners (violet/orange)

    freezeStaticScene(); // freeze synchronous static world

    window.addEventListener("resize", () => _engine.resize());
    // async coliseum streams in; must NOT block initScene returning
    buildArenaAsync().catch((e) => { try { console.warn("[scene] env load failed", e); } catch(_){} });

    return { scene: _scene, engine: _engine, camera: _camera };
  }

  return {
    initScene,
    get scene()      { return _scene;  },
    get engine()     { return _engine; },
    get camera()     { return _camera; },
    get groundMesh() { return _groundMesh; },
  };
})();

window.GANKScene = GANKScene;

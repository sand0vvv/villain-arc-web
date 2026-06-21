// ============================================================================
// VILLAIN ARC — Lobby 3D podium scene (Babylon.js)
// ----------------------------------------------------------------------------
// One full-bleed canvas behind the UI. Renders the currently-selected villain
// on a lit podium, idle animation playing, drag-to-rotate. Bright gradient
// backdrop so the dark villain pops. Falls back to a capsule if a GLB fails.
// Pattern mirrors web3d/entities.js (LoadAssetContainerAsync +
// instantiateModelsToScene + bbox-normalized scale).
// ============================================================================
(function () {
  "use strict";

  const PODIUM_HEIGHT = 3.4; // world units the villain should stand
  const _cache = {}; // file -> {container, scale, yOffset} | null | Promise

  let engine, scene, camera, podium;
  let currentRoot = null;
  let currentAnims = [];
  let turntable = true; // slow auto-spin when not dragging
  let dragVel = 0;
  const runeRings = []; // {mesh, speed}

  // ---- bbox extents (force world matrix so root scale counts) --------------
  function bboxExtents(meshes) {
    let minY = Infinity, maxY = -Infinity;
    meshes.forEach((m) => {
      if (!m.getBoundingInfo) return;
      try {
        m.computeWorldMatrix(true);
        m.refreshBoundingInfo();
        const bi = m.getBoundingInfo();
        const a = bi.boundingBox.minimumWorld, b = bi.boundingBox.maximumWorld;
        if (a.y < minY) minY = a.y;
        if (b.y > maxY) maxY = b.y;
      } catch (_e) {}
    });
    if (!isFinite(minY) || !isFinite(maxY)) { minY = 0; maxY = 1; }
    return { minY, maxY };
  }

  async function loadTemplate(file) {
    // Return a cached template, or the in-flight promise if a load is underway.
    // NOTE: we never cache a permanent `null` on failure — a single transient
    // load error (e.g. an aborted request) must NOT poison the model forever
    // (that was the WARLORD-capsule bug). On failure we drop the entry so the
    // next selection retries cleanly.
    if (file in _cache) return _cache[file];
    let resolve; const inflight = new Promise((r) => (resolve = r));
    _cache[file] = inflight;
    try {
      // No HEAD pre-probe: LoadAssetContainerAsync already errors on a real
      // 404, and the extra HEAD request was racing the GET and getting
      // ERR_ABORTED, which then threw and capsule-locked the villain.
      const container = await BABYLON.SceneLoader.LoadAssetContainerAsync("", file, scene);
      if (!container || !container.meshes || !container.meshes.length) throw new Error("empty container " + file);
      const ext = bboxExtents(container.meshes);
      const natH = ext.maxY - ext.minY;
      const scale = natH > 0.001 ? PODIUM_HEIGHT / natH : 1;
      const yOffset = -ext.minY * scale;
      const tmpl = { container, scale, yOffset };
      _cache[file] = tmpl;
      resolve(tmpl);
      return tmpl;
    } catch (e) {
      console.warn("[lobby3d] model load failed:", e && e.message);
      delete _cache[file]; // allow a later retry instead of permanent capsule
      resolve(null);
      return null;
    }
  }

  function disposeCurrent() {
    currentAnims.forEach((a) => { try { a.stop(); a.dispose(); } catch (_e) {} });
    currentAnims = [];
    if (currentRoot) { try { currentRoot.dispose(); } catch (_e) {} currentRoot = null; }
  }

  function placeholderCapsule() {
    const root = new BABYLON.TransformNode("ph_root", scene);
    const cap = BABYLON.MeshBuilder.CreateCapsule("ph", { height: PODIUM_HEIGHT, radius: 0.7 }, scene);
    cap.parent = root;
    cap.position.y = PODIUM_HEIGHT / 2;
    const mat = new BABYLON.StandardMaterial("ph_mat", scene);
    mat.diffuseColor = new BABYLON.Color3(0.16, 0.11, 0.22);
    mat.emissiveColor = new BABYLON.Color3(0.18, 0.07, 0.32);
    cap.material = mat;
    return root;
  }

  // ---- show a villain by its state object ----------------------------------
  async function showVillain(villain) {
    disposeCurrent();
    if (!villain || villain.locked || !villain.model) {
      currentRoot = placeholderCapsule();
      return;
    }
    const tmpl = await loadTemplate(villain.model);
    // selection may have changed while loading
    if (window.LobbyState && window.LobbyState_getSelected) {
      const sel = window.LobbyState_getSelected();
      if (sel && sel.id !== villain.id) return;
    }
    disposeCurrent();
    if (!tmpl) { currentRoot = placeholderCapsule(); return; }

    try {
      const entries = tmpl.container.instantiateModelsToScene(
        (n) => "villain_" + n, false, { doNotInstantiate: false });
      if (!entries || !entries.rootNodes || !entries.rootNodes.length) {
        currentRoot = placeholderCapsule();
        return;
      }
      const root = new BABYLON.TransformNode("villain_root", scene);
      root.scaling.setAll(tmpl.scale);
      root.position.y = tmpl.yOffset;
      entries.rootNodes.forEach((rn) => {
        rn.parent = root;
        rn.setEnabled(true);
        if (rn.getChildMeshes) rn.getChildMeshes(false).forEach((cm) => (cm.isVisible = true));
      });
      currentRoot = root;
      currentAnims = entries.animationGroups || [];

      // stop everything, then play the idle by index (fall back to anim 0)
      currentAnims.forEach((a) => { try { a.stop(); } catch (_e) {} });
      const idx = Number.isInteger(villain.idleIndex) ? villain.idleIndex : 0;
      const idle = currentAnims[idx] || currentAnims[0];
      if (idle) { try { idle.start(true, 1.0, idle.from, idle.to, false); } catch (_e) {} }
    } catch (e) {
      console.warn("[lobby3d] instantiate failed:", e && e.message);
      disposeCurrent();
      currentRoot = placeholderCapsule();
    }
  }

  // ---- backdrop layer: gothic citadel silhouette + violet glow + halo ------
  function buildBackdropLayer() {
    const W = 1280, H = 640;
    const dt = new BABYLON.DynamicTexture("backdrop", { width: W, height: H }, scene, true);
    const ctx = dt.getContext();

    // base vertical gradient — deep purple/black
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#150B26");
    bg.addColorStop(0.45, "#0E0820");
    bg.addColorStop(1, "#070310");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // big soft violet glow behind the hero (center) + a second on the right (citadel halo)
    const glow1 = ctx.createRadialGradient(W * 0.5, H * 0.42, 30, W * 0.5, H * 0.42, H * 0.62);
    glow1.addColorStop(0, "rgba(150,70,220,0.55)");
    glow1.addColorStop(0.5, "rgba(110,45,180,0.20)");
    glow1.addColorStop(1, "rgba(110,45,180,0)");
    ctx.fillStyle = glow1; ctx.fillRect(0, 0, W, H);

    const glow2 = ctx.createRadialGradient(W * 0.76, H * 0.30, 10, W * 0.76, H * 0.30, H * 0.40);
    glow2.addColorStop(0, "rgba(190,120,255,0.45)");
    glow2.addColorStop(1, "rgba(190,120,255,0)");
    ctx.fillStyle = glow2; ctx.fillRect(0, 0, W, H);

    // glowing halo ring near the citadel spire (like the ref)
    ctx.save();
    ctx.translate(W * 0.76, H * 0.27);
    ctx.scale(1, 0.34);
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(205,140,255,0.85)";
    ctx.shadowColor = "rgba(190,120,255,0.9)";
    ctx.shadowBlur = 34;
    ctx.beginPath(); ctx.arc(0, 0, 70, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // jagged gothic skyline — two depth layers
    function skyline(baseY, peak, color, count) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(0, baseY);
      let x = 0;
      for (let i = 0; i <= count; i++) {
        const seg = W / count;
        const h = peak * (0.35 + Math.abs(Math.sin(i * 1.7 + 0.5)) * 0.65);
        ctx.lineTo(x + seg * 0.5, baseY - h);          // spire tip
        ctx.lineTo(x + seg, baseY - h * 0.18);         // valley
        x += seg;
      }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    }
    // far layer (lighter, hazier)
    skyline(H * 0.74, H * 0.30, "#0B0720", 9);
    // tall central citadel spire cluster (right-of-center, echoing the ref)
    ctx.fillStyle = "#06030f";
    ctx.beginPath();
    ctx.moveTo(W * 0.70, H);
    ctx.lineTo(W * 0.74, H * 0.55);
    ctx.lineTo(W * 0.76, H * 0.16);  // main tip
    ctx.lineTo(W * 0.78, H * 0.55);
    ctx.lineTo(W * 0.82, H);
    ctx.closePath(); ctx.fill();
    // near layer (darkest, foreground ruins)
    skyline(H * 0.86, H * 0.22, "#05030c", 7);

    dt.update();
    const layer = new BABYLON.Layer("bg", null, scene, true);
    layer.texture = dt;
  }

  // ---- rune disc texture: concentric rings, ticks, glyphs ------------------
  function runeDiscTexture() {
    const S = 1024;
    const dt = new BABYLON.DynamicTexture("runeDisc", { width: S, height: S }, scene, true);
    const ctx = dt.getContext();
    ctx.clearRect(0, 0, S, S);
    const cx = S / 2, cy = S / 2;
    const vio = "rgba(180,110,255,";
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(170,90,255,0.9)";

    // concentric rings
    [0.92, 0.80, 0.55, 0.40].forEach((r, i) => {
      ctx.beginPath();
      ctx.lineWidth = i === 0 ? 10 : 5;
      ctx.strokeStyle = vio + (i === 0 ? 0.9 : 0.55) + ")";
      ctx.shadowBlur = 22;
      ctx.arc(cx, cy, (S / 2) * r, 0, Math.PI * 2);
      ctx.stroke();
    });

    // outer tick marks
    ctx.strokeStyle = vio + "0.8)";
    ctx.lineWidth = 5; ctx.shadowBlur = 16;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const r1 = (S / 2) * 0.80, r2 = (S / 2) * (i % 4 === 0 ? 0.90 : 0.86);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }

    // runic glyph marks around the mid band
    ctx.lineWidth = 7; ctx.shadowBlur = 20; ctx.strokeStyle = vio + "0.85)";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r = (S / 2) * 0.675;
      const gx = cx + Math.cos(a) * r, gy = cy + Math.sin(a) * r;
      ctx.save(); ctx.translate(gx, gy); ctx.rotate(a + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(-16, -20); ctx.lineTo(0, 22); ctx.lineTo(16, -20);
      ctx.moveTo(-10, 2); ctx.lineTo(10, 2);
      ctx.stroke();
      ctx.restore();
    }

    // inner star/pentacle lines
    ctx.lineWidth = 4; ctx.shadowBlur = 14; ctx.strokeStyle = vio + "0.5)";
    ctx.beginPath();
    const pr = (S / 2) * 0.40;
    for (let i = 0; i <= 5; i++) {
      const a = (i * 2 / 5) * Math.PI * 2 - Math.PI / 2;
      const px = cx + Math.cos(a) * pr, py = cy + Math.sin(a) * pr;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();

    dt.update();
    dt.hasAlpha = true;
    return dt;
  }

  // ---- ornate animated rune circle under the hero --------------------------
  function buildRuneCircle() {
    // flat glowing rune disc
    const disc = BABYLON.MeshBuilder.CreateCylinder("runeDisc", { diameter: 6.6, height: 0.02, tessellation: 64 }, scene);
    disc.position.y = 0.02;
    const dm = new BABYLON.StandardMaterial("runeDisc_mat", scene);
    const tex = runeDiscTexture();
    dm.diffuseTexture = tex; dm.emissiveTexture = tex; dm.opacityTexture = tex;
    dm.emissiveColor = new BABYLON.Color3(0.7, 0.4, 1.0);
    dm.disableLighting = true;
    dm.backFaceCulling = false;
    disc.material = dm;
    runeRings.push({ mesh: disc, speed: -0.0016 });

    // raised glowing tori (rotating rings)
    const ringSpecs = [
      { d: 6.9, t: 0.06, y: 0.05, c: new BABYLON.Color3(0.78, 0.45, 1.0), s: 0.0030 },
      { d: 5.2, t: 0.045, y: 0.08, c: new BABYLON.Color3(0.62, 0.30, 0.95), s: -0.0050 },
      { d: 3.6, t: 0.035, y: 0.06, c: new BABYLON.Color3(0.85, 0.6, 1.0), s: 0.0070 },
    ];
    ringSpecs.forEach((sp, i) => {
      const ring = BABYLON.MeshBuilder.CreateTorus("rune_ring" + i, { diameter: sp.d, thickness: sp.t, tessellation: 80 }, scene);
      ring.position.y = sp.y;
      const m = new BABYLON.StandardMaterial("rune_ring_mat" + i, scene);
      m.emissiveColor = sp.c; m.disableLighting = true;
      ring.material = m;
      runeRings.push({ mesh: ring, speed: sp.s });
    });

    // dark stone podium beneath the runes for grounding
    podium = BABYLON.MeshBuilder.CreateCylinder("podium", { diameter: 7.2, height: 0.45, tessellation: 64 }, scene);
    podium.position.y = -0.22;
    const pm = new BABYLON.StandardMaterial("podium_mat", scene);
    pm.diffuseColor = new BABYLON.Color3(0.07, 0.05, 0.11);
    pm.specularColor = new BABYLON.Color3(0.25, 0.15, 0.4);
    pm.emissiveColor = new BABYLON.Color3(0.03, 0.01, 0.06);
    podium.material = pm;
  }

  // ---- background 3D spires for parallax depth -----------------------------
  function buildSpires() {
    const mat = new BABYLON.StandardMaterial("spire_mat", scene);
    mat.diffuseColor = new BABYLON.Color3(0.05, 0.035, 0.09);
    mat.specularColor = new BABYLON.Color3(0.18, 0.10, 0.30);
    mat.emissiveColor = new BABYLON.Color3(0.02, 0.01, 0.05);
    const specs = [
      [-13, -20, 18, 1.6], [-8, -24, 26, 1.3], [9, -22, 22, 1.5],
      [14, -19, 16, 1.9], [-18, -16, 13, 2.1], [4, -27, 30, 1.2], [-3, -25, 24, 1.4],
    ];
    specs.forEach((s, i) => {
      const [x, z, h, d] = s;
      const spire = BABYLON.MeshBuilder.CreateCylinder("spire" + i,
        { diameterTop: 0, diameterBottom: d, height: h, tessellation: 5 }, scene);
      spire.position.set(x, h / 2 - 1.2, z);
      spire.material = mat;
    });
  }

  // ---- particle haze drifting upward ---------------------------------------
  function buildHaze() {
    try {
      const tex = new BABYLON.DynamicTexture("haze", { width: 64, height: 64 }, scene, false);
      const c = tex.getContext();
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(200,150,255,1)");
      g.addColorStop(1, "rgba(200,150,255,0)");
      c.fillStyle = g; c.fillRect(0, 0, 64, 64); tex.update();

      const ps = new BABYLON.ParticleSystem("haze", 220, scene);
      ps.particleTexture = tex;
      ps.emitter = new BABYLON.Vector3(0, 0, -2);
      ps.minEmitBox = new BABYLON.Vector3(-9, 0, -10);
      ps.maxEmitBox = new BABYLON.Vector3(9, 0.2, 4);
      ps.color1 = new BABYLON.Color4(0.55, 0.30, 0.85, 0.14);
      ps.color2 = new BABYLON.Color4(0.40, 0.18, 0.70, 0.10);
      ps.colorDead = new BABYLON.Color4(0.2, 0.1, 0.4, 0);
      ps.minSize = 0.8; ps.maxSize = 2.6;
      ps.minLifeTime = 5; ps.maxLifeTime = 10;
      ps.emitRate = 22;
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
      ps.gravity = new BABYLON.Vector3(0, 0.18, 0);
      ps.direction1 = new BABYLON.Vector3(-0.2, 0.5, 0);
      ps.direction2 = new BABYLON.Vector3(0.2, 0.9, 0);
      ps.minEmitPower = 0.2; ps.maxEmitPower = 0.6;
      ps.start();
    } catch (_e) {}
  }

  // ---- environment: dark atmospheric scene + lights ------------------------
  function buildEnvironment() {
    scene.clearColor = new BABYLON.Color4(0.043, 0.027, 0.075, 1); // #0B0713
    // fog for depth (spires fade into the murk)
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogColor = new BABYLON.Color3(0.06, 0.035, 0.11);
    scene.fogDensity = 0.028;

    buildBackdropLayer();
    buildSpires();
    buildRuneCircle();
    buildHaze();

    // lights — cool key (front), violet rim (back), violet uplight at runes
    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.42;
    hemi.diffuse = new BABYLON.Color3(0.62, 0.55, 0.85);
    hemi.groundColor = new BABYLON.Color3(0.18, 0.10, 0.28);

    const key = new BABYLON.DirectionalLight("key", new BABYLON.Vector3(-0.35, -1, 0.55), scene);
    key.position = new BABYLON.Vector3(4, 10, -6);
    key.intensity = 1.15;
    key.diffuse = new BABYLON.Color3(0.95, 0.88, 1.0);

    const rim = new BABYLON.PointLight("rim", new BABYLON.Vector3(0, 5, -6), scene);
    rim.intensity = 1.4;
    rim.diffuse = new BABYLON.Color3(0.70, 0.32, 1.0); // violet back-rim
    rim.range = 30;

    const up = new BABYLON.PointLight("up", new BABYLON.Vector3(0, 0.4, 0), scene);
    up.intensity = 1.1;
    up.diffuse = new BABYLON.Color3(0.62, 0.28, 1.0); // rune uplight
    up.range = 12;

    // glow on all emissive (runes, halo)
    try {
      const gl = new BABYLON.GlowLayer("glow", scene);
      gl.intensity = 0.85;
    } catch (_e) {}
  }

  // ---- drag to rotate ------------------------------------------------------
  function wireDrag(canvas) {
    let dragging = false, lastX = 0;
    const down = (x) => { dragging = true; lastX = x; turntable = false; };
    const move = (x) => {
      if (!dragging || !currentRoot) return;
      const dx = (x - lastX) * 0.01;
      currentRoot.rotation.y -= dx;
      dragVel = -dx;
      lastX = x;
    };
    const up = () => { dragging = false; setTimeout(() => (turntable = true), 2500); };
    canvas.addEventListener("pointerdown", (e) => down(e.clientX));
    window.addEventListener("pointermove", (e) => move(e.clientX));
    window.addEventListener("pointerup", up);
  }

  // ---- public init ---------------------------------------------------------
  function init() {
    const canvas = document.getElementById("renderCanvas");
    engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true });
    scene = new BABYLON.Scene(engine);

    camera = new BABYLON.ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.32, 10.2, new BABYLON.Vector3(0, 1.65, 0), scene);
    camera.lowerRadiusLimit = camera.upperRadiusLimit = 10.2;
    camera.fov = 0.66;
    camera.minZ = 0.1; camera.maxZ = 120;
    // we drive model rotation manually; don't let camera capture pointer
    // (camera.attachControl intentionally NOT called)

    buildEnvironment();
    wireDrag(canvas);

    scene.onBeforeRenderObservable.add(() => {
      // spin the rune rings (independent speeds)
      for (let i = 0; i < runeRings.length; i++) runeRings[i].mesh.rotation.y += runeRings[i].speed;
      // hero turntable / drag inertia
      if (currentRoot) {
        if (turntable) currentRoot.rotation.y += 0.0035;
        else if (Math.abs(dragVel) > 0.0001) {
          currentRoot.rotation.y += dragVel;
          dragVel *= 0.92;
        }
      }
    });

    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    window.GANKScene = { scene: scene, engine: engine }; // compat shim if reused

    // initial villain
    if (window.LobbyState_getSelected) showVillain(window.LobbyState_getSelected());
  }

  window.LobbyScene = { init, showVillain };
})();

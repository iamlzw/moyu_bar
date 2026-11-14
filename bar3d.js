import * as THREE from './three.module.js';

// 摸鱼酒馆 3D scene — binds to window.R3D consumed by index.html.
(function () {
  const canvas = document.getElementById('gl');
  if (!canvas) return;

  // ---------- renderer & scene ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.24;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x140d13);
  scene.fog = new THREE.FogExp2(0x160e15, 0.014);

  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.15, 65);

  // ---------- 4 real lights total (performance budget) ----------
  const hemiLight = new THREE.HemisphereLight(0xa3b9eb, 0x543426, 1.35);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffe0b8, 0.95);
  dirLight.position.set(5, 11, 8);
  scene.add(dirLight);

  const barLight = new THREE.PointLight(0xffb45e, 24, 26, 1.25);
  barLight.position.set(0, 3.25, -4.2);
  scene.add(barLight);

  const spotLight = new THREE.SpotLight(0xffe2ad, 0, 22, 0.44, 0.55, 1.15);
  spotLight.position.set(-4.5, 5.0, -1.5);
  scene.add(spotLight);
  scene.add(spotLight.target);

  // ---------- helpers ----------
  const matCache = new Map();
  function lambert(hex, extra) {
    const key = 'L:' + hex + (extra ? JSON.stringify(extra) : '');
    if (matCache.has(key)) return matCache.get(key);
    const m = new THREE.MeshLambertMaterial(Object.assign({ color: hex }, extra || {}));
    matCache.set(key, m);
    return m;
  }
  function stdMat(hex, rough = 0.72, metal = 0.08, extra) {
    const key = `S:${hex}:${rough}:${metal}:${extra ? JSON.stringify(extra) : ''}`;
    if (matCache.has(key)) return matCache.get(key);
    const m = new THREE.MeshStandardMaterial(Object.assign({ color: hex, roughness: rough, metalness: metal }, extra || {}));
    matCache.set(key, m);
    return m;
  }
  function basicMat(hex, extra) {
    const key = 'B:' + hex + (extra ? JSON.stringify(extra) : '');
    if (matCache.has(key)) return matCache.get(key);
    const m = new THREE.MeshBasicMaterial(Object.assign({ color: hex }, extra || {}));
    matCache.set(key, m);
    return m;
  }

  // Merge simple parts into one non-indexed BufferGeometry with vertex colors.
  function mergeParts(parts) {
    let total = 0;
    const expanded = parts.map(p => {
      const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(p.rot || [0, 0, 0])));
      m.compose(new THREE.Vector3(...(p.pos || [0, 0, 0])), q, new THREE.Vector3(...(p.scale || [1, 1, 1])));
      g.applyMatrix4(m);
      const count = g.attributes.position.count;
      total += count;
      return { g, col: new THREE.Color(p.color ?? 0xffffff), count };
    });
    const pos = new Float32Array(total * 3);
    const norm = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    let off = 0;
    for (const { g, col: c, count } of expanded) {
      pos.set(g.attributes.position.array, off * 3);
      if (g.attributes.normal) norm.set(g.attributes.normal.array, off * 3);
      for (let i = 0; i < count; i++) {
        const k = (off + i) * 3;
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
      off += count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return out;
  }

  function makeCanvasTex(w, h, draw) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------- room architecture ----------
  const ROOM_W = 24, ROOM_D = 20, ROOM_H = 5.4;
  // Floor planks texture
  const floorTex = makeCanvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#3b2419';
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 32) {
      ctx.fillStyle = y % 64 === 0 ? '#42281c' : '#352016';
      ctx.fillRect(0, y, w, 30);
      ctx.fillStyle = '#24140d';
      ctx.fillRect(0, y + 30, w, 2);
      const sx = ((y / 32) * 97) % w;
      ctx.fillRect(sx, y, 2, 30);
    }
  });
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(6, 5);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.78, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), lambert(0x191016));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_H;
  scene.add(ceiling);

  // Ceiling timber beams
  const beamGeo = new THREE.BoxGeometry(ROOM_W, 0.24, 0.28);
  const beamMat = stdMat(0x2d1a12, 0.85, 0.05);
  for (let z = -6.5; z <= 8.5; z += 3.0) {
    const b = new THREE.Mesh(beamGeo, beamMat);
    b.position.set(0, ROOM_H - 0.12, z);
    scene.add(b);
  }

  // Walls: back (-8.5), front (+11.5), left (-12), right (+12)
  const wallMat = lambert(0x3a242c);
  const wainscotMat = stdMat(0x4f2e20, 0.78, 0.05);
  function addWall(w, h, x, y, z, ry) {
    const grp = new THREE.Group();
    const upper = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.2), wallMat);
    const lower = new THREE.Mesh(new THREE.BoxGeometry(w, 1.35, 0.26), wainscotMat);
    lower.position.y = -h / 2 + 0.675;
    grp.add(upper, lower);
    grp.position.set(x, y, z);
    grp.rotation.y = ry;
    scene.add(grp);
  }
  addWall(ROOM_W, ROOM_H, 0, ROOM_H / 2, -8.55, 0);
  addWall(ROOM_W, ROOM_H, 0, ROOM_H / 2, 11.55, Math.PI);
  addWall(ROOM_D, ROOM_H, -12.05, ROOM_H / 2, 1.5, Math.PI / 2);
  addWall(ROOM_D, ROOM_H, 12.05, ROOM_H / 2, 1.5, -Math.PI / 2);

  // ---------- rain windows on left wall ----------
  const rainDrops = [];
  const winGroup = new THREE.Group();
  [-0.8, 3.0, 6.8].forEach(wz => {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.7, 2.3), stdMat(0x231410, 0.7, 0.1));
    frame.position.set(-11.9, 2.6, wz);
    winGroup.add(frame);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(2.05, 2.4), new THREE.MeshBasicMaterial({ color: 0x16263d }));
    pane.rotation.y = Math.PI / 2;
    pane.position.set(-11.82, 2.6, wz);
    winGroup.add(pane);
    // Mullions
    const hbar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 2.1), stdMat(0x2d1b15, 0.7, 0.1));
    hbar.position.set(-11.86, 2.6, wz);
    const vbar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.45, 0.06), stdMat(0x2d1b15, 0.7, 0.1));
    vbar.position.set(-11.86, 2.6, wz);
    winGroup.add(hbar, vbar);
  });
  scene.add(winGroup);

  // Animated rain streaks right inside window glass plane
  const RAIN_N = 90;
  const rainPos = new Float32Array(RAIN_N * 6);
  for (let i = 0; i < RAIN_N; i++) {
    const wz = [-0.8, 3.0, 6.8][i % 3] + (Math.random() - 0.5) * 1.9;
    const wy = 1.45 + Math.random() * 2.3;
    rainDrops.push({ z: wz, y: wy, spd: 2.8 + Math.random() * 1.8, len: 0.16 + Math.random() * 0.15 });
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0x8cb8e8, transparent: true, opacity: 0.48 }));
  scene.add(rainLines);

  // ---------- entrance door (right back wall) ----------
  const doorGroup = new THREE.Group();
  doorGroup.position.set(11.92, 0, -6.2);
  doorGroup.rotation.y = -Math.PI / 2;
  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.85, 0.16), stdMat(0x3a2016, 0.7, 0.1));
  doorFrame.position.y = 1.425;
  const doorPanel = new THREE.Mesh(new THREE.BoxGeometry(1.22, 2.68, 0.1), stdMat(0x522e20, 0.65, 0.1));
  doorPanel.position.y = 1.34;
  const doorGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.9), new THREE.MeshBasicMaterial({ color: 0x3b2618 }));
  doorGlass.position.set(0, 1.85, 0.06);
  const doorLampMat = new THREE.MeshBasicMaterial({ color: 0x553b24 });
  const doorLamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), doorLampMat);
  doorLamp.position.set(0, 3.05, 0.25);
  const doorSignTex = makeCanvasTex(256, 96, (ctx, w, h) => {
    ctx.fillStyle = '#221216'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#d9a441'; ctx.lineWidth = 5; ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.fillStyle = '#ffd27a'; ctx.font = 'bold 42px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('营业中', w / 2, h / 2);
  });
  const doorSign = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.28), new THREE.MeshBasicMaterial({ map: doorSignTex }));
  doorSign.position.set(0, 1.9, 0.07);
  doorGroup.add(doorFrame, doorPanel, doorGlass, doorLamp, doorSign);
  scene.add(doorGroup);
  let doorFlashUntil = 0;

  // ---------- pink "摸鱼" neon sign + clock (17:59) + chalkboard ----------
  const neonTex = makeCanvasTex(512, 192, (ctx, w, h) => {
    ctx.fillStyle = '#140812';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#ff66b2';
    ctx.lineWidth = 8;
    ctx.shadowColor = '#ff4da6';
    ctx.shadowBlur = 18;
    ctx.strokeRect(14, 14, w - 28, h - 28);
    ctx.fillStyle = '#ff94cc';
    ctx.font = 'bold 88px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('摸鱼酒馆', w / 2, h / 2 + 4);
  });
  const neonMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.2), new THREE.MeshBasicMaterial({ map: neonTex }));
  neonMesh.position.set(0, 3.45, -8.38);
  scene.add(neonMesh);

  // Clock stuck at 17:59
  const clockTex = makeCanvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#fbf2df';
    ctx.beginPath(); ctx.arc(128, 128, 118, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#5b3322'; ctx.lineWidth = 14; ctx.stroke();
    ctx.fillStyle = '#2a1b14';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(128 + Math.cos(a) * 94, 128 + Math.sin(a) * 94, i % 3 === 0 ? 7 : 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // 17:59 -> hour hand near 6, minute hand at 59 min
    const ha = ((5 + 59 / 60) / 12) * Math.PI * 2 - Math.PI / 2;
    const ma = (59 / 60) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = '#2a1b14'; ctx.lineCap = 'round';
    ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(128, 128); ctx.lineTo(128 + Math.cos(ha) * 58, 128 + Math.sin(ha) * 58); ctx.stroke();
    ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(128, 128); ctx.lineTo(128 + Math.cos(ma) * 82, 128 + Math.sin(ma) * 82); ctx.stroke();
    ctx.fillStyle = '#c4502f'; ctx.beginPath(); ctx.arc(128, 128, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#7a6250'; ctx.font = 'bold 20px monospace'; ctx.textAlign = 'center'; ctx.fillText('17:59', 128, 178);
  });
  const clockMesh = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshBasicMaterial({ map: clockTex }));
  clockMesh.position.set(-3.35, 3.45, -8.38);
  scene.add(clockMesh);

  // Chalkboard menu
  const chalkTex = makeCanvasTex(384, 288, (ctx, w, h) => {
    ctx.fillStyle = '#1e2b24'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#6c4228'; ctx.lineWidth = 14; ctx.strokeRect(7, 7, w - 14, h - 14);
    ctx.fillStyle = '#f5b860'; ctx.font = 'bold 30px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('今日特调 · 酒单', w / 2, 52);
    ctx.strokeStyle = 'rgba(244,232,214,0.35)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(40, 68); ctx.lineTo(w - 40, 68); ctx.stroke();
    ctx.fillStyle = '#efe6d5'; ctx.font = '21px sans-serif'; ctx.textAlign = 'left';
    ['需求再改一版       18°', '周一综合征         28°', '对齐颗粒度         12°', '明天上线           40°', '下班前五分钟       16°'].forEach((t, idx) => {
      ctx.fillText(t, 38, 110 + idx * 34);
    });
  });
  const chalkMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.7), new THREE.MeshBasicMaterial({ map: chalkTex }));
  chalkMesh.position.set(5.4, 3.0, -8.38);
  scene.add(chalkMesh);

  // ---------- long bar counter, shelves, bottles, hanging glasses, taps, bell, Chen ----------
  const barGroup = new THREE.Group();
  const counterBody = new THREE.Mesh(new THREE.BoxGeometry(12.6, 1.04, 0.95), stdMat(0x4b2b1d, 0.78, 0.05));
  counterBody.position.set(0, 0.52, -5.2);
  const counterTop = new THREE.Mesh(new THREE.BoxGeometry(12.9, 0.1, 1.15), stdMat(0x704129, 0.45, 0.1));
  counterTop.position.set(0, 1.07, -5.2);
  const footRail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 12.4, 8), stdMat(0xd9a441, 0.3, 0.8));
  footRail.rotation.z = Math.PI / 2;
  footRail.position.set(0, 0.22, -4.55);
  const underGlow = new THREE.Mesh(new THREE.BoxGeometry(12.2, 0.06, 0.05), basicMat(0xf59e42));
  underGlow.position.set(0, 0.96, -4.71);
  barGroup.add(counterBody, counterTop, footRail, underGlow);

  // Back shelves
  for (let row = 0; row < 3; row++) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.08, 0.45), stdMat(0x5b3322, 0.65, 0.08));
    shelf.position.set(0, 1.35 + row * 0.62, -8.2);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.04, 0.04), basicMat(0xffbe66));
    strip.position.set(0, 1.40 + row * 0.62, -8.38);
    barGroup.add(shelf, strip);
  }
  const backCounter = new THREE.Mesh(new THREE.BoxGeometry(9.4, 1.0, 0.75), stdMat(0x3f2317, 0.78, 0.05));
  backCounter.position.set(0, 0.5, -8.05);
  barGroup.add(backCounter);

  // Instanced liquor bottles on the 3 shelves
  const bottleGeo = new THREE.CylinderGeometry(0.055, 0.065, 0.34, 7);
  const bottleInst = new THREE.InstancedMesh(bottleGeo, stdMat(0xffffff, 0.25, 0.1), 45);
  const bCols = [0x3b8a57, 0xd4822a, 0x9c2c37, 0x2f5d8c, 0xd8b84b, 0x6b3a7d];
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 45; i++) {
    const row = Math.floor(i / 15), col = i % 15;
    dummy.position.set(-4.0 + col * 0.56 + ((row % 2) * 0.14), 1.56 + row * 0.62, -8.18 + (i % 3) * 0.04);
    dummy.scale.set(1, 0.85 + (i % 4) * 0.12, 1);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    bottleInst.setMatrixAt(i, dummy.matrix);
    bottleInst.setColorAt(i, new THREE.Color(bCols[i % bCols.length]));
  }
  bottleInst.instanceMatrix.needsUpdate = true;
  if (bottleInst.instanceColor) bottleInst.instanceColor.needsUpdate = true;
  barGroup.add(bottleInst);

  // Inverted hanging glasses rack above bar
  const rack = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.08, 0.75), stdMat(0x523020, 0.6, 0.2));
  rack.position.set(0, 2.85, -5.2);
  barGroup.add(rack);
  for (const rx of [-3.4, 0, 3.4]) {
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.55, 6), stdMat(0xd9a441, 0.35, 0.8));
    rod.position.set(rx, 4.12, -5.2);
    barGroup.add(rod);
  }
  const hangGlassGeo = new THREE.ConeGeometry(0.09, 0.19, 8);
  const hangGlassInst = new THREE.InstancedMesh(hangGlassGeo, stdMat(0xdbeaf5, 0.15, 0.2, { transparent: true, opacity: 0.72 }), 24);
  for (let i = 0; i < 24; i++) {
    const row = Math.floor(i / 12), col = i % 12;
    dummy.position.set(-3.3 + col * 0.6, 2.71, -5.0 + row * -0.4);
    dummy.rotation.set(Math.PI, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    hangGlassInst.setMatrixAt(i, dummy.matrix);
  }
  hangGlassInst.instanceMatrix.needsUpdate = true;
  barGroup.add(hangGlassInst);

  // Beer taps on bar counter
  const tapBase = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 0.16), stdMat(0xd9a441, 0.3, 0.85));
  tapBase.position.set(-2.3, 1.32, -5.25);
  barGroup.add(tapBase);
  [-0.18, 0, 0.18].forEach((ox, idx) => {
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.22, 6), stdMat([0x2a1b14, 0xc4502f, 0xf2d06b][idx], 0.4, 0.3));
    h.position.set(-2.3 + ox, 1.62, -5.2);
    h.rotation.x = 0.22;
    barGroup.add(h);
  });

  // Copper bell hanging over bar
  const bellPivot = new THREE.Group();
  bellPivot.position.set(2.35, 2.65, -4.95);
  const bellRope = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.45, 6), stdMat(0x7a5c3c, 0.8, 0.1));
  bellRope.position.y = 0.2;
  const bellBody = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.22, 12, 1, true), stdMat(0xe5b450, 0.25, 0.88, { side: THREE.DoubleSide }));
  bellBody.position.y = -0.05;
  bellPivot.add(bellRope, bellBody);
  barGroup.add(bellPivot);
  let bellSwingUntil = 0;

  // Pendant lamps over bar (raised slightly so they don't block wall clock/neon)
  for (const lx of [-4.6, 0, 4.6]) {
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.35, 6), lambert(0x1a1210));
    cord.position.set(lx, 4.72, -5.0);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.2, 10, 1, true), stdMat(0x2d1a14, 0.5, 0.4, { side: THREE.DoubleSide }));
    shade.position.set(lx, 4.02, -5.0);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), basicMat(0xffd280));
    bulb.position.set(lx, 3.94, -5.0);
    barGroup.add(cord, shade, bulb);
  }
  scene.add(barGroup);

  // Bartender Chen (老陈) behind the bar
  const chenGroup = new THREE.Group();
  chenGroup.position.set(0, 0, -6.45);
  const chenTorso = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.72, 8), lambert(0xeee5d8));
  chenTorso.position.y = 1.05;
  const chenApron = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.62, 0.12), lambert(0x332018));
  chenApron.position.set(0, 0.98, 0.21);
  const chenHead = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), lambert(0xf0c7a4));
  chenHead.position.y = 1.62;
  const chenHair = new THREE.Mesh(new THREE.SphereGeometry(0.248, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), lambert(0x2a1d19));
  chenHair.position.y = 1.65;
  const chenEyeL = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), lambert(0x1a1414));
  chenEyeL.position.set(-0.08, 1.63, 0.22);
  const chenEyeR = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), lambert(0x1a1414));
  chenEyeR.position.set(0.08, 1.63, 0.22);
  const chenStache = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.035, 0.04), lambert(0x2a1d19));
  chenStache.position.set(0, 1.54, 0.23);
  const chenBow = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.05), lambert(0xa83232));
  chenBow.position.set(0, 1.38, 0.22);
  const chenArmL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 0.12), lambert(0xeee5d8));
  chenArmL.position.set(-0.32, 1.15, 0.12);
  const chenArmR = new THREE.Group();
  chenArmR.position.set(0.32, 1.28, 0.12);
  const chenArmRMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 0.12), lambert(0xeee5d8));
  chenArmRMesh.position.y = -0.15;
  const shaker = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.045, 0.22, 8), stdMat(0xd5dde5, 0.22, 0.9));
  shaker.position.set(0, -0.32, 0.15);
  chenArmR.add(chenArmRMesh, shaker);
  chenGroup.add(chenTorso, chenApron, chenHead, chenHair, chenEyeL, chenEyeR, chenStache, chenBow, chenArmL, chenArmR);
  scene.add(chenGroup);
  let chenShakeUntil = 0;

  // ---------- corner stage + band + jukebox ----------
  const stageGroup = new THREE.Group();
  stageGroup.position.set(-9.2, 0, -5.8);
  stageGroup.rotation.y = 0.58;
  const stageBase = new THREE.Mesh(new THREE.CylinderGeometry(2.35, 2.45, 0.36, 16), stdMat(0x3c2119, 0.72, 0.1));
  stageBase.position.y = 0.18;
  const stageTrim = new THREE.Mesh(new THREE.TorusGeometry(2.35, 0.04, 6, 28), basicMat(0xf5b860));
  stageTrim.rotation.x = Math.PI / 2;
  stageTrim.position.y = 0.36;
  const micStand = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.32, 6), stdMat(0xbfc7cf, 0.3, 0.85));
  micStand.position.set(0, 1.02, 1.05);
  const micHead = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), stdMat(0x2a2a30, 0.4, 0.7));
  micHead.position.set(0, 1.68, 1.05);
  stageGroup.add(stageBase, stageTrim, micStand, micHead);

  // Band members (2 low-poly musicians: keyboardist + bassist)
  function makeBandMate(x, z, col) {
    const g = new THREE.Group();
    g.position.set(x, 0.36, z);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.21, 0.55, 8), lambert(col));
    body.position.y = 0.48;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), lambert(0xf2d1b3));
    head.position.y = 0.94;
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.1, 10), lambert(0x1f1922));
    hat.position.y = 1.12;
    g.add(body, head, hat);
    return g;
  }
  const keyPlayer = makeBandMate(-0.95, -0.45, 0x3b4d73);
  const keyboard = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.1, 0.35), stdMat(0x1c1c22, 0.5, 0.3));
  keyboard.position.set(-0.95, 0.9, 0.02);
  const kbStand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.54, 0.1), lambert(0x19191e));
  kbStand.position.set(-0.95, 0.63, 0.02);

  const bassPlayer = makeBandMate(0.95, -0.5, 0x703448);
  const bassBody = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.07), stdMat(0x8c3b20, 0.45, 0.2));
  bassBody.position.set(0.02, 0.44, 0.2);
  bassBody.rotation.z = -0.55;
  const bassNeck = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.56, 0.04), stdMat(0xd9b382, 0.5, 0.1));
  bassNeck.position.set(0.22, 0.69, 0.2);
  bassNeck.rotation.z = -0.55;
  bassPlayer.add(bassBody, bassNeck);
  stageGroup.add(keyPlayer, keyboard, kbStand, bassPlayer);

  // Disco mirror ball above center floor (only spins/shows on disco track)
  const discoBall = new THREE.Mesh(new THREE.IcosahedronGeometry(0.38, 1), stdMat(0xe8eef8, 0.1, 0.95, { flatShading: true }));
  discoBall.position.set(0, 4.65, 2.2);
  discoBall.visible = false;
  scene.add(discoBall);
  scene.add(stageGroup);

  // Stage microphone world position for performing guest (standing right behind micStand at z=0.62)
  stageGroup.updateMatrixWorld(true);
  const STAGE_SPOT_WORLD = new THREE.Vector3(0, 0.36, 0.58);
  stageGroup.localToWorld(STAGE_SPOT_WORLD);
  const STAGE_FACING = stageGroup.rotation.y;

  // Jukebox on back-right wall
  const jukeboxGroup = new THREE.Group();
  jukeboxGroup.position.set(8.8, 0, -7.85);
  const jbBody = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.45, 0.68), stdMat(0x4d281b, 0.6, 0.15));
  jbBody.position.y = 0.725;
  const jbArch = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.68, 16, 1, false, 0, Math.PI), stdMat(0x5d3020, 0.5, 0.2));
  jbArch.rotation.z = Math.PI / 2;
  jbArch.rotation.y = Math.PI / 2;
  jbArch.position.y = 1.45;
  const jbGlowMat = new THREE.MeshBasicMaterial({ color: 0xf5b860 });
  const jbGlow = new THREE.Mesh(new THREE.TorusGeometry(0.51, 0.055, 8, 20, Math.PI), jbGlowMat);
  jbGlow.position.set(0, 1.44, 0.35);
  const jbScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.52), jbGlowMat);
  jbScreen.position.set(0, 1.15, 0.35);
  jukeboxGroup.add(jbBody, jbArch, jbGlow, jbScreen);
  scene.add(jukeboxGroup);

  // ---------- 100 seats layout (0-15 bar, 16-63 round tables, 64-99 booths) ----------
  const SEATS = []; // { x, z, rot, tableX, tableZ, tableY }

  // 0..15: 16 bar stools along Z = -3.85, ordered center-outward so solo/small crowds gather near Bartender Chen
  for (let i = 0; i < 16; i++) {
    const step = Math.floor(i / 2);
    const slot = i % 2 === 0 ? (7 - step) : (8 + step);
    const x = -5.75 + slot * (11.5 / 15);
    SEATS.push({ x, z: -3.9, rot: Math.PI, tx: x, tz: -4.85, ty: 1.12 });
  }

  // 16..63: 12 high round tables (3 cols x 4 rows), 4 seats each
  const tableCenters = [];
  const tCols = [-4.8, -0.5, 3.8], tRows = [-0.8, 2.0, 4.8, 7.6];
  for (const tz of tRows) {
    for (const tx of tCols) {
      tableCenters.push([tx, tz]);
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2 + Math.PI / 4;
        const sx = tx + Math.cos(a) * 1.02;
        const sz = tz + Math.sin(a) * 1.02;
        const rot = Math.atan2(tx - sx, tz - sz);
        SEATS.push({ x: sx, z: sz, rot, tx: tx + Math.cos(a) * 0.36, tz: tz + Math.sin(a) * 0.36, ty: 0.98 });
      }
    }
  }

  // 64..99: 6 booths along right wall (X = 9.5), 6 seats each (3 per facing bench)
  const boothZs = [-2.0, 0.2, 2.4, 4.6, 6.8, 9.0];
  for (const bz of boothZs) {
    for (let side = 0; side < 2; side++) {
      const sz = bz + (side === 0 ? -0.68 : 0.68);
      const rot = side === 0 ? 0 : Math.PI;
      for (let k = 0; k < 3; k++) {
        const sx = 8.65 + k * 0.85;
        SEATS.push({ x: sx, z: sz, rot, tx: sx, tz: bz + (side === 0 ? -0.22 : 0.22), ty: 0.72 });
      }
    }
  }

  // Instanced bar & table stools (seats 0..63)
  const stoolSeatGeo = new THREE.CylinderGeometry(0.24, 0.22, 0.09, 10);
  const stoolLegGeo = new THREE.CylinderGeometry(0.045, 0.14, 0.68, 8);
  const stoolTops = new THREE.InstancedMesh(stoolSeatGeo, stdMat(0x7d3b2b, 0.6, 0.1), 64);
  const stoolLegs = new THREE.InstancedMesh(stoolLegGeo, stdMat(0x2a1d19, 0.5, 0.6), 64);
  for (let i = 0; i < 64; i++) {
    const s = SEATS[i];
    const h = i < 16 ? 0.72 : 0.66;
    dummy.position.set(s.x, h, s.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    stoolTops.setMatrixAt(i, dummy.matrix);
    dummy.position.set(s.x, h / 2, s.z);
    dummy.scale.set(1, h / 0.68, 1);
    dummy.updateMatrix();
    stoolLegs.setMatrixAt(i, dummy.matrix);
  }
  stoolTops.instanceMatrix.needsUpdate = true;
  stoolLegs.instanceMatrix.needsUpdate = true;
  scene.add(stoolTops, stoolLegs);

  // Instanced high round tables (12) + pendant bulbs above them
  const hTableTop = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.62, 0.62, 0.08, 14), stdMat(0x633924, 0.5, 0.1), 12);
  const hTableLeg = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.26, 0.94, 8), stdMat(0x251b18, 0.5, 0.7), 12);
  const hTableBulb = new THREE.InstancedMesh(new THREE.SphereGeometry(0.08, 8, 6), basicMat(0xffcc77), 12);
  const hTableShade = new THREE.InstancedMesh(new THREE.ConeGeometry(0.22, 0.18, 8, 1, true), stdMat(0x3a2016, 0.6, 0.3, { side: THREE.DoubleSide }), 12);
  tableCenters.forEach(([tx, tz], i) => {
    dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
    dummy.position.set(tx, 0.94, tz); dummy.updateMatrix(); hTableTop.setMatrixAt(i, dummy.matrix);
    dummy.position.set(tx, 0.47, tz); dummy.updateMatrix(); hTableLeg.setMatrixAt(i, dummy.matrix);
    dummy.position.set(tx, 4.12, tz); dummy.updateMatrix(); hTableBulb.setMatrixAt(i, dummy.matrix);
    dummy.position.set(tx, 4.20, tz); dummy.updateMatrix(); hTableShade.setMatrixAt(i, dummy.matrix);
  });
  [hTableTop, hTableLeg, hTableBulb, hTableShade].forEach(m => { m.instanceMatrix.needsUpdate = true; scene.add(m); });

  // Instanced booths (6 low tables + 12 upholstered sofas)
  const bTableInst = new THREE.InstancedMesh(new THREE.BoxGeometry(2.6, 0.08, 0.72), stdMat(0x5c3422, 0.5, 0.1), 6);
  const bBaseInst = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 0.66, 0.28), stdMat(0x291a16, 0.6, 0.2), 6);
  const bSofaInst = new THREE.InstancedMesh(new THREE.BoxGeometry(2.7, 0.54, 0.52), stdMat(0x6b2833, 0.85, 0.04), 12);
  const bBackInst = new THREE.InstancedMesh(new THREE.BoxGeometry(2.7, 0.52, 0.14), stdMat(0x562029, 0.85, 0.04), 12);
  boothZs.forEach((bz, i) => {
    dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
    dummy.position.set(9.5, 0.68, bz); dummy.updateMatrix(); bTableInst.setMatrixAt(i, dummy.matrix);
    dummy.position.set(9.5, 0.34, bz); dummy.updateMatrix(); bBaseInst.setMatrixAt(i, dummy.matrix);
    for (let s = 0; s < 2; s++) {
      const idx = i * 2 + s;
      const dz = s === 0 ? -0.7 : 0.7;
      dummy.position.set(9.5, 0.27, bz + dz); dummy.updateMatrix(); bSofaInst.setMatrixAt(idx, dummy.matrix);
      dummy.position.set(9.5, 0.72, bz + (s === 0 ? -0.92 : 0.92)); dummy.updateMatrix(); bBackInst.setMatrixAt(idx, dummy.matrix);
    }
  });
  [bTableInst, bBaseInst, bSofaInst, bBackInst].forEach(m => { m.instanceMatrix.needsUpdate = true; scene.add(m); });

  // Hover highlight ring + self marker ring
  const hoverRing = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.36, 18),
    new THREE.MeshBasicMaterial({ color: 0xffcf6e, side: THREE.DoubleSide, transparent: true, opacity: 0.88 })
  );
  hoverRing.rotation.x = -Math.PI / 2;
  hoverRing.visible = false;
  scene.add(hoverRing);

  const selfHalo = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.34, 20),
    new THREE.MeshBasicMaterial({ color: 0xffcf6e, side: THREE.DoubleSide, transparent: true, opacity: 0.45 })
  );
  selfHalo.rotation.x = -Math.PI / 2;
  selfHalo.position.y = 0.02;
  scene.add(selfHalo);

  // Invisible raycast hit spheres for all 100 seats
  const seatHits = [];
  const hitGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.85, 8);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  for (let i = 0; i < SEATS.length; i++) {
    const h = new THREE.Mesh(hitGeo, hitMat);
    h.position.set(SEATS[i].x, 0.55, SEATS[i].z);
    h.userData.seat = i;
    scene.add(h);
    seatHits.push(h);
  }

  // ---------- 16 low-poly animal head features ----------
  // Head main sphere uses guest's color; faceMesh merges eyes, ears, snout/beak with vertexColors.
  const headSphereGeo = new THREE.SphereGeometry(0.25, 12, 10);
  const bodyGeo = new THREE.CylinderGeometry(0.14, 0.18, 0.38, 8);
  const armGeo = new THREE.BoxGeometry(0.085, 0.34, 0.085);
  armGeo.translate(0, -0.14, 0);

  function buildAnimalFaceGeo(idx) {
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const sph = (r) => new THREE.SphereGeometry(r, 8, 6);
    const con = (r, h) => new THREE.ConeGeometry(r, h, 6);
    const parts = [];
    // Default eyes
    const eyeY = 0.03, eyeZ = 0.21;
    if (idx !== 6 && idx !== 15 && idx !== 10) {
      parts.push({ geo: sph(0.032), pos: [-0.09, eyeY, eyeZ], color: 0x1a1414 });
      parts.push({ geo: sph(0.032), pos: [0.09, eyeY, eyeZ], color: 0x1a1414 });
    }
    switch (idx) {
      case 0: // 水豚 capybara: boxy snout + small top ears
        parts.push({ geo: box(0.2, 0.14, 0.18), pos: [0, -0.04, 0.22], color: 0x8a6448 });
        parts.push({ geo: sph(0.025), pos: [0, -0.01, 0.31], color: 0x2a1b14 });
        parts.push({ geo: sph(0.055), pos: [-0.17, 0.2, -0.04], color: 0x6b4b35 });
        parts.push({ geo: sph(0.055), pos: [0.17, 0.2, -0.04], color: 0x6b4b35 });
        break;
      case 1: // 柯基 corgi: big pointy ears + cream muzzle
        parts.push({ geo: con(0.085, 0.2), pos: [-0.14, 0.28, 0], rot: [0, 0, 0.25], color: 0xd98a42 });
        parts.push({ geo: con(0.085, 0.2), pos: [0.14, 0.28, 0], rot: [0, 0, -0.25], color: 0xd98a42 });
        parts.push({ geo: sph(0.09), pos: [0, -0.06, 0.21], scale: [1.2, 0.85, 1], color: 0xfbf0dc });
        parts.push({ geo: sph(0.026), pos: [0, -0.03, 0.3], color: 0x1a1414 });
        break;
      case 2: // 树懒 sloth: cream face + dark eye patches
        parts.push({ geo: sph(0.16), pos: [0, -0.01, 0.12], scale: [1.15, 0.95, 0.6], color: 0xf0e2cc });
        parts.push({ geo: box(0.09, 0.06, 0.05), pos: [-0.08, 0.03, 0.21], rot: [0, 0, 0.25], color: 0x4b382d });
        parts.push({ geo: box(0.09, 0.06, 0.05), pos: [0.08, 0.03, 0.21], rot: [0, 0, -0.25], color: 0x4b382d });
        parts.push({ geo: sph(0.028), pos: [0, -0.03, 0.23], color: 0x221713 });
        break;
      case 3: // 考拉 koala: huge round fluffy ears + oval nose
        parts.push({ geo: sph(0.125), pos: [-0.24, 0.09, -0.02], scale: [0.95, 1, 0.6], color: 0x9aa3ab });
        parts.push({ geo: sph(0.125), pos: [0.24, 0.09, -0.02], scale: [0.95, 1, 0.6], color: 0x9aa3ab });
        parts.push({ geo: sph(0.075), pos: [-0.24, 0.09, 0.02], scale: [0.8, 0.9, 0.4], color: 0xf4e8dc });
        parts.push({ geo: sph(0.075), pos: [0.24, 0.09, 0.02], scale: [0.8, 0.9, 0.4], color: 0xf4e8dc });
        parts.push({ geo: box(0.075, 0.11, 0.07), pos: [0, -0.02, 0.24], color: 0x2a2428 });
        break;
      case 4: // 仓鼠 hamster: chubby cheeks + tiny round ears
        parts.push({ geo: sph(0.095), pos: [-0.14, -0.06, 0.16], color: 0xf6dfc2 });
        parts.push({ geo: sph(0.095), pos: [0.14, -0.06, 0.16], color: 0xf6dfc2 });
        parts.push({ geo: sph(0.065), pos: [-0.17, 0.21, 0], color: 0xd99b66 });
        parts.push({ geo: sph(0.065), pos: [0.17, 0.21, 0], color: 0xd99b66 });
        parts.push({ geo: sph(0.024), pos: [0, -0.03, 0.26], color: 0xe88a96 });
        break;
      case 5: // 鸽子 pigeon: orange/grey beak + white neck collar
        parts.push({ geo: con(0.055, 0.14), pos: [0, -0.03, 0.28], rot: [Math.PI / 2, 0, 0], color: 0xe6a145 });
        parts.push({ geo: box(0.24, 0.04, 0.24), pos: [0, -0.19, 0], color: 0xf4f4f6 });
        break;
      case 6: // 猫头鹰 owl: big bright eyes + ear tufts + yellow beak
        parts.push({ geo: sph(0.078), pos: [-0.09, 0.04, 0.2], scale: [1, 1, 0.5], color: 0xf8e9c4 });
        parts.push({ geo: sph(0.078), pos: [0.09, 0.04, 0.2], scale: [1, 1, 0.5], color: 0xf8e9c4 });
        parts.push({ geo: sph(0.038), pos: [-0.09, 0.04, 0.235], color: 0x151216 });
        parts.push({ geo: sph(0.038), pos: [0.09, 0.04, 0.235], color: 0x151216 });
        parts.push({ geo: con(0.045, 0.11), pos: [0, -0.03, 0.26], rot: [Math.PI / 2, 0, 0], color: 0xf0aa33 });
        parts.push({ geo: con(0.06, 0.14), pos: [-0.16, 0.25, 0], rot: [0, 0, 0.3], color: 0x5c4230 });
        parts.push({ geo: con(0.06, 0.14), pos: [0.16, 0.25, 0], rot: [0, 0, -0.3], color: 0x5c4230 });
        break;
      case 7: // 海獭 otter: round ears + pale snout + pink nose
        parts.push({ geo: sph(0.06), pos: [-0.19, 0.16, -0.02], color: 0x6b4d3b });
        parts.push({ geo: sph(0.06), pos: [0.19, 0.16, -0.02], color: 0x6b4d3b });
        parts.push({ geo: sph(0.11), pos: [0, -0.05, 0.19], scale: [1.25, 0.85, 0.8], color: 0xf0dec6 });
        parts.push({ geo: sph(0.032), pos: [0, -0.02, 0.27], color: 0x2a1c19 });
        break;
      case 8: // 羊驼 alpaca: tall ears + fluffy top puff
        parts.push({ geo: sph(0.12), pos: [0, 0.24, 0.03], scale: [1.1, 0.7, 1.0], color: 0xf7efe4 });
        parts.push({ geo: con(0.055, 0.22), pos: [-0.13, 0.3, -0.02], rot: [0, 0, 0.18], color: 0xf0e4d2 });
        parts.push({ geo: con(0.055, 0.22), pos: [0.13, 0.3, -0.02], rot: [0, 0, -0.18], color: 0xf0e4d2 });
        parts.push({ geo: sph(0.095), pos: [0, -0.05, 0.21], color: 0xfbf4ea });
        parts.push({ geo: sph(0.024), pos: [0, -0.03, 0.3], color: 0x261d1c });
        break;
      case 9: // 企鹅 penguin: white face mask + orange beak
        parts.push({ geo: sph(0.17), pos: [0, -0.02, 0.12], scale: [1.05, 0.98, 0.62], color: 0xfbf9f6 });
        parts.push({ geo: con(0.055, 0.14), pos: [0, -0.05, 0.27], rot: [Math.PI / 2, 0, 0], color: 0xf08a24 });
        break;
      case 10: // 浣熊 raccoon: dark mask + pointy ears
        parts.push({ geo: box(0.28, 0.09, 0.08), pos: [0, 0.03, 0.21], color: 0x262228 });
        parts.push({ geo: sph(0.03), pos: [-0.09, 0.03, 0.255], color: 0xffffff });
        parts.push({ geo: sph(0.03), pos: [0.09, 0.03, 0.255], color: 0xffffff });
        parts.push({ geo: con(0.075, 0.16), pos: [-0.15, 0.26, 0], rot: [0, 0, 0.25], color: 0x454148 });
        parts.push({ geo: con(0.075, 0.16), pos: [0.15, 0.26, 0], rot: [0, 0, -0.25], color: 0x454148 });
        parts.push({ geo: sph(0.08), pos: [0, -0.06, 0.22], color: 0xe6e0d8 });
        parts.push({ geo: sph(0.025), pos: [0, -0.03, 0.3], color: 0x141216 });
        break;
      case 11: // 河马 hippo: huge wide muzzle + tiny top ears
        parts.push({ geo: sph(0.15), pos: [0, -0.07, 0.21], scale: [1.25, 0.78, 0.9], color: 0xb69bb0 });
        parts.push({ geo: sph(0.026), pos: [-0.06, -0.02, 0.33], color: 0x3b2a36 });
        parts.push({ geo: sph(0.026), pos: [0.06, -0.02, 0.33], color: 0x3b2a36 });
        parts.push({ geo: sph(0.05), pos: [-0.15, 0.22, -0.04], color: 0x8e7288 });
        parts.push({ geo: sph(0.05), pos: [0.15, 0.22, -0.04], color: 0x8e7288 });
        break;
      case 12: // 柴犬 shiba: pointy ears + cream cheeks + eyebrows
        parts.push({ geo: con(0.08, 0.18), pos: [-0.14, 0.27, 0], rot: [0, 0, 0.2], color: 0xd9873b });
        parts.push({ geo: con(0.08, 0.18), pos: [0.14, 0.27, 0], rot: [0, 0, -0.2], color: 0xd9873b });
        parts.push({ geo: sph(0.11), pos: [0, -0.07, 0.19], scale: [1.25, 0.82, 0.85], color: 0xfbf0dc });
        parts.push({ geo: sph(0.028), pos: [-0.08, 0.09, 0.21], color: 0xfbf0dc });
        parts.push({ geo: sph(0.028), pos: [0.08, 0.09, 0.21], color: 0xfbf0dc });
        parts.push({ geo: sph(0.024), pos: [0, -0.03, 0.28], color: 0x1b1514 });
        break;
      case 13: // 刺猬 hedgehog: spiky back + pointy nose
        parts.push({ geo: new THREE.IcosahedronGeometry(0.26, 0), pos: [0, 0.05, -0.08], scale: [1.05, 1.05, 1.15], color: 0x6b4a36 });
        parts.push({ geo: con(0.06, 0.15), pos: [0, -0.05, 0.27], rot: [Math.PI / 2, 0, 0], color: 0xf0d6b8 });
        parts.push({ geo: sph(0.024), pos: [0, -0.05, 0.34], color: 0x1a1414 });
        break;
      case 14: // 鹦鹉 parrot: bright crest + curved yellow beak
        parts.push({ geo: con(0.065, 0.18), pos: [0, 0.29, 0.02], rot: [-0.25, 0, 0], color: 0xe64c4c });
        parts.push({ geo: con(0.06, 0.16), pos: [0, -0.03, 0.27], rot: [Math.PI / 2 + 0.25, 0, 0], color: 0xf5b832 });
        break;
      case 15: // 熊猫 panda: black ears + black eye patches + white head feel
        parts.push({ geo: sph(0.085), pos: [-0.18, 0.22, 0], color: 0x1a181c });
        parts.push({ geo: sph(0.085), pos: [0.18, 0.22, 0], color: 0x1a181c });
        parts.push({ geo: sph(0.068), pos: [-0.09, 0.03, 0.2], scale: [1, 1.25, 0.45], color: 0x1a181c });
        parts.push({ geo: sph(0.068), pos: [0.09, 0.03, 0.2], scale: [1, 1.25, 0.45], color: 0x1a181c });
        parts.push({ geo: sph(0.022), pos: [-0.09, 0.04, 0.235], color: 0xffffff });
        parts.push({ geo: sph(0.022), pos: [0.09, 0.04, 0.235], color: 0xffffff });
        parts.push({ geo: sph(0.03), pos: [0, -0.04, 0.25], color: 0x1a181c });
        break;
    }
    return mergeParts(parts);
  }

  const faceGeos = Array.from({ length: 16 }, (_, i) => buildAnimalFaceGeo(i));
  const faceMat = new THREE.MeshLambertMaterial({ vertexColors: true });

  // Drink glass & shot glass & dice cup shared geometries
  const glassShellGeo = new THREE.CylinderGeometry(0.085, 0.065, 0.21, 10, 1, true);
  const glassShellMat = stdMat(0xe8f3fb, 0.12, 0.15, { transparent: true, opacity: 0.45, side: THREE.DoubleSide });
  const glassBaseGeo = new THREE.CylinderGeometry(0.065, 0.065, 0.02, 10);
  const liquidGeo = new THREE.CylinderGeometry(0.074, 0.056, 0.17, 10);
  liquidGeo.translate(0, 0.085, 0);

  const shotGlassGeo = new THREE.CylinderGeometry(0.048, 0.036, 0.11, 8);
  const diceCupGeo = new THREE.CylinderGeometry(0.058, 0.072, 0.15, 10);
  const diceCupMat = stdMat(0x281814, 0.7, 0.15);
  const dieGeo = new THREE.BoxGeometry(0.036, 0.036, 0.036);
  const dieMat = lambert(0xfbf3e6);

  // ---------- guest instances management ----------
  const guestNodes = new Map(); // id -> rig object
  const guestHitMeshes = [];    // interactive meshes for raycast (own glass, shot, dice cup)

  function makeDrinkTexture(colors) {
    return makeCanvasTex(32, 64, (ctx, w, h) => {
      const n = colors.length;
      const step = h / n;
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = colors[n - 1 - i];
        ctx.fillRect(0, i * step, w, step + 1);
      }
    });
  }
  const drinkMats = DRINKS.map(d => new THREE.MeshBasicMaterial({ map: makeDrinkTexture(d.c) }));

  function buildGuestRig(g) {
    const root = new THREE.Group();
    const bodyPivot = new THREE.Group();
    root.add(bodyPivot);

    const furCol = g.n === 15 ? 0xf6f3ee : COLORS[g.c % COLORS.length];
    const furMat = lambert(furCol);
    const bodyMat = lambert(COLORS[(g.c + 3) % COLORS.length]);

    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.19;
    bodyPivot.add(body);

    const armL = new THREE.Mesh(armGeo, bodyMat);
    armL.position.set(-0.18, 0.34, 0.02);
    const armR = new THREE.Mesh(armGeo, bodyMat);
    armR.position.set(0.18, 0.34, 0.02);
    bodyPivot.add(armL, armR);

    const headPivot = new THREE.Group();
    headPivot.position.y = 0.56;
    const head = new THREE.Mesh(headSphereGeo, furMat);
    const face = new THREE.Mesh(faceGeos[g.a >= 0 ? (g.n % 16) : 0], faceMat);
    headPivot.add(head, face);
    bodyPivot.add(headPivot);

    // Drink glass (placed on table/bar in front of guest, or lifted by arm during toast)
    const tableProps = new THREE.Group();
    const glassGrp = new THREE.Group();
    const glassRim = new THREE.Mesh(glassShellGeo, glassShellMat);
    glassRim.position.y = 0.105;
    const glassFoot = new THREE.Mesh(glassBaseGeo, glassShellMat);
    glassFoot.position.y = 0.01;
    const liquid = new THREE.Mesh(liquidGeo, drinkMats[0]);
    liquid.position.y = 0.02;
    liquid.visible = false;
    glassGrp.add(glassRim, glassFoot, liquid);
    tableProps.add(glassGrp);

    // Shot glass next to main glass
    const shotGrp = new THREE.Group();
    shotGrp.position.set(0.18, 0, -0.02);
    const shotMesh = new THREE.Mesh(shotGlassGeo, lambert(0xf5b860));
    shotMesh.position.y = 0.055;
    shotGrp.add(shotMesh);
    shotGrp.visible = false;
    tableProps.add(shotGrp);

    // Dice cup + 5 tiny dice
    const diceCup = new THREE.Mesh(diceCupGeo, diceCupMat);
    diceCup.position.set(-0.2, 0.075, 0.02);
    tableProps.add(diceCup);
    const diceRow = new THREE.Group();
    diceRow.position.set(-0.2, 0.02, 0.14);
    diceRow.visible = false;
    for (let i = 0; i < 5; i++) {
      const dm = new THREE.Mesh(dieGeo, dieMat);
      dm.position.set((i - 2) * 0.048, 0, (i % 2) * 0.025);
      dm.rotation.y = i * 0.6;
      diceRow.add(dm);
    }
    tableProps.add(diceRow);

    if (g.id === room.meId) {
      glassGrp.userData.pick = 'glass';
      shotGrp.userData.pick = 'shot';
      diceCup.userData.pick = 'dice';
      guestHitMeshes.push(glassGrp, shotGrp, diceCup);
    }

    scene.add(root);
    scene.add(tableProps);

    return {
      id: g.id, n: g.n, c: g.c, s: g.s,
      root, bodyPivot, headPivot, armL, armR,
      tableProps, glassGrp, liquid, shotGrp, diceCup, diceRow,
      curPos: new THREE.Vector3(),
      curRot: 0,
      lvl: g.d >= 0 ? g.l / SIPS : 0,
      shotUntil: 0,
      sparkT0: 0,
      inited: false,
    };
  }

  function disposeRig(rig) {
    scene.remove(rig.root);
    scene.remove(rig.tableProps);
    for (let i = guestHitMeshes.length - 1; i >= 0; i--) {
      if (guestHitMeshes[i] === rig.glassGrp || guestHitMeshes[i] === rig.shotGrp || guestHitMeshes[i] === rig.diceCup) {
        guestHitMeshes.splice(i, 1);
      }
    }
  }

  // Cheer orbs & toast sparkles
  const particles = [];
  const orbGeo = new THREE.SphereGeometry(0.08, 8, 6);
  const orbMat = new THREE.MeshBasicMaterial({ color: 0xffd266 });
  const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffe484 });
  function spawnCheerOrb(fromPos) {
    const m = new THREE.Mesh(orbGeo, orbMat);
    m.position.copy(fromPos);
    m.position.y += 1.0;
    scene.add(m);
    particles.push({ m, t0: performance.now(), dur: 1100, p0: m.position.clone(), p1: STAGE_SPOT_WORLD.clone().add(new THREE.Vector3(0, 1.1, 0)) });
  }
  function spawnToastSparks(pos) {
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(orbGeo, sparkMat);
      m.scale.setScalar(0.55);
      m.position.copy(pos);
      scene.add(m);
      const a = (i / 6) * Math.PI * 2;
      const p1 = pos.clone().add(new THREE.Vector3(Math.cos(a) * 0.45, 0.35 + (i % 2) * 0.2, Math.sin(a) * 0.45));
      particles.push({ m, t0: performance.now(), dur: 750, p0: pos.clone(), p1 });
    }
  }

  // ---------- camera & input ----------
  const isPortrait = () => window.innerWidth < window.innerHeight;
  let camYaw = 0, camPitch = 0.31, camDist = isPortrait() ? 5.8 : 4.8;
  const camTarget = new THREE.Vector3(0, 1.35, -4.6);
  const camDesiredTarget = new THREE.Vector3(0, 1.35, -4.6);
  let camSnap = true;
  let lastSelfSeat = -1;

  function seatCameraTarget(sIdx) {
    const s = SEATS[sIdx] || SEATS[0];
    // Look ahead of self toward bar/table; bar seats bias subtly toward Chen & neon sign
    const fx = Math.sin(s.rot), fz = Math.cos(s.rot);
    if (sIdx < 16) return new THREE.Vector3(s.x * 0.72, 1.48, s.z + fz * 1.15);
    return new THREE.Vector3(s.x + fx * 0.75, 1.12, s.z + fz * 0.75);
  }

  const ptrs = new Map();
  let dragStart = null, moved = false, pinchDist0 = 0;

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, yaw: camYaw, pitch: camPitch };
      moved = false;
    } else if (ptrs.size === 2) {
      const pts = [...ptrs.values()];
      pinchDist0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  });

  canvas.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId);
    if (p) {
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 1 && dragStart) {
        const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
        if (Math.hypot(dx, dy) > 5) moved = true;
        camYaw = THREE.MathUtils.clamp(dragStart.yaw - dx * 0.0055, -2.1, 2.1);
        camPitch = THREE.MathUtils.clamp(dragStart.pitch + dy * 0.0045, 0.12, 1.15);
      } else if (ptrs.size === 2) {
        moved = true;
        const pts = [...ptrs.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchDist0 > 0) camDist = THREE.MathUtils.clamp(camDist * (pinchDist0 / Math.max(10, d)), 2.2, 12.0);
        pinchDist0 = d;
      }
      return;
    }
    // Hover check for seat picking
    updateHover(e.clientX, e.clientY);
  });

  function onPtrUp(e) {
    const wasSingle = ptrs.size === 1;
    ptrs.delete(e.pointerId);
    if (wasSingle && !moved) handlePick(e.clientX, e.clientY);
    if (ptrs.size === 0) dragStart = null;
  }
  canvas.addEventListener('pointerup', onPtrUp);
  canvas.addEventListener('pointercancel', onPtrUp);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    camDist = THREE.MathUtils.clamp(camDist + e.deltaY * 0.004, 2.2, 12.0);
  }, { passive: false });

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const interactiveObjects = [jukeboxGroup, stageBase, chalkMesh, chenGroup];

  function rayPick(cx, cy, objs) {
    const r = canvas.getBoundingClientRect();
    ndc.x = ((cx - r.left) / r.width) * 2 - 1;
    ndc.y = -((cy - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(objs, true);
  }

  function seatOccupied(idx) {
    for (const g of room.guests.values()) if (g.s === idx) return true;
    return false;
  }

  function updateHover(cx, cy) {
    const hits = rayPick(cx, cy, seatHits);
    if (hits.length && !seatOccupied(hits[0].object.userData.seat)) {
      const s = SEATS[hits[0].object.userData.seat];
      hoverRing.position.set(s.x, 0.03, s.z);
      hoverRing.visible = true;
      canvas.classList.add('pick');
      return;
    }
    hoverRing.visible = false;
    const propHits = rayPick(cx, cy, [...guestHitMeshes, ...interactiveObjects]);
    canvas.classList.toggle('pick', propHits.length > 0);
  }

  function handlePick(cx, cy) {
    // 1. Check own props (glass / shot / dice cup)
    const pHits = rayPick(cx, cy, guestHitMeshes);
    if (pHits.length) {
      let cur = pHits[0].object;
      while (cur && !cur.userData.pick) cur = cur.parent;
      if (cur) {
        if (cur.userData.pick === 'glass') return sip();
        if (cur.userData.pick === 'shot') return drinkShot();
        if (cur.userData.pick === 'dice') return rollDice();
      }
    }
    // 2. Check scene props (jukebox, stage, chalkboard/chen)
    const sHits = rayPick(cx, cy, interactiveObjects);
    if (sHits.length) {
      let cur = sHits[0].object;
      while (cur && cur !== jukeboxGroup && cur !== stageBase && cur !== chalkMesh && cur !== chenGroup) cur = cur.parent;
      if (cur === jukeboxGroup) return openSong('song');
      if (cur === stageBase) return openSong('sing');
      if (cur === chalkMesh || cur === chenGroup) return openMenu('order');
    }
    // 3. Check seats
    const seatRes = rayPick(cx, cy, seatHits);
    if (seatRes.length) requestSeat(seatRes[0].object.userData.seat);
  }

  // ---------- mood / perf / sync state ----------
  const MOOD_COLS = [0xf5b860, 0x6ea8e6, 0x5c72c9, 0xff5eb3, 0x9b6ae0];
  let curMood = 0;
  let perfId = null;
  let roundSpotId = null, roundSpotUntil = 0;

  function sync() {
    // Add / update guests
    const seen = new Set();
    for (const g of room.guests.values()) {
      seen.add(g.id);
      let rig = guestNodes.get(g.id);
      if (!rig || rig.n !== g.n || rig.c !== g.c) {
        if (rig) disposeRig(rig);
        rig = buildGuestRig(g);
        guestNodes.set(g.id, rig);
      }
      rig.s = g.s;
      const seat = SEATS[g.s] || SEATS[0];
      if (!rig.inited) {
        rig.curPos.set(seat.x, g.s < 16 ? 0.72 : (g.s < 64 ? 0.66 : 0.45), seat.z);
        rig.curRot = seat.rot;
        rig.inited = true;
      }
      if (g.id === room.meId) {
        selfHalo.position.set(seat.x, 0.03, seat.z);
        if (g.s !== lastSelfSeat) {
          lastSelfSeat = g.s;
          camDesiredTarget.copy(seatCameraTarget(g.s));
          if (camSnap) { camTarget.copy(camDesiredTarget); camSnap = false; }
        }
      }
    }
    // Remove departed guests
    for (const [id, rig] of guestNodes.entries()) {
      if (!seen.has(id)) {
        disposeRig(rig);
        guestNodes.delete(id);
      }
    }
  }

  // ---------- render loop ----------
  let running = true, rafId = 0, lastT = performance.now();
  const projV = new THREE.Vector3();

  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    const dt = Math.max(0, Math.min(0.08, (now - lastT) / 1000));
    lastT = now;

    // 1. Rain streaks outside left window
    const rp = rainGeo.attributes.position.array;
    for (let i = 0; i < RAIN_N; i++) {
      const d = rainDrops[i];
      d.y -= d.spd * dt;
      if (d.y < 1.4) d.y = 3.8;
      const k = i * 6;
      rp[k] = -11.79; rp[k + 1] = d.y; rp[k + 2] = d.z;
      rp[k + 3] = -11.79; rp[k + 4] = d.y + d.len; rp[k + 5] = d.z + 0.04;
    }
    rainGeo.attributes.position.needsUpdate = true;

    // 2. Door flash, bell swing, Chen shake, stage band & disco ball
    const doorHot = now < doorFlashUntil;
    doorLampMat.color.setHex(doorHot ? 0xffe488 : 0x553b24);
    doorGlass.material.color.setHex(doorHot ? 0xb5793a : 0x3b2618);

    if (now < bellSwingUntil) {
      const k = (bellSwingUntil - now) / 1800;
      bellPivot.rotation.z = Math.sin(now * 0.025) * 0.45 * k;
    } else bellPivot.rotation.z *= 0.85;

    if (now < chenShakeUntil) {
      chenArmR.rotation.x = -0.9 + Math.sin(now * 0.038) * 0.55;
      chenArmR.rotation.z = Math.cos(now * 0.038) * 0.15;
    } else {
      chenArmR.rotation.x = Math.sin(now * 0.002) * 0.08 - 0.2;
      chenArmR.rotation.z = 0;
    }
    chenGroup.position.x = Math.sin(now * 0.0007) * 0.6;

    const bandSpd = perfId ? 0.009 : 0.0032;
    keyPlayer.rotation.z = Math.sin(now * bandSpd) * 0.09;
    bassPlayer.rotation.z = Math.cos(now * bandSpd * 0.9) * 0.08;
    if (discoBall.visible) discoBall.rotation.y += dt * 1.4;

    // 3. Lighting mood + stage / round spotlight
    const isPerf = perfId !== null && guestNodes.has(perfId);
    const isRoundSpot = !isPerf && now < roundSpotUntil && guestNodes.has(roundSpotId);
    const targetHemi = isPerf ? 0.5 : 1.35;
    const targetDir = isPerf ? 0.32 : 0.95;
    const targetBar = isPerf ? 8.5 : 24.0;
    hemiLight.intensity += (targetHemi - hemiLight.intensity) * 0.08;
    dirLight.intensity += (targetDir - dirLight.intensity) * 0.08;
    barLight.intensity += (targetBar - barLight.intensity) * 0.08;

    if (isPerf) {
      spotLight.intensity += (34 - spotLight.intensity) * 0.12;
      spotLight.color.setHex(0xffd6f0);
      spotLight.target.position.copy(STAGE_SPOT_WORLD).setY(1.0);
    } else if (isRoundSpot) {
      const rRig = guestNodes.get(roundSpotId);
      spotLight.intensity += (26 - spotLight.intensity) * 0.12;
      spotLight.color.setHex(0xffe09c);
      spotLight.target.position.copy(rRig.curPos).setY(0.9);
    } else {
      spotLight.intensity *= 0.85;
    }

    // 4. Guest animations, drinks, gestures, dice & projected labels
    const selfG = selfSeat();
    const guestCount = room.guests.size;
    for (const g of room.guests.values()) {
      const rig = guestNodes.get(g.id);
      if (!rig) continue;
      const seat = SEATS[g.s] || SEATS[0];
      const seatY = g.s < 16 ? 0.72 : (g.s < 64 ? 0.66 : 0.45);
      const onStage = g.id === perfId;
      const goalX = onStage ? STAGE_SPOT_WORLD.x : seat.x;
      const goalY = onStage ? 0.36 : seatY;
      const goalZ = onStage ? STAGE_SPOT_WORLD.z : seat.z;
      const goalR = onStage ? STAGE_FACING : seat.rot;

      rig.curPos.x += (goalX - rig.curPos.x) * 0.12;
      rig.curPos.y += (goalY - rig.curPos.y) * 0.12;
      rig.curPos.z += (goalZ - rig.curPos.z) * 0.12;
      let dr = goalR - rig.curRot;
      while (dr > Math.PI) dr -= Math.PI * 2;
      while (dr < -Math.PI) dr += Math.PI * 2;
      rig.curRot += dr * 0.14;

      rig.root.position.copy(rig.curPos);
      rig.root.rotation.y = rig.curRot;
      if (onStage) rig.root.position.y += Math.abs(Math.sin(now * 0.0065)) * 0.06;

      // Table props stay on the seat's table
      rig.tableProps.position.set(seat.tx, seat.ty, seat.tz);
      rig.tableProps.rotation.y = seat.rot;

      // Liquid level
      const targetLvl = g.id === room.meId ? level : (g.d >= 0 ? g.l / SIPS : 0);
      rig.lvl += (targetLvl - rig.lvl) * 0.2;
      if (g.d >= 0 && rig.lvl > 0.01) {
        rig.liquid.visible = true;
        rig.liquid.material = drinkMats[g.d] || drinkMats[0];
        rig.liquid.scale.y = Math.max(0.05, Math.min(1, rig.lvl));
      } else {
        rig.liquid.visible = false;
      }

      // Shot glass visibility
      rig.shotGrp.visible = g.id === room.meId ? (S.shots.length > 0) : (now < rig.shotUntil);

      // Dice animation
      const diceAge = g.diceT0 ? now - g.diceT0 : 99999;
      if (diceAge < 900) {
        rig.diceCup.position.y = 0.09 + Math.abs(Math.sin(now * 0.04)) * 0.06;
        rig.diceCup.rotation.z = Math.sin(now * 0.05) * 0.35;
        rig.diceRow.visible = false;
      } else if (diceAge < 6000) {
        rig.diceCup.position.y = 0.075;
        rig.diceCup.rotation.z = 0;
        rig.diceRow.visible = true;
      } else {
        rig.diceCup.position.y = 0.075;
        rig.diceCup.rotation.z = 0;
        rig.diceRow.visible = false;
      }

      // Body gestures (slump, raise glass, toast, sigh, sip, sing) & glass lifting
      const plateau = (u, up = 0.16, dn = 0.25) => {
        if (u <= 0 || u >= 1) return 0;
        if (u < up) { const t = u / up; return t * t * (3 - 2 * t); }
        if (u > 1 - dn) { const t = (1 - u) / dn; return t * t * (3 - 2 * t); }
        return 1;
      };
      const slumped = g.slumpUntil && now < g.slumpUntil;
      let bodyRx = 0, bodyPy = 0, headRx = 0, headRz = 0;
      let armRx = -0.25, armRz = 0, armRy = 0.34, armLx = -0.25, armLz = 0, armLy = 0.34;
      let glX = 0, glY = 0, glZ = 0, glRx = 0;

      if (slumped) {
        bodyRx = 0.92;
        bodyPy = -0.05;
        headRx = 0.42;
        headRz = 0.24;
        armRx = -1.25;
        armLx = -1.25;
      } else if (onStage) {
        bodyRx = Math.sin(now * 0.005) * 0.08;
        bodyPy = Math.abs(Math.sin(now * 0.008)) * 0.05;
        armRx = -1.45 + Math.sin(now * 0.01) * 0.25;
        armRz = 0.45;
        armLx = -0.8 + Math.cos(now * 0.01) * 0.22;
        armLz = -0.4;
        armRy = 0.44;
        armLy = 0.4;
      } else if (g.sipT0 && now - g.sipT0 < 1450) {
        // 喝一口：右臂扬起并将酒杯凑到嘴边倾斜仰饮
        const k = plateau(Math.max(0, now - g.sipT0) / 1450, 0.2, 0.28);
        armRx = -0.25 - k * 2.05;
        armRz = k * 0.58;
        armRy = 0.34 + k * 0.16;
        headRx = -k * 0.52;
        bodyRx = -k * 0.1;
        glX = k * 0.28;
        glY = k * 0.34;
        glZ = -k * 0.86;
        glRx = -k * 0.72;
      } else if (g.anim && now - g.anim.t0 < 2200) {
        const age = Math.max(0, now - g.anim.t0) / 2200;
        if (g.anim.k === 0) {
          // 举杯：右手高举偏出轮廓线外，酒杯紧贴手端举过吧台
          const env = plateau(age, 0.15, 0.25);
          armRx = -0.25 - env * 2.3;
          armRz = env * 0.85;
          armRy = 0.34 + env * 0.22;
          headRx = -env * 0.24;
          bodyPy = env * 0.08;
          glX = env * 0.44;
          glY = env * 0.44;
          glZ = -env * 0.82;
        } else if (g.anim.k === 1) {
          // 干杯：双手举起晃动敬酒 + 举杯处金色火花
          const env = plateau(age, 0.14, 0.24);
          const bounce = Math.sin(age * Math.PI * 6) * 0.14 * env;
          armRx = -0.25 - env * 2.25 + bounce;
          armRz = env * 0.82;
          armRy = 0.34 + env * 0.22;
          armLx = -0.25 - env * 1.75;
          armLz = -env * 0.68;
          armLy = 0.34 + env * 0.16;
          headRx = -env * 0.22;
          bodyPy = Math.abs(Math.sin(age * Math.PI * 3)) * 0.08 * env;
          glX = env * 0.42;
          glY = env * 0.46 + bounce * 0.12;
          glZ = -env * 0.8;
          glRx = -env * 0.18;
          if (rig.sparkT0 !== g.anim.t0) {
            rig.sparkT0 = g.anim.t0;
            const sp = new THREE.Vector3(0.42, 0.58, -0.8);
            rig.tableProps.updateMatrixWorld(true);
            rig.tableProps.localToWorld(sp);
            spawnToastSparks(sp);
          }
        } else if (g.anim.k === 2) {
          // 叹气：低头垂肩长叹
          const env = plateau(age, 0.2, 0.3);
          headRx = env * 0.62;
          bodyRx = env * 0.32;
          bodyPy = -env * 0.07;
          armRx = 0.18 * env;
          armLx = 0.18 * env;
          armRz = 0.28 * env;
          armLz = -0.28 * env;
          armRy = 0.34 - env * 0.05;
          armLy = 0.34 - env * 0.05;
        }
      } else {
        // Gentle idle breathing
        headRx = Math.sin(now * 0.0018 + g.id) * 0.04;
      }

      const easePose = 1 - Math.exp(-18 * dt);
      rig.bodyPivot.rotation.x += (bodyRx - rig.bodyPivot.rotation.x) * easePose;
      rig.bodyPivot.position.y += (bodyPy - rig.bodyPivot.position.y) * easePose;
      rig.headPivot.rotation.x += (headRx - rig.headPivot.rotation.x) * easePose;
      rig.headPivot.rotation.z += (headRz - rig.headPivot.rotation.z) * easePose;
      rig.armR.rotation.x += (armRx - rig.armR.rotation.x) * easePose;
      rig.armR.rotation.z += (armRz - rig.armR.rotation.z) * easePose;
      rig.armR.position.y += (armRy - rig.armR.position.y) * easePose;
      rig.armL.rotation.x += (armLx - rig.armL.rotation.x) * easePose;
      rig.armL.rotation.z += (armLz - rig.armL.rotation.z) * easePose;
      rig.armL.position.y += (armLy - rig.armL.position.y) * easePose;
      rig.glassGrp.position.set(glX, glY, glZ);
      rig.glassGrp.rotation.x = glRx;

      // Project 3D head position -> 2D DOM label
      if (g.lab) {
        projV.set(rig.curPos.x, rig.curPos.y + 0.98, rig.curPos.z);
        projV.project(camera);
        if (projV.z > 1 || projV.z < -1) {
          g.lab.style.opacity = '0';
        } else {
          const sx = (projV.x * 0.5 + 0.5) * window.innerWidth;
          const sy = (-projV.y * 0.5 + 0.5) * window.innerHeight;
          const dist = camera.position.distanceTo(rig.curPos);
          let op = 1;
          if (g.id !== room.meId && g.id !== perfId) {
            if (sy < 68 || sy > window.innerHeight - 115 || sx < 24 || sx > window.innerWidth - 24) op = 0;
            else if (guestCount > 24 && dist > 13.5) op = 0;
            else if (dist > 8) op = Math.max(0.25, 1 - (dist - 8) / 8);
          }
          g.lab.style.opacity = String(op);
          g.lab.style.transform = `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0) translate(-50%,-100%)`;
        }
      }
    }

    // 5. Cheer flying orbs
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const u = (now - p.t0) / p.dur;
      if (u >= 1) {
        scene.remove(p.m);
        particles.splice(i, 1);
      } else {
        p.m.position.lerpVectors(p.p0, p.p1, u);
        p.m.position.y += Math.sin(u * Math.PI) * 1.45;
        const s = 1 - u * 0.4;
        p.m.scale.set(s, s, s);
      }
    }

    // 6. Camera positioning (smooth seat transition + orbit + tipsy sway)
    if (selfG) {
      const targetPos = seatCameraTarget(selfG.s);
      camDesiredTarget.copy(targetPos);
    }
    camTarget.lerp(camDesiredTarget, 0.08);
    const selfSeatRot = selfG ? (SEATS[selfG.s] || SEATS[0]).rot : Math.PI;
    // Camera sits behind self's shoulder looking forward along selfSeatRot + camYaw
    const lookYaw = selfSeatRot + camYaw;
    const hDist = Math.cos(camPitch) * camDist;
    const vDist = Math.sin(camPitch) * camDist;
    let cx = camTarget.x - Math.sin(lookYaw) * hDist;
    let cy = camTarget.y + vDist;
    let cz = camTarget.z - Math.cos(lookYaw) * hDist;
    // Clamp inside walls
    cx = THREE.MathUtils.clamp(cx, -11.3, 11.3);
    cz = THREE.MathUtils.clamp(cz, -7.9, 10.9);
    cy = THREE.MathUtils.clamp(cy, 0.8, 4.95);

    if (!reduced && S.tipsy > 25) {
      const sway = ((S.tipsy - 25) / 75) * 0.09;
      cx += Math.sin(now * 0.0014) * sway;
      cy += Math.cos(now * 0.0019) * sway * 0.6;
    }

    camera.position.set(cx, cy, cz);
    camera.lookAt(camTarget);
    renderer.render(scene, camera);
  }

  // ---------- resize & lifecycle ----------
  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  window.addEventListener('resize', onResize);

  function pause() {
    running = false;
    cancelAnimationFrame(rafId);
  }
  function resume() {
    if (running || boss || document.hidden) return;
    running = true;
    lastT = performance.now();
    rafId = requestAnimationFrame(tick);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else resume();
  });

  // ---------- public R3D API called by index.html ----------
  window.R3D = {
    sync,
    chenShake(ms) { chenShakeUntil = performance.now() + (ms || 1200); },
    door() { doorFlashUntil = performance.now() + 1800; },
    round(fromId, _d) {
      bellSwingUntil = performance.now() + 1800;
      roundSpotId = fromId;
      roundSpotUntil = performance.now() + 4500;
      const until = performance.now() + 8000;
      guestNodes.forEach(rig => { rig.shotUntil = until; });
    },
    setMood(m) {
      curMood = m;
      jbGlowMat.color.setHex(MOOD_COLS[m] || MOOD_COLS[0]);
      discoBall.visible = !!(TRACKS[m] && TRACKS[m].disco);
    },
    perfStart(id) { perfId = id; },
    perfEnd(_id) { perfId = null; },
    cheer(g) {
      const rig = g && guestNodes.get(g.id);
      if (rig) spawnCheerOrb(rig.curPos);
    },
    pause,
    resume,
    // Debug helper for multi-view testing / inspection
    _setCam(yaw, pitch, dist) {
      if (yaw !== undefined) camYaw = yaw;
      if (pitch !== undefined) camPitch = pitch;
      if (dist !== undefined) camDist = dist;
    },
    _rig(id) { return guestNodes.get(id || room.meId); }
  };

  // Catch initial state that ran before deferred module loaded
  sync();
  window.R3D.setMood(effectiveMood());
  if (room.perf) window.R3D.perfStart(room.perf.id);
  if (!boss && !document.hidden) rafId = requestAnimationFrame(tick);
})();

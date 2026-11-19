/* 黑洞吞噬大作战 - 单机人机 · 无尽模式
 * 横屏 / Three.js r128 / 无外部资源 / 离线可运行
 * 核心方案：地面 shader 挖孔 + 运动学下坠；无限地图用区块动态生成/回收
 * 无尽：无倒计时，存活越久难度越高，场地随玩家扩张，AI 逐渐增多（上限 16）
 */
(function () {
  'use strict';

  // ==================== 配置 ====================
  var CFG = {
    HOLE_BASE: 1.0,      // 初始半径
    R_MAX: 25,           // 半径上限（饱和成长）
    GROW_K: 520,         // 成长半程点：exp=K 时半径约为上限一半
    EAT_RATIO: 0.85,     // 吞噬尺寸比
    SPEED_BASE: 13,      // 基础速度
    SPEED_GROW: 0.55,    // 速度随半径增量
    CHUNK: 60,           // 区块边长
    CHUNK_RADIUS: 1,     // 维护玩家周围 ±N 圈区块（3x3）
    PER_CHUNK: 55,       // 每区块物体数
    MAX_HOLES: 20,       // shader 洞上限
    AI_START: 7,         // 初始 AI 数
    AI_MAX: 15,          // AI 上限
    STAGE_SEC: 25        // 每存活多少秒升一级难度
  };

  // 物体等级：[尺寸半径, 经验, 需要洞半径, 颜色组, 基础占比]
  var LV = [
    { s: 0.6,  e: 1,  need: 1.0,  p: 0.40, c: [0x9aa7b5, 0xd9534f, 0x8b6f47] },
    { s: 1.5,  e: 3,  need: 2.0,  p: 0.30, c: [0x4aa3df, 0x5cb85c, 0xe0a030] },
    { s: 3.0,  e: 8,  need: 4.0,  p: 0.15, c: [0x3f7fbf, 0x6b8e23, 0xc0753a] },
    { s: 6.0,  e: 20, need: 7.5,  p: 0.10, c: [0x7a8a99, 0xa08060, 0x557a55] },
    { s: 10.0, e: 50, need: 12.0, p: 0.05, c: [0x6c7a89, 0x4a6fa5, 0x8a6f5c] }
  ];

  var SKINS = [0x4cc9f0, 0xf72585, 0xffd166, 0x06d6a0, 0xb388ff, 0xff6b6b, 0x64dfdf];
  var AI_NAMES = ['路人甲', '黑洞侠', '贪吃鬼', '小霸王', '路人乙', '吞天兽', '无敌手', '追风者', '大胃王',
    '小旋风', '铁胃', '闪电', '巨无霸', '夜行者', '贪狼', '碎星', '黑洞王', '飓风'];
  var AI_COLORS = [0xff6b6b, 0xffd166, 0x06d6a0, 0xb388ff, 0xf72585, 0x4cc9f0, 0xfa7d09,
    0xa3e635, 0xf472b6, 0x38bdf8, 0xfb923c, 0x818cf8, 0x34d399, 0xe879f9, 0xfacc15, 0x60a5fa];

  // ==================== 工具 ====================
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function rndi(a, b) { return Math.floor(rnd(a, b + 1)); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function hex(n) { return '#' + ('000000' + n.toString(16)).slice(-6); }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    return ('0' + Math.floor(sec / 60)).slice(-2) + ':' + ('0' + (sec % 60)).slice(-2);
  }

  // ==================== 状态 ====================
  var renderer, scene, camera, ground, groundMat;
  var objects = [], holes = [], player;
  var chunks = {};               // key "cx,cz" -> {objs:[obj,...]}
  var clock = new THREE.Clock();
  var gameState = 'home';        // home | play | result
  var QS = new URLSearchParams(location.search);
  var DEBUG_STAGE = parseInt(QS.get('stage'), 10);  // 调试：直接从某难度开局
  var AUTO = QS.get('auto') === '1';                // 调试：自动觅食
  var DEBUG = QS.get('debug') === '1';              // 调试：暴露内部状态到 window.__hole
  var DEBUG_DIE = parseFloat(QS.get('die'));        // 调试：开局 N 秒后强制被吃，验证死亡结算
  var elapsed = 0, stage = 1, skinIdx = 0;
  var bestScore = 0, bestTime = 0;
  var shake = 0, deathT = 0, deathBy = '', rotateT = 0;
  var input = { active: false, sx: 0, sy: 0, dx: 0, dy: 0 };
  var keys = {};
  var tmpV = new THREE.Vector3();
  var holeUniform = { uHoles: { value: [] }, uHoleCount: { value: 0 } };
  for (var i = 0; i < CFG.MAX_HOLES; i++) holeUniform.uHoles.value.push(new THREE.Vector3());

  // ==================== DOM ====================
  var $ = function (id) { return document.getElementById(id); };
  var dom = {};
  ['home', 'hud', 'result', 'timer', 'stageLv', 'aiCount', 'mySize', 'myScore', 'bestScore',
    'homeBest', 'boardRows', 'killfeed', 'floaters', 'respawn', 'respawnNum', 'skinDot',
    'startBtn', 'endBtn', 'skinPrev', 'skinNext', 'finalRank', 'finalTime', 'finalScore',
    'finalEaten', 'finalKills', 'finalStage', 'finalSize', 'againBtn', 'homeBtn', 'joystick'
  ].forEach(function (k) { dom[k] = $(k); });

  // ==================== 存档 ====================
  function loadBest() {
    try {
      bestScore = parseInt(localStorage.getItem('hole_best_score') || '0', 10) || 0;
      bestTime = parseInt(localStorage.getItem('hole_best_time') || '0', 10) || 0;
    } catch (e) { bestScore = 0; bestTime = 0; }
    if (dom.homeBest) dom.homeBest.textContent = fmtTime(bestTime);
  }
  function saveBest() {
    if (player.score > bestScore) { bestScore = player.score; try { localStorage.setItem('hole_best_score', bestScore); } catch (e) {} }
    if (elapsed > bestTime) { bestTime = elapsed; try { localStorage.setItem('hole_best_time', bestTime); } catch (e) {} }
  }

  // ==================== 音效 ====================
  var actx = null;
  function audio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  function beep(freq, dur, type, vol) {
    var a = audio(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.12, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + dur);
  }
  function sfxEat(lv) { beep(420 + lv * 130, 0.09, 'sine', 0.10); }
  function sfxKill() { beep(180, 0.18, 'square', 0.10); setTimeout(function () { beep(300, 0.22, 'square', 0.09); }, 90); }
  function sfxLevel() { beep(520, 0.16, 'triangle', 0.12); setTimeout(function () { beep(780, 0.18, 'triangle', 0.1); }, 100); }
  function sfxStage() { beep(440, 0.14, 'sawtooth', 0.1); setTimeout(function () { beep(660, 0.16, 'sawtooth', 0.1); }, 120); setTimeout(function () { beep(880, 0.2, 'sawtooth', 0.1); }, 240); }

  // ==================== 初始化 ====================
  function init() {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x0a0e15, 1);
    $('game').appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0e15, 100, 260);

    camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 700);

    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    var dir = new THREE.DirectionalLight(0xffffff, 0.75);
    dir.position.set(-60, 120, 40);
    scene.add(dir);

    buildGround();
    buildMenuPreview();
    bindUI();
    bindInput();
    window.addEventListener('resize', onResize);
    updateSkin();
    loadBest();
    loop();
    dom.home.classList.remove('hidden');
  }

  function onResize() {
    if (!renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ==================== 地面（shader 挖孔，跟随玩家） ====================
  function buildGround() {
    var vs = [
      'varying vec3 vW;',
      'void main(){',
      '  vec4 wp = modelMatrix * vec4(position,1.0);',
      '  vW = wp.xyz;',
      '  gl_Position = projectionMatrix * viewMatrix * wp;',
      '}'
    ].join('\n');
    var fs = [
      'uniform vec3 uHoles[20];',
      'uniform int uHoleCount;',
      'varying vec3 vW;',
      'void main(){',
      '  vec2 p = vW.xz;',
      '  for(int i=0;i<20;i++){',
      '    if(i>=uHoleCount) break;',
      '    vec2 c = uHoles[i].xy; float r = uHoles[i].z;',
      '    if(distance(p,c) < r) discard;',
      '  }',
      '  vec2 g = abs(fract(p/10.0)-0.5);',
      '  float line = smoothstep(0.45,0.5,max(g.x,g.y));',
      '  vec3 col = mix(vec3(0.27,0.32,0.38), vec3(0.17,0.20,0.24), line);',
      '  float b = fract(sin(dot(floor(p/10.0),vec2(12.9898,78.233)))*43758.5453);',
      '  if(b>0.86) col = vec3(0.20,0.33,0.22);',
      '  gl_FragColor = vec4(col,1.0);',
      '}'
    ].join('\n');
    groundMat = new THREE.ShaderMaterial({
      uniforms: holeUniform, vertexShader: vs, fragmentShader: fs, side: THREE.DoubleSide
    });
    var geo = new THREE.PlaneGeometry(700, 700, 1, 1);
    ground = new THREE.Mesh(geo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    scene.add(ground);

    var bottomGeo = new THREE.CircleGeometry(1, 40);
    var bottomMat = new THREE.MeshBasicMaterial({ color: 0x05070b, side: THREE.DoubleSide });
    ground.userData.bottomGeo = bottomGeo;
    ground.userData.bottomMat = bottomMat;
  }

  // ==================== 低多边形物体 ====================
  var geoCache = {};
  function box(w, h, d) {
    var k = 'b' + w + '_' + h + '_' + d;
    if (!geoCache[k]) geoCache[k] = new THREE.BoxGeometry(w, h, d);
    return geoCache[k];
  }
  function cyl(rt, rb, h, s) {
    var k = 'c' + rt + '_' + rb + '_' + h + '_' + s;
    if (!geoCache[k]) geoCache[k] = new THREE.CylinderGeometry(rt, rb, h, s || 8);
    return geoCache[k];
  }
  function sph(r, s) {
    var k = 's' + r + '_' + s;
    if (!geoCache[k]) geoCache[k] = new THREE.SphereGeometry(r, s || 8, 6);
    return geoCache[k];
  }
  var matCache = {};
  function mat(color) {
    if (!matCache[color]) matCache[color] = new THREE.MeshLambertMaterial({ color: color });
    return matCache[color];
  }
  function part(group, geo, color, x, y, z) {
    var m = new THREE.Mesh(geo, mat(color));
    m.position.set(x, y, z);
    group.add(m);
    return m;
  }

  function makeProp(level, x, z) {
    var g = new THREE.Group();
    var C = LV[level].c, c0 = pick(C), c1 = pick(C), c2 = pick(C);
    var rot = rnd(0, Math.PI * 2);
    switch (level) {
      case 0:
        switch (rndi(0, 4)) {
          case 0: part(g, cyl(0.05, 0.06, 2.2, 6), 0x555, 0, 1.1, 0); part(g, sph(0.22, 8), 0xffe9a8, 0, 2.3, 0); break;
          case 1: part(g, cyl(0.22, 0.24, 0.7, 8), 0xd0392b, 0, 0.35, 0); part(g, cyl(0.28, 0.28, 0.1, 8), 0x922, 0, 0.72, 0); break;
          case 2: part(g, cyl(0.3, 0.26, 0.8, 8), c0, 0, 0.4, 0); part(g, cyl(0.32, 0.32, 0.08, 8), 0x333, 0, 0.82, 0); break;
          case 3: part(g, cyl(0.16, 0.2, 1.1, 6), c1, 0, 0.55, 0); part(g, sph(0.2, 8), 0xe0b08a, 0, 1.3, 0); break;
          default: for (var i = 0; i < 4; i++) part(g, box(0.1, 0.9, 0.1), 0x9aa, i * 0.3 - 0.45, 0.45, 0); part(g, box(1.4, 0.08, 0.08), 0x9aa, 0, 0.8, 0);
        }
        break;
      case 1:
        switch (rndi(0, 4)) {
          case 0: part(g, box(2.2, 0.18, 0.7), 0xa9743f, 0, 0.5, 0); part(g, box(2.2, 0.7, 0.15), 0xa9743f, 0, 0.85, -0.3); break;
          case 1: part(g, sph(0.9, 8), 0x4a9a4a, 0, 0.7, 0); part(g, sph(0.7, 8), 0x5caf5c, 0.5, 0.9, 0.3); break;
          case 2: part(g, box(2.6, 0.7, 1.3), c0, 0, 0.6, 0); part(g, box(1.3, 0.6, 1.15), 0x335577, -0.2, 1.15, 0); part(g, cyl(0.28, 0.28, 0.15, 10), 0x222, -0.85, 0.3, 0.6).rotation.z = Math.PI/2; part(g, cyl(0.28,0.28,0.15,10),0x222,0.85,0.3,0.6).rotation.z=Math.PI/2; break;
          case 3: part(g, cyl(0.3, 0.3, 1.2, 8), 0x2b6cb0, 0, 0.6, 0); part(g, box(0.5, 0.3, 0.4), 0x1a4a80, 0, 1.3, 0); break;
          default: part(g, cyl(0.08, 0.08, 2.6, 6), 0x777, -1, 1.3, 0); part(g, cyl(0.08,0.08,2.6,6),0x777,1,1.3,0); part(g, box(2.4,1.3,0.12), c1, 0, 2.4, 0);
        }
        break;
      case 2:
        switch (rndi(0, 4)) {
          case 0: part(g, box(5.2, 2.2, 2.0), 0xf0a500, 0, 1.3, 0); for (var w=0;w<5;w++) part(g, box(0.7,0.8,0.05), 0x335577, -1.9+w*0.95, 1.7, 1.03); break;
          case 1: part(g, box(3.4, 1.5, 1.8), c0, -0.6, 1.0, 0); part(g, box(1.6, 1.9, 1.7), 0xeee, 1.4, 1.2, 0); break;
          case 2: part(g, cyl(0.4, 0.55, 2.6, 7), 0x6b4f2a, 0, 1.3, 0); part(g, sph(1.7, 8), 0x3f8f3f, 0, 3.4, 0); part(g, sph(1.3,8), 0x4fa04f, 1.0, 3.0, 0.4); break;
          case 3: for (var p=0;p<4;p++){var a=p*Math.PI/2;part(g,cyl(0.12,0.12,2,6),0x9a7b4f,Math.cos(a)*1.6,1,Math.sin(a)*1.6);} part(g, cyl(2.4,2.4,0.2,8), c2, 0, 2.1, 0); break;
          default: part(g, box(5, 2.8, 4), c0, 0, 1.4, 0); part(g, cyl(3.6,3.6,0.2,4), 0x9a4a3a, 0, 2.95, 0).rotation.y=Math.PI/4;
        }
        break;
      case 3:
        var h = rnd(6, 9);
        switch (rndi(0, 2)) {
          case 0: part(g, box(7, 4, 6), 0xdfe4ea, 0, 2, 0); part(g, box(7.4, 0.6, 6.4), 0xe74c3c, 0, 4.2, 0); part(g, box(4, 2.4, 0.1), 0x5dade2, 0, 2.2, 3.05); break;
          case 1: part(g, box(8, h, 7), c0, 0, h/2, 0); for (var f=0;f<3;f++) for(var q=0;q<3;q++) part(g, box(1.2,1.2,0.1),0x8fd3f4,-2.4+q*2.4,2+f*2,3.55); break;
          default: part(g, box(7, h+2, 7), 0x8aa0b5, 0, (h+2)/2, 0); part(g, box(7.4,0.4,7.4),0x5b6b7b,0,h+2.2,0);
        }
        break;
      case 4:
        var H = rnd(14, 22);
        switch (rndi(0, 2)) {
          case 0: part(g, box(9, H, 9), c0, 0, H/2, 0); part(g, box(9.4,0.5,9.4),0x9fb3c8,0,H*0.55,0); part(g, box(9.4,0.5,9.4),0x9fb3c8,0,H*0.8,0); part(g, cyl(0.2,0.2,3,6),0xaaa,0,H+1.5,0); break;
          case 1: part(g, cyl(9, 9, 8, 16), 0xd0d8e0, 0, 4, 0); part(g, sph(9, 12), 0xb8c4d0, 0, 8, 0).scale.y=0.5; break;
          default: part(g, cyl(4.5, 5, H, 6), c1, 0, H/2, 0); part(g, sph(4, 10), c2, 0, H+1, 0);
        }
        break;
    }
    g.position.set(x, 0, z);
    g.rotation.y = rot;
    g.userData.lv = level;
    return g;
  }

  // 难度驱动物体等级分布：等级越高，越偏向大物体（保证后期有足够食物）
  function rollLevel() {
    var r = Math.random();
    // stage 提升时，把低等级占比逐步转移给高等级
    var t = Math.min(0.45, (stage - 1) * 0.03);
    var p0 = LV[0].p * (1 - t);
    var p1 = LV[1].p * (1 - t * 0.5);
    var p2 = LV[2].p + t * 0.3;
    var p3 = LV[3].p + t * 0.35;
    var p4 = LV[4].p + t * 0.35;
    var total = p0 + p1 + p2 + p3 + p4;
    var acc = 0;
    var ps = [p0 / total, p1 / total, p2 / total, p3 / total, p4 / total];
    for (var l = 0; l < 5; l++) { acc += ps[l]; if (r <= acc) return l; }
    return 4;
  }

  function addObjAt(x, z, level) {
    var g = makeProp(level, x, z);
    scene.add(g);
    var o = { mesh: g, x: x, z: z, s: LV[level].s, e: LV[level].e, lv: level, alive: true, fall: null };
    objects.push(o);
    return o;
  }

  // ==================== 区块管理 ====================
  function chunkKey(cx, cz) { return cx + ',' + cz; }

  function genChunk(cx, cz) {
    var key = chunkKey(cx, cz);
    if (chunks[key]) return;
    var arr = [];
    var baseX = cx * CFG.CHUNK, baseZ = cz * CFG.CHUNK;
    for (var i = 0; i < CFG.PER_CHUNK; i++) {
      var x = baseX + rnd(0, CFG.CHUNK), z = baseZ + rnd(0, CFG.CHUNK);
      // 出生区块中心留空
      if (cx === 0 && cz === 0 && Math.abs(x) < 7 && Math.abs(z) < 7) continue;
      arr.push(addObjAt(x, z, rollLevel()));
    }
    chunks[key] = { objs: arr };
  }

  function dropChunk(key) {
    var c = chunks[key];
    if (!c) return;
    for (var i = 0; i < c.objs.length; i++) {
      var o = c.objs[i];
      if (!o.alive && !o.fall) continue;
      // 正在下坠的也直接移除
      scene.remove(o.mesh);
      var idx = objects.indexOf(o);
      if (idx >= 0) objects.splice(idx, 1);
    }
    delete chunks[key];
  }

  function updateChunks() {
    var pcx = Math.floor(player.x / CFG.CHUNK), pcz = Math.floor(player.z / CFG.CHUNK);
    var R = CFG.CHUNK_RADIUS;
    // 生成周围区块
    for (var dx = -R; dx <= R; dx++) {
      for (var dz = -R; dz <= R; dz++) genChunk(pcx + dx, pcz + dz);
    }
    // 回收远超范围的区块
    for (var key in chunks) {
      if (!chunks.hasOwnProperty(key)) continue;
      var parts = key.split(','), cx = parseInt(parts[0], 10), cz = parseInt(parts[1], 10);
      if (Math.abs(cx - pcx) > R + 1 || Math.abs(cz - pcz) > R + 1) dropChunk(key);
    }
    // 地面贴着玩家（整块移动，避免边缘露出）
    ground.position.x = pcx * CFG.CHUNK;
    ground.position.z = pcz * CFG.CHUNK;
  }

  function clearWorld() {
    objects.forEach(function (o) { scene.remove(o.mesh); });
    objects = [];
    chunks = {};
    holes.forEach(function (h) { scene.remove(h.group); });
    holes = [];
    player = null;
  }

  // ==================== 黑洞 ====================
  function makeHole(name, color, isPlayer, x, z, personality) {
    var grp = new THREE.Group();
    var bottom = new THREE.Mesh(ground.userData.bottomGeo, ground.userData.bottomMat);
    bottom.rotation.x = -Math.PI / 2; bottom.position.y = -2.6; bottom.scale.setScalar(1);
    grp.add(bottom);
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1.06, 48),
      new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide, transparent: true, opacity: 0.92 })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    grp.add(ring);
    var inner = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.88, 48),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
    );
    inner.rotation.x = -Math.PI / 2; inner.position.y = 0.02;
    grp.add(inner);
    var label = makeLabel(name, color, isPlayer);
    label.position.y = 2.2;
    grp.add(label);
    grp.position.set(x, 0, z);
    scene.add(grp);

    var h = {
      name: name, color: color, isPlayer: !!isPlayer, x: x, z: z,
      radius: CFG.HOLE_BASE, exp: 0, score: 0, eaten: 0, kills: 0,
      alive: true, respawn: 0, group: grp, ring: ring, bottom: bottom, label: label,
      vx: 0, vz: 0,
      ai: isPlayer ? null : {
        state: 'forage', target: null, tx: 0, tz: 0, chaseT: 0, senseT: Math.random() * 0.5,
        stuckT: 0, lastX: x, lastZ: z, deflect: 0,
        type: personality || 'normal'
      }
    };
    syncHole(h);
    return h;
  }

  function makeLabel(text, color, isPlayer) {
    var cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    var c = cv.getContext('2d');
    c.font = 'bold 30px sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 6; c.strokeStyle = 'rgba(0,0,0,.75)';
    c.strokeText(text, 128, 34);
    c.fillStyle = hex(color); c.fillText(text, 128, 34);
    if (isPlayer) { c.font = '22px sans-serif'; c.fillStyle = '#ffd166'; c.fillText('▼', 128, 60); }
    var tex = new THREE.CanvasTexture(cv);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(7, 1.75, 1);
    return sp;
  }

  function syncHole(h) {
    h.group.position.set(h.x, 0, h.z);
    h.ring.scale.setScalar(h.radius);
    h.bottom.scale.setScalar(h.radius * 0.99);
    h.label.position.y = h.radius * 1.1 + 1.6;
    h.label.scale.set(6, 1.5, 1);
  }

  // 饱和成长：渐进逼近 R_MAX，永不糊满屏幕
  function radiusOf(exp) {
    return CFG.HOLE_BASE + (CFG.R_MAX - CFG.HOLE_BASE) * exp / (exp + CFG.GROW_K);
  }
  // 反函数：由目标半径求所需经验
  function expOf(radius) {
    var r = clamp(radius, CFG.HOLE_BASE, CFG.R_MAX - 0.01);
    var f = (r - CFG.HOLE_BASE) / (CFG.R_MAX - CFG.HOLE_BASE);
    return CFG.GROW_K * f / (1 - f);
  }
  function speedOf(h) {
    var s = CFG.SPEED_BASE + h.radius * CFG.SPEED_GROW;
    if (h.ai && h.ai.type === 'calm') s *= 0.78;
    if (h.ai && h.ai.type === 'aggressive') s *= 1.06;
    return s;
  }

  function aiTypeFor(index) {
    // 难度越高，激进型越多
    var aggressiveRatio = Math.min(0.7, 0.28 + stage * 0.035);
    var r = Math.random();
    if (r < aggressiveRatio) return 'aggressive';
    if (r > 0.88) return 'calm';
    return 'normal';
  }

  function spawnAI() {
    var idx = holes.length - 1; // 玩家是 holes[0]
    var a = rnd(0, Math.PI * 2);
    var d = rnd(55, 90);
    var name = AI_NAMES[idx % AI_NAMES.length];
    var color = AI_COLORS[idx % AI_COLORS.length];
    var h = makeHole(name, color, false,
      player.x + Math.cos(a) * d, player.z + Math.sin(a) * d, aiTypeFor(idx));
    // 体型跟随玩家：永远有比你大的威胁和比你小的猎物
    var lo = 0.35 + stage * 0.02, hi = 0.95 + stage * 0.04;
    var ratio = clamp(rnd(lo, hi), 0.35, 1.35);
    var targetR = clamp(player.radius * ratio, 0.8, CFG.R_MAX - 0.5);
    h.exp = expOf(targetR);
    h.radius = radiusOf(h.exp);
    h.score = Math.floor(h.exp * 10);
    syncHole(h);
    holes.push(h);
    return h;
  }

  function spawnHoles() {
    player = makeHole('你', SKINS[skinIdx], true, 0, 0);
    holes.push(player);
    for (var i = 0; i < CFG.AI_START; i++) spawnAI();
  }

  // 淘汰最弱 AI 并按玩家当前体型补一个，避免老 AI 变成固定经验包
  function rotateWeakestAI() {
    var weak = null, wi = -1, ws = 1e18;
    for (var i = 1; i < holes.length; i++) {
      var h = holes[i];
      if (!h.alive || h.score >= ws) continue;
      ws = h.score; weak = h; wi = i;
    }
    if (!weak) return;
    scene.remove(weak.group);
    holes.splice(wi, 1);
    spawnAI();
  }

  // ==================== 吞噬 ====================
  function startFall(obj, hole) {
    obj.fall = {
      t: 0, dur: 0.42 + obj.s * 0.012,
      sx: obj.x, sz: obj.z,
      cx: hole.x, cz: hole.z,
      rot: obj.mesh.rotation.y,
      obj: hole
    };
    obj.alive = false;
    hole.eaten++;
    hole.exp += obj.e;
    hole.score += obj.e * 10;
    var nr = radiusOf(hole.exp);
    if (Math.floor(nr) > Math.floor(hole.radius)) sfxLevel();
    hole.radius = nr;
    sfxEat(obj.lv);
    if (hole.isPlayer) {
      shake = Math.min(1.2, shake + 0.12 + obj.lv * 0.16);
      floatText('+' + obj.e * 10, obj.x, obj.z, obj.lv);
    }
  }

  function updateOcclusion(dt) {
    var px = player.x, pz = player.z, pr = player.radius;
    for (var i = 0; i < objects.length; i++) {
      var o = objects[i];
      if (!o.alive || o.lv < 2) continue;
      var d = Math.hypot(o.x - px, o.z - pz);
      var want = 1;
      if (o.lv === 2 && d < pr + 4) want = 0.6;
      else if (o.lv === 3 && d < pr + 7) want = 0.5;
      else if (o.lv === 4 && d < pr + 11) want = 0.42;
      o.mesh.scale.y = lerp(o.mesh.scale.y, want, 1 - Math.pow(0.002, dt));
    }
  }

  function updateFalls(dt) {
    for (var i = objects.length - 1; i >= 0; i--) {
      var o = objects[i];
      if (!o.fall) continue;
      var f = o.fall;
      f.t += dt;
      var k = clamp(f.t / f.dur, 0, 1);
      var ease = k * k;
      var nx = lerp(f.sx, f.cx, ease * 0.85);
      var nz = lerp(f.sz, f.cz, ease * 0.85);
      var ny = -ease * (3.2 + f.obj.radius * 0.4);
      o.mesh.position.set(nx, ny, nz);
      o.mesh.scale.setScalar(Math.max(0.05, 1 - ease * 0.92));
      o.mesh.rotation.y = f.rot + ease * 2.4;
      f.cx = f.obj.x; f.cz = f.obj.z;
      if (k >= 1) {
        scene.remove(o.mesh);
        objects.splice(i, 1);
      }
    }
  }

  function checkEatProps(h) {
    var r = h.radius * CFG.EAT_RATIO, r2 = r * r;
    for (var i = 0; i < objects.length; i++) {
      var o = objects[i];
      if (!o.alive || o.s >= r) continue;
      var dx = o.x - h.x, dz = o.z - h.z;
      if (dx * dx + dz * dz < r2) startFall(o, h);
    }
  }

  function checkEatHoles() {
    for (var i = 0; i < holes.length; i++) {
      var a = holes[i]; if (!a.alive) continue;
      for (var j = 0; j < holes.length; j++) {
        if (i === j) continue;
        var b = holes[j]; if (!b.alive) continue;
        if (b.radius >= a.radius * CFG.EAT_RATIO) continue;
        var dx = b.x - a.x, dz = b.z - a.z;
        if (dx * dx + dz * dz < a.radius * a.radius * 0.55) devour(a, b);
      }
    }
  }

  function devour(eater, victim) {
    victim.lastKiller = eater.isPlayer ? '你' : eater.name;
    eater.exp += victim.exp * 0.5;
    eater.score += 300 + Math.floor(victim.radius * 40);
    eater.kills++;
    eater.radius = radiusOf(eater.exp);
    sfxKill();
    if (eater.isPlayer) {
      shake = 1.4;
      killMsg('你 吞噬了 ' + victim.name);
      floatText('+KO', victim.x, victim.z, 5);
    } else if (victim.isPlayer) {
      killMsg(eater.name + ' 吞噬了你');
    } else {
      killMsg(eater.name + ' 吞噬了 ' + victim.name);
    }
    killVictim(victim);
  }

  function killVictim(v) {
    v.alive = false;
    v.group.visible = false;
    if (v.isPlayer) {
      // 一命制：玩家被吞噬 → 死亡过渡 → 结算，不复活
      gameState = 'dying';
      deathT = 1.3;
      deathBy = v.lastKiller || '对手';
    } else {
      v.respawn = 3;
    }
  }

  function respawnHole(h) {
    // 复活也跟随玩家体型，保证永远有威胁而非送经验包
    var lo = 0.5 + stage * 0.02, hi = 0.95 + stage * 0.04;
    var ratio = clamp(rnd(lo, hi), 0.45, 1.35);
    var r = clamp(player.radius * ratio, 0.8, CFG.R_MAX - 0.5);
    var a = rnd(0, Math.PI * 2), d = rnd(45, 75);
    h.x = player.x + Math.cos(a) * d;
    h.z = player.z + Math.sin(a) * d;
    h.exp = expOf(r);
    h.radius = radiusOf(h.exp);
    h.alive = true;
    h.group.visible = true;
    syncHole(h);
    if (h.ai) { h.ai.state = 'forage'; h.ai.chaseT = 0; h.ai.senseT = 0; }
  }

  // ==================== AI ====================
  function updateAI(h, dt) {
    var ai = h.ai;
    ai.senseT -= dt;
    if (ai.senseT <= 0) { ai.senseT = 0.5; sense(h); }

    var dx = ai.tx - h.x, dz = ai.tz - h.z;
    var dist = Math.hypot(dx, dz);
    if (dist < 0.1) { dx = Math.cos(ai.deflect); dz = Math.sin(ai.deflect); dist = 1; }

    var moved = Math.hypot(h.x - ai.lastX, h.z - ai.lastZ);
    if (moved < 0.05 && dt > 0) ai.stuckT += dt; else ai.stuckT = 0;
    if (ai.stuckT > 1.5) {
      ai.deflect = rnd(0, Math.PI * 2);
      ai.tx = h.x + Math.cos(ai.deflect) * 30;
      ai.tz = h.z + Math.sin(ai.deflect) * 30;
      ai.stuckT = 0;
      dx = ai.tx - h.x; dz = ai.tz - h.z; dist = Math.hypot(dx, dz) || 1;
    }
    ai.lastX = h.x; ai.lastZ = h.z;

    var sp = speedOf(h);
    h.vx = dx / dist * sp;
    h.vz = dz / dist * sp;
    moveHole(h, dt);
    if (ai.state === 'chase') {
      ai.chaseT -= dt;
      if (ai.chaseT <= 0) { ai.state = 'forage'; pickForageTarget(h); }
    }
  }

  function sense(h) {
    var ai = h.ai;
    var warn = 26 + h.radius * 2.2;
    var threat = null, td = 1e9, prey = null, pd = 1e9;
    for (var i = 0; i < holes.length; i++) {
      var o = holes[i];
      if (o === h || !o.alive) continue;
      var d = Math.hypot(o.x - h.x, o.z - h.z);
      if (d > warn * 1.8) continue;
      if (o.radius > h.radius * 1.1 && d < td) { threat = o; td = d; }
      if (o.radius < h.radius * 0.8 && d < pd && d < warn) { prey = o; pd = d; }
    }
    if (threat) {
      ai.state = 'flee';
      var ang = Math.atan2(h.z - threat.z, h.x - threat.x);
      ai.tx = h.x + Math.cos(ang) * 40;
      ai.tz = h.z + Math.sin(ang) * 40;
    } else if (prey && ai.type !== 'calm' && (ai.type === 'aggressive' || Math.random() < 0.4)) {
      ai.state = 'chase';
      ai.chaseT = ai.type === 'aggressive' ? 4 : 2.4;
      ai.target = prey;
      ai.tx = prey.x; ai.tz = prey.z;
    } else {
      if (ai.state !== 'forage') pickForageTarget(h);
      if (!ai.target || Math.hypot(ai.tx - h.x, ai.tz - h.z) < 6 || Math.random() < 0.12) pickForageTarget(h);
    }
  }

  function pickForageTarget(h) {
    var ai = h.ai;
    var best = null, bestScore = -1;
    var range = 34 + h.radius * 1.5;
    for (var k = 0; k < 26; k++) {
      var o = objects[rndi(0, objects.length - 1)];
      if (!o || !o.alive || o.s >= h.radius * CFG.EAT_RATIO) continue;
      var d = Math.hypot(o.x - h.x, o.z - h.z);
      if (d > range) continue;
      var sc = o.e / (1 + d * 0.06);
      if (sc > bestScore) { bestScore = sc; best = o; }
    }
    if (best) { ai.tx = best.x; ai.tz = best.z; ai.target = best; }
    else {
      var a = rnd(0, Math.PI * 2);
      ai.tx = h.x + Math.cos(a) * 28; ai.tz = h.z + Math.sin(a) * 28; ai.target = null;
    }
  }

  function moveHole(h, dt) {
    h.x += h.vx * dt;
    h.z += h.vz * dt;
    syncHole(h);
  }

  // ==================== 相机 ====================
  var camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  function updateCamera(dt) {
    var h = player;
    var dist = 17 + h.radius * 1.8;
    var height = 32 + h.radius * 2.4;
    camPos.set(h.x, height, h.z + dist);
    var lerpK = 1 - Math.pow(0.001, dt);
    camera.position.lerp(camPos, lerpK);
    camLook.set(h.x, 0, h.z);
    if (shake > 0) {
      camera.position.x += rnd(-shake, shake) * 0.7;
      camera.position.y += rnd(-shake, shake) * 0.5;
      shake = Math.max(0, shake - dt * 3.2);
    }
    camera.lookAt(camLook);
  }

  // ==================== UI ====================
  function updateSkin() {
    dom.skinDot.style.background = hex(SKINS[skinIdx]);
    dom.skinDot.style.color = hex(SKINS[skinIdx]);
  }
  function killMsg(txt) {
    var d = document.createElement('div');
    d.className = 'killmsg'; d.textContent = txt;
    dom.killfeed.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 3000);
  }
  function floatText(txt, x, z, lv) {
    tmpV.set(x, 2 + lv, z).project(camera);
    if (tmpV.z > 1) return;
    var sx = (tmpV.x * 0.5 + 0.5) * window.innerWidth;
    var sy = (-tmpV.y * 0.5 + 0.5) * window.innerHeight;
    var d = document.createElement('div');
    d.className = 'floater'; d.textContent = txt;
    d.style.left = sx + 'px'; d.style.top = sy + 'px';
    d.style.fontSize = (16 + Math.min(lv, 5) * 3) + 'px';
    dom.floaters.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 900);
  }
  function updateHUD() {
    dom.timer.textContent = fmtTime(elapsed);
    dom.stageLv.textContent = stage;
    dom.aiCount.textContent = holes.length - 1;
    dom.mySize.textContent = player.radius.toFixed(1);
    dom.myScore.textContent = player.score;
    dom.bestScore.textContent = Math.max(bestScore, player.score);
    var sorted = holes.slice().sort(function (a, b) { return b.score - a.score; });
    var rows = '';
    for (var i = 0; i < Math.min(4, sorted.length); i++) {
      var h = sorted[i];
      rows += '<div class="row' + (h.isPlayer ? ' me' : '') + '"><span class="rank">' + (i+1) +
        '</span><span class="dot" style="background:' + hex(h.color) + '"></span>' +
        '<span class="nm">' + h.name + '</span><span class="sc">' + h.score + '</span></div>';
    }
    dom.boardRows.innerHTML = rows;
  }

  function showResult() {
    saveBest();
    dom.finalRank.textContent = deathBy ? ('被 ' + deathBy + ' 吞噬') : '本局结束';
    dom.finalTime.textContent = fmtTime(elapsed);
    dom.finalScore.textContent = player.score;
    dom.finalEaten.textContent = player.eaten;
    dom.finalKills.textContent = player.kills;
    dom.finalStage.textContent = stage;
    dom.finalSize.textContent = player.radius.toFixed(1);
    dom.hud.classList.add('hidden');
    dom.result.classList.remove('hidden');
    dom.homeBest.textContent = fmtTime(bestTime);
    gameState = 'result';
  }

  // ==================== 流程 ====================
  function startGame() {
    audio();
    clearWorld();
    dom.floaters.innerHTML = '';
    dom.killfeed.innerHTML = '';
    spawnHoles();
    updateChunks();
    elapsed = 0;
    stage = (!isNaN(DEBUG_STAGE) && DEBUG_STAGE > 1) ? DEBUG_STAGE : 1;
    shake = 0; deathBy = ''; deathT = 0; rotateT = 18;
    gameState = 'play';
    dom.home.classList.add('hidden');
    dom.result.classList.add('hidden');
    dom.hud.classList.remove('hidden');
    dom.respawn.classList.add('hidden');
    camera.position.set(0, 32, 18);
    updateHUD();
  }

  function goHome() {
    saveBest();
    gameState = 'home';
    dom.result.classList.add('hidden');
    dom.hud.classList.add('hidden');
    dom.home.classList.remove('hidden');
    dom.homeBest.textContent = fmtTime(bestTime);
    buildMenuPreview();
  }

  function buildMenuPreview() {
    if (!player) {
      player = makeHole('你', SKINS[skinIdx], true, 0, 0);
      holes.push(player);
    }
    camera.position.set(0, 26, 30);
    camera.lookAt(0, 0, 0);
  }

  // ==================== 输入 ====================
  function bindUI() {
    dom.startBtn.addEventListener('click', startGame);
    dom.againBtn.addEventListener('click', startGame);
    dom.homeBtn.addEventListener('click', goHome);
    dom.endBtn.addEventListener('click', showResult);
    function switchSkin(delta) {
      skinIdx = (skinIdx + delta + SKINS.length) % SKINS.length;
      updateSkin();
      if (gameState === 'home') {
        if (player) scene.remove(player.group);
        holes = []; player = null;
        buildMenuPreview();
      }
    }
    dom.skinPrev.addEventListener('click', function () { switchSkin(-1); });
    dom.skinNext.addEventListener('click', function () { switchSkin(1); });
  }

  function bindInput() {
    var el = renderer.domElement;
    function down(e) {
      if (gameState !== 'play') return;
      var p = e.touches ? e.touches[0] : e;
      input.active = true; input.sx = p.clientX; input.sy = p.clientY;
      input.dx = 0; input.dy = 0;
      dom.joystick.style.display = 'block';
      dom.joystick.style.left = p.clientX + 'px';
      dom.joystick.style.top = p.clientY + 'px';
      dom.joystick.querySelector('i').style.transform = 'translate(-50%,-50%)';
    }
    function move(e) {
      if (!input.active || gameState !== 'play') return;
      e.preventDefault();
      var p = e.touches ? e.touches[0] : e;
      var dx = p.clientX - input.sx, dy = p.clientY - input.sy;
      var len = Math.hypot(dx, dy) || 1;
      var mag = Math.min(1, len / 70);
      input.dx = dx / len * mag; input.dy = dy / len * mag;
      dom.joystick.querySelector('i').style.transform = 'translate(calc(-50% + ' + (input.dx*26) + 'px),calc(-50% + ' + (input.dy*26) + 'px))';
    }
    function up() { input.active = false; input.dx = 0; input.dy = 0; dom.joystick.style.display = 'none'; }
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
    el.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('keydown', function (e) {
      keys[e.code] = true;
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].indexOf(e.code) >= 0) e.preventDefault();
    });
    window.addEventListener('keyup', function (e) { keys[e.code] = false; });
  }

  // ==================== 主循环 ====================
  function loop() {
    requestAnimationFrame(loop);
    var dt = Math.min(clock.getDelta(), 0.05);

    if (gameState === 'play') {
      elapsed += dt;
      if (!isNaN(DEBUG_DIE) && DEBUG_DIE > 0 && elapsed >= DEBUG_DIE && holes.length > 1) {
        devour(holes[1], player);
      }
      var newStage = Math.floor(elapsed / CFG.STAGE_SEC) + 1;
      if (newStage > stage) {
        stage = newStage;
        sfxStage();
        killMsg('难度提升 · 第 ' + stage + ' 阶 · 新对手加入');
      }
      // 按难度增加 AI
      var wantAI = Math.min(CFG.AI_MAX, CFG.AI_START + stage - 1);
      while (holes.length - 1 < wantAI) spawnAI();
      // 定期淘汰最弱 AI，保持竞争强度
      rotateT -= dt;
      if (rotateT <= 0) {
        rotateT = Math.max(9, 18 - stage * 0.6);
        rotateWeakestAI();
      }

      var sp = speedOf(player);
      player.vx = input.dx * sp;
      player.vz = input.dy * sp;
      if (AUTO) {
        var best = null, bd = 1e9;
        for (var ao = 0; ao < objects.length; ao++) {
          var ob = objects[ao];
          if (!ob.alive || ob.s >= player.radius * CFG.EAT_RATIO) continue;
          var ad = Math.hypot(ob.x - player.x, ob.z - player.z);
          if (ad < bd) { bd = ad; best = ob; }
        }
        if (best) {
          var ang = Math.atan2(best.z - player.z, best.x - player.x);
          player.vx = Math.cos(ang) * sp; player.vz = Math.sin(ang) * sp;
        }
      }
      if (keys['ArrowLeft'] || keys['KeyA']) player.vx = -sp;
      if (keys['ArrowRight'] || keys['KeyD']) player.vx = sp;
      if (keys['ArrowUp'] || keys['KeyW']) player.vz = -sp;
      if (keys['ArrowDown'] || keys['KeyS']) player.vz = sp;
      moveHole(player, dt);
      updateChunks();

      for (var i = 0; i < holes.length; i++) {
        var h = holes[i];
        if (!h.alive) continue;
        if (!h.isPlayer) updateAI(h, dt);
        checkEatProps(h);
      }
      checkEatHoles();
      updateFalls(dt);
      updateOcclusion(dt);
      updateCamera(dt);
      updateHUD();

      // 只让 AI 复活；玩家被吃走 dying 分支
      for (var r = 0; r < holes.length; r++) {
        var v = holes[r];
        if (!v.alive && !v.isPlayer) {
          v.respawn -= dt;
          if (v.respawn <= 0) respawnHole(v);
        }
      }
    } else if (gameState === 'dying') {
      // 死亡过渡：镜头停留一下再结算
      deathT -= dt;
      updateFalls(dt);
      updateCamera(dt);
      if (deathT <= 0) showResult();
    } else if (gameState === 'home') {
      if (player) { player.group.rotation.y += dt * 0.15; player.group.position.x = Math.sin(clock.elapsedTime * 0.4) * 4; }
    } else if (gameState === 'result') {
      updateCamera(dt);
    }

    var n = 0;
    for (var q = 0; q < holes.length && n < CFG.MAX_HOLES; q++) {
      var hh = holes[q];
      if (!hh.alive) continue;
      holeUniform.uHoles.value[n].set(hh.x, hh.z, hh.radius);
      n++;
    }
    holeUniform.uHoleCount.value = n;

    if (DEBUG && gameState === 'play') {
      var stat = {
        t: Math.round(elapsed), st: stage,
        obj: objects.length, chk: Object.keys(chunks).length,
        holes: holes.length, score: player.score, r: +player.radius.toFixed(1),
        px: Math.round(player.x), pz: Math.round(player.z)
      };
      window.__hole = stat;
    }
    renderer.render(scene, camera);
  }

  init();
})();

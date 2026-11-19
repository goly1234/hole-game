/* 黑洞吞噬大作战 - 单机人机版
 * 横屏 / Three.js r128 / 无外部资源 / 离线可运行
 * 核心方案：地面 shader 挖孔 + 运动学下坠，物体超出洞口的部分被地面深度遮挡，不穿模
 */
(function () {
  'use strict';

  // ==================== 配置 ====================
  var CFG = {
    MAP: 200,            // 地图边长
    ROUND: 120,          // 单局秒数
    HOLE_BASE: 1.0,      // 初始半径
    GROW: 0.32,          // 成长系数 radius = BASE + GROW*sqrt(exp)
    EAT_RATIO: 0.85,     // 吞噬尺寸比
    SPEED_BASE: 13,      // 基础速度
    SPEED_GROW: 0.55,    // 速度随半径增量
    COUNT: 520,          // 场景物体总数
    AI_NUM: 7
  };

  // 物体等级：[尺寸半径, 经验, 需要洞半径, 颜色组, 占比]
  var LV = [
    { s: 0.6,  e: 1,  need: 1.0,  p: 0.40, c: [0x9aa7b5, 0xd9534f, 0x8b6f47] },
    { s: 1.5,  e: 3,  need: 2.0,  p: 0.30, c: [0x4aa3df, 0x5cb85c, 0xe0a030] },
    { s: 3.0,  e: 8,  need: 4.0,  p: 0.15, c: [0x3f7fbf, 0x6b8e23, 0xc0753a] },
    { s: 6.0,  e: 20, need: 7.5,  p: 0.10, c: [0x7a8a99, 0xa08060, 0x557a55] },
    { s: 10.0, e: 50, need: 12.0, p: 0.05, c: [0x6c7a89, 0x4a6fa5, 0x8a6f5c] }
  ];

  var SKINS = [0x4cc9f0, 0xf72585, 0xffd166, 0x06d6a0, 0xb388ff, 0xff6b6b, 0x64dfdf];
  var AI_NAMES = ['路人甲', '黑洞侠', '贪吃鬼', '小霸王', '路人乙', '吞天兽', '无敌手', '追风者', '大胃王'];
  var AI_COLORS = [0xff6b6b, 0xffd166, 0x06d6a0, 0xb388ff, 0xf72585, 0x4cc9f0, 0xfa7d09];

  // ==================== 工具 ====================
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function rndi(a, b) { return Math.floor(rnd(a, b + 1)); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function hex(n) { return '#' + ('000000' + n.toString(16)).slice(-6); }

  // ==================== 状态 ====================
  var renderer, scene, camera, ground, groundMat;
  var objects = [], holes = [], player;
  var raycaster = new THREE.Raycaster();
  var clock = new THREE.Clock();
  var gameState = 'home'; // home | play | respawn | result
  // 调试参数：?t=秒数 缩短单局；?auto=1 玩家自动觅食（不带参数时对正式游戏无影响）
  var QS = new URLSearchParams(location.search);
  var DEBUG_T = parseFloat(QS.get('t'));
  var AUTO = QS.get('auto') === '1';
  var timeLeft = CFG.ROUND, skinIdx = 0;
  var shake = 0, lastTick = -1;
  var input = { active: false, sx: 0, sy: 0, dx: 0, dy: 0 };
  var keys = {};
  var tmpV = new THREE.Vector3();
  var holeUniform = { uHoles: { value: [] }, uHoleCount: { value: 0 } };
  for (var i = 0; i < 8; i++) holeUniform.uHoles.value.push(new THREE.Vector3());

  // ==================== DOM ====================
  var $ = function (id) { return document.getElementById(id); };
  var dom = {};
  ['home', 'hud', 'result', 'timer', 'mySize', 'myScore', 'boardRows', 'killfeed',
    'floaters', 'respawn', 'respawnNum', 'skinDot', 'startBtn', 'skinPrev', 'skinNext',
    'finalRank', 'finalScore', 'finalEaten', 'finalKills', 'finalSize', 'againBtn',
    'homeBtn', 'joystick'].forEach(function (k) { dom[k] = $(k); });

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
  function sfxTick() { beep(900, 0.05, 'triangle', 0.08); }
  function sfxLevel() { beep(520, 0.16, 'triangle', 0.12); setTimeout(function () { beep(780, 0.18, 'triangle', 0.1); }, 100); }

  // ==================== 初始化 ====================
  function init() {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x0a0e15, 1);
    $('game').appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0e15, 90, 220);

    camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 600);

    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    var dir = new THREE.DirectionalLight(0xffffff, 0.75);
    dir.position.set(-60, 120, 40);
    scene.add(dir);

    buildGround();
    buildMap();
    buildMenuPreview();

    bindUI();
    bindInput();
    window.addEventListener('resize', onResize);
    updateSkin();
    loop();
    dom.home.classList.remove('hidden');
  }

  function onResize() {
    if (!renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ==================== 地面（shader 挖孔） ====================
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
      'uniform vec3 uHoles[8];',
      'uniform int uHoleCount;',
      'varying vec3 vW;',
      'void main(){',
      '  vec2 p = vW.xz;',
      '  for(int i=0;i<8;i++){',
      '    if(i>=uHoleCount) break;',
      '    vec2 c = uHoles[i].xy; float r = uHoles[i].z;',
      '    if(distance(p,c) < r) discard;',
      '  }',
      '  vec2 g = abs(fract(vW.xz/10.0)-0.5);',
      '  float line = smoothstep(0.45,0.5,max(g.x,g.y));',
      '  vec3 col = mix(vec3(0.27,0.32,0.38), vec3(0.17,0.20,0.24), line);',
      '  float b = fract(sin(dot(floor(vW.xz/10.0),vec2(12.9898,78.233)))*43758.5453);',
      '  if(b>0.86) col = vec3(0.20,0.33,0.22);',
      '  float edge = smoothstep(0.0,14.0, abs(p.x)-86.0);',
      '  col = mix(col, vec3(0.10,0.13,0.17), clamp(edge,0.0,1.0));',
      '  gl_FragColor = vec4(col,1.0);',
      '}'
    ].join('\n');
    groundMat = new THREE.ShaderMaterial({
      uniforms: holeUniform, vertexShader: vs, fragmentShader: fs, side: THREE.DoubleSide
    });
    var geo = new THREE.PlaneGeometry(CFG.MAP + 40, CFG.MAP + 40, 1, 1);
    ground = new THREE.Mesh(geo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    scene.add(ground);

    // 洞底（深色圆盘，放很低，营造深度）
    var bottomGeo = new THREE.CircleGeometry(1, 40);
    var bottomMat = new THREE.MeshBasicMaterial({ color: 0x05070b, side: THREE.DoubleSide });
    ground.userData.bottomGeo = bottomGeo;
    ground.userData.bottomMat = bottomMat;
  }

  // ==================== 地图与物体 ====================
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

  // 按等级生成一个低多边形物体
  function makeProp(level, x, z) {
    var g = new THREE.Group();
    var C = LV[level].c, c0 = pick(C), c1 = pick(C), c2 = pick(C);
    var rot = rnd(0, Math.PI * 2);
    switch (level) {
      case 0: // 路灯/消防栓/垃圾桶/行人/栅栏
        switch (rndi(0, 4)) {
          case 0: part(g, cyl(0.05, 0.06, 2.2, 6), 0x555, 0, 1.1, 0); part(g, sph(0.22, 8), 0xffe9a8, 0, 2.3, 0); break;
          case 1: part(g, cyl(0.22, 0.24, 0.7, 8), 0xd0392b, 0, 0.35, 0); part(g, cyl(0.28, 0.28, 0.1, 8), 0x922, 0, 0.72, 0); break;
          case 2: part(g, cyl(0.3, 0.26, 0.8, 8), c0, 0, 0.4, 0); part(g, cyl(0.32, 0.32, 0.08, 8), 0x333, 0, 0.82, 0); break;
          case 3: part(g, cyl(0.16, 0.2, 1.1, 6), c1, 0, 0.55, 0); part(g, sph(0.2, 8), 0xe0b08a, 0, 1.3, 0); break;
          default: for (var i = 0; i < 4; i++) part(g, box(0.1, 0.9, 0.1), 0x9aa, i * 0.3 - 0.45, 0.45, 0); part(g, box(1.4, 0.08, 0.08), 0x9aa, 0, 0.8, 0);
        }
        break;
      case 1: // 长椅/灌木/小轿车/邮箱/广告牌
        switch (rndi(0, 4)) {
          case 0: part(g, box(2.2, 0.18, 0.7), 0xa9743f, 0, 0.5, 0); part(g, box(2.2, 0.7, 0.15), 0xa9743f, 0, 0.85, -0.3); break;
          case 1: part(g, sph(0.9, 8), 0x4a9a4a, 0, 0.7, 0); part(g, sph(0.7, 8), 0x5caf5c, 0.5, 0.9, 0.3); break;
          case 2: part(g, box(2.6, 0.7, 1.3), c0, 0, 0.6, 0); part(g, box(1.3, 0.6, 1.15), 0x335577, -0.2, 1.15, 0); part(g, cyl(0.28, 0.28, 0.15, 10), 0x222, -0.85, 0.3, 0.6).rotation.z = Math.PI/2; part(g, cyl(0.28,0.28,0.15,10),0x222,0.85,0.3,0.6).rotation.z=Math.PI/2; break;
          case 3: part(g, cyl(0.3, 0.3, 1.2, 8), 0x2b6cb0, 0, 0.6, 0); part(g, box(0.5, 0.3, 0.4), 0x1a4a80, 0, 1.3, 0); break;
          default: part(g, cyl(0.08, 0.08, 2.6, 6), 0x777, -1, 1.3, 0); part(g, cyl(0.08,0.08,2.6,6),0x777,1,1.3,0); part(g, box(2.4,1.3,0.12), c1, 0, 2.4, 0);
        }
        break;
      case 2: // 公交车/货车/大树/凉亭/平房
        switch (rndi(0, 4)) {
          case 0: part(g, box(5.2, 2.2, 2.0), 0xf0a500, 0, 1.3, 0); for (var w=0;w<5;w++) part(g, box(0.7,0.8,0.05), 0x335577, -1.9+w*0.95, 1.7, 1.03); break;
          case 1: part(g, box(3.4, 1.5, 1.8), c0, -0.6, 1.0, 0); part(g, box(1.6, 1.9, 1.7), 0xeee, 1.4, 1.2, 0); break;
          case 2: part(g, cyl(0.4, 0.55, 2.6, 7), 0x6b4f2a, 0, 1.3, 0); part(g, sph(1.7, 8), 0x3f8f3f, 0, 3.4, 0); part(g, sph(1.3,8), 0x4fa04f, 1.0, 3.0, 0.4); break;
          case 3: for (var p=0;p<4;p++){var a=p*Math.PI/2;part(g,cyl(0.12,0.12,2,6),0x9a7b4f,Math.cos(a)*1.6,1,Math.sin(a)*1.6);} part(g, cyl(2.4,2.4,0.2,8), c2, 0, 2.1, 0); break;
          default: part(g, box(5, 2.8, 4), c0, 0, 1.4, 0); part(g, cyl(3.6,3.6,0.2,4), 0x9a4a3a, 0, 2.95, 0).rotation.y=Math.PI/4;
        }
        break;
      case 3: // 便利店/居民楼/写字楼
        var h = rnd(6, 9);
        switch (rndi(0, 2)) {
          case 0: part(g, box(7, 4, 6), 0xdfe4ea, 0, 2, 0); part(g, box(7.4, 0.6, 6.4), 0xe74c3c, 0, 4.2, 0); part(g, box(4, 2.4, 0.1), 0x5dade2, 0, 2.2, 3.05); break;
          case 1: part(g, box(8, h, 7), c0, 0, h/2, 0); for (var f=0;f<3;f++) for(var q=0;q<3;q++) part(g, box(1.2,1.2,0.1),0x8fd3f4,-2.4+q*2.4,2+f*2,3.55); break;
          default: part(g, box(7, h+2, 7), 0x8aa0b5, 0, (h+2)/2, 0); part(g, box(7.4,0.4,7.4),0x5b6b7b,0,h+2.2,0);
        }
        break;
      case 4: // 摩天楼/体育馆/地标
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

  function buildMap() {
    var half = CFG.MAP / 2 - 6;
    for (var i = 0; i < CFG.COUNT; i++) {
      var r = Math.random(), acc = 0, lv = 0;
      for (var l = 0; l < LV.length; l++) { acc += LV[l].p; if (r <= acc) { lv = l; break; } }
      var x = rnd(-half, half), z = rnd(-half, half);
      // 中心留空给玩家出生
      if (Math.abs(x) < 8 && Math.abs(z) < 8) { x += 14; }
      var g = makeProp(lv, x, z);
      scene.add(g);
      objects.push({ mesh: g, x: x, z: z, s: LV[lv].s, e: LV[lv].e, lv: lv, alive: true, fall: null });
    }
  }

  // ==================== 黑洞 ====================
  function makeHole(name, color, isPlayer, x, z, personality) {
    var grp = new THREE.Group();
    // 洞底圆盘
    var bottom = new THREE.Mesh(ground.userData.bottomGeo, ground.userData.bottomMat);
    bottom.rotation.x = -Math.PI / 2; bottom.position.y = -2.6; bottom.scale.setScalar(1);
    grp.add(bottom);
    // 发光环
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1.06, 48),
      new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide, transparent: true, opacity: 0.92 })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    grp.add(ring);
    // 内圈暗环
    var inner = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.88, 48),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
    );
    inner.rotation.x = -Math.PI / 2; inner.position.y = 0.02;
    grp.add(inner);
    // 名字标签
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
    sp.userData.canvas = cv; sp.userData.tex = tex; sp.userData.text = text; sp.userData.color = color;
    return sp;
  }

  function syncHole(h) {
    h.group.position.set(h.x, 0, h.z);
    h.ring.scale.setScalar(h.radius);
    h.bottom.scale.setScalar(h.radius * 0.99);
    h.label.position.y = h.radius * 1.1 + 1.6;
    h.label.scale.set(6, 1.5, 1);
  }

  function radiusOf(exp) { return CFG.HOLE_BASE + CFG.GROW * Math.sqrt(exp); }
  function speedOf(h) {
    var s = CFG.SPEED_BASE + h.radius * CFG.SPEED_GROW;
    if (h.ai && h.ai.type === 'calm') s *= 0.78;
    if (h.ai && h.ai.type === 'aggressive') s *= 1.06;
    return s;
  }

  function spawnHoles() {
    // 清掉旧的
    holes.forEach(function (h) { scene.remove(h.group); });
    holes = [];
    player = makeHole('你', SKINS[skinIdx], true, 0, 0);
    holes.push(player);
    // 位置：四周分散
    for (var i = 0; i < CFG.AI_NUM; i++) {
      var a = (i / CFG.AI_NUM) * Math.PI * 2 + rnd(-0.3, 0.3);
      var d = rnd(45, 80);
      var type = i < 2 ? 'aggressive' : i < 5 ? 'normal' : 'calm';
      holes.push(makeHole(AI_NAMES[i], AI_COLORS[i], false, Math.cos(a) * d, Math.sin(a) * d, type));
    }
  }

  // ==================== 吞噬 ====================
  function startFall(obj, hole) {
    obj.fall = {
      t: 0, dur: 0.42 + obj.s * 0.012,
      sx: obj.x, sz: obj.z, sy: 0,
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

  // 高处物体靠近玩家时压矮，避免遮挡黑洞
  function updateOcclusion(dt) {
    var px = player.x, pz = player.z, pr = player.radius;
    for (var i = 0; i < objects.length; i++) {
      var o = objects[i];
      if (!o.alive || o.lv < 2) continue;
      var d = Math.hypot(o.x - px, o.z - pz);
      var want = 1;
      if (o.lv === 2 && d < pr + 4) want = 0.55;
      else if (o.lv === 3 && d < pr + 7) want = 0.34;
      else if (o.lv === 4 && d < pr + 11) want = 0.22;
      var cur = o.mesh.scale.y;
      o.mesh.scale.y = lerp(cur, want, 1 - Math.pow(0.002, dt));
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
      // 水平向洞心收拢
      var nx = lerp(f.sx, f.cx, ease * 0.85);
      var nz = lerp(f.sz, f.cz, ease * 0.85);
      // Y 加速下坠
      var ny = -ease * (3.2 + f.obj.radius * 0.4);
      o.mesh.position.set(nx, ny, nz);
      var sc = 1 - ease * 0.92;
      o.mesh.scale.setScalar(Math.max(0.05, sc));
      o.mesh.rotation.y = f.rot + ease * 2.4;
      f.cx = f.obj.x; f.cz = f.obj.z;
      if (k >= 1) {
        scene.remove(o.mesh);
        objects.splice(i, 1);
      }
    }
  }

  // 检测单个洞吞物体
  function checkEatProps(h) {
    var r = h.radius * CFG.EAT_RATIO;
    var r2 = r * r;
    for (var i = 0; i < objects.length; i++) {
      var o = objects[i];
      if (!o.alive) continue;
      if (o.s >= r) continue;
      var dx = o.x - h.x, dz = o.z - h.z;
      if (dx * dx + dz * dz < r2) startFall(o, h);
    }
  }

  // 洞吃洞
  function checkEatHoles() {
    for (var i = 0; i < holes.length; i++) {
      var a = holes[i]; if (!a.alive) continue;
      for (var j = 0; j < holes.length; j++) {
        if (i === j) continue;
        var b = holes[j]; if (!b.alive) continue;
        if (b.radius >= a.radius * CFG.EAT_RATIO) continue;
        var dx = b.x - a.x, dz = b.z - a.z;
        if (dx * dx + dz * dz < a.radius * a.radius * 0.55) {
          devour(a, b);
        }
      }
    }
  }

  function devour(eater, victim) {
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
    v.respawn = 3;
  }

  function respawnHole(h) {
    var avg = 0, n = 0;
    holes.forEach(function (o) { if (o.alive) { avg += o.radius; n++; } });
    avg = n ? avg / n : 1;
    var r = Math.max(CFG.HOLE_BASE, avg * 0.5);
    var a = rnd(0, Math.PI * 2), d = CFG.MAP / 2 - 14;
    h.x = Math.cos(a) * d; h.z = Math.sin(a) * d;
    h.exp = Math.max(0, (r - CFG.HOLE_BASE) / CFG.GROW);
    h.exp = h.exp * h.exp;
    h.radius = r;
    h.alive = true;
    h.group.visible = true;
    syncHole(h);
    if (h.ai) { h.ai.state = 'forage'; h.ai.chaseT = 0; h.ai.senseT = 0; }
  }

  // ==================== AI 状态机 ====================
  function updateAI(h, dt) {
    var ai = h.ai;
    ai.senseT -= dt;
    if (ai.senseT <= 0) {
      ai.senseT = 0.5;
      sense(h);
    }

    var tx = ai.tx, tz = ai.tz;
    var dx = tx - h.x, dz = tz - h.z;
    var dist = Math.hypot(dx, dz);
    if (dist < 0.1) { dx = Math.cos(ai.deflect); dz = Math.sin(ai.deflect); dist = 1; }

    // 防卡死
    var moved = Math.hypot(h.x - ai.lastX, h.z - ai.lastZ);
    if (moved < 0.05 && dt > 0) ai.stuckT += dt; else ai.stuckT = 0;
    if (ai.stuckT > 1.5) {
      ai.deflect = rnd(0, Math.PI * 2);
      ai.tx = clamp(h.x + Math.cos(ai.deflect) * 30, -CFG.MAP/2+8, CFG.MAP/2-8);
      ai.tz = clamp(h.z + Math.sin(ai.deflect) * 30, -CFG.MAP/2+8, CFG.MAP/2-8);
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

    // 佛系AI不主动追人
    if (threat) {
      ai.state = 'flee';
      var ang = Math.atan2(h.z - threat.z, h.x - threat.x);
      ai.tx = clamp(h.x + Math.cos(ang) * 40, -CFG.MAP/2+8, CFG.MAP/2-8);
      ai.tz = clamp(h.z + Math.sin(ang) * 40, -CFG.MAP/2+8, CFG.MAP/2-8);
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
    // 粗采样：随机取若干物体，找可吃且高价值的
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
      ai.tx = clamp(h.x + Math.cos(a) * 28, -CFG.MAP/2+8, CFG.MAP/2-8);
      ai.tz = clamp(h.z + Math.sin(a) * 28, -CFG.MAP/2+8, CFG.MAP/2-8);
      ai.target = null;
    }
  }

  function moveHole(h, dt) {
    h.x = clamp(h.x + h.vx * dt, -CFG.MAP / 2 + 2, CFG.MAP / 2 - 2);
    h.z = clamp(h.z + h.vz * dt, -CFG.MAP / 2 + 2, CFG.MAP / 2 - 2);
    syncHole(h);
  }

  // ==================== 相机 ====================
  var camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  function updateCamera(dt) {
    var h = player;
    // 更陡的俯角(约60°)，减少高楼遮挡
    var dist = 17 + h.radius * 1.8;
    var height = 32 + h.radius * 2.4;
    var tx = h.x, ty = height, tz = h.z + dist;
    camPos.set(tx, ty, tz);
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
    var sx = (tmpV.x * 0.5 + 0.5) * window.innerWidth;
    var sy = (-tmpV.y * 0.5 + 0.5) * window.innerHeight;
    if (tmpV.z > 1) return;
    var d = document.createElement('div');
    d.className = 'floater'; d.textContent = txt;
    d.style.left = sx + 'px'; d.style.top = sy + 'px';
    d.style.fontSize = (16 + Math.min(lv, 5) * 3) + 'px';
    dom.floaters.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 900);
  }

  function updateHUD() {
    var sec = Math.max(0, Math.ceil(timeLeft));
    dom.timer.textContent = ('0' + Math.floor(sec / 60)).slice(-2) + ':' + ('0' + (sec % 60)).slice(-2);
    dom.timer.classList.toggle('urgent', sec <= 10);
    dom.mySize.textContent = player.radius.toFixed(1);
    dom.myScore.textContent = player.score;

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
    var sorted = holes.slice().sort(function (a, b) { return b.score - a.score; });
    var rank = sorted.indexOf(player) + 1;
    dom.finalRank.innerHTML = '第 ' + rank + ' 名<small>' + (rank === 1 ? '！冠军' : '') + '</small>';
    dom.finalScore.textContent = player.score;
    dom.finalEaten.textContent = player.eaten;
    dom.finalKills.textContent = player.kills;
    dom.finalSize.textContent = player.radius.toFixed(1);
    dom.hud.classList.add('hidden');
    dom.result.classList.remove('hidden');
    gameState = 'result';
  }

  // ==================== 流程 ====================
  function startGame() {
    audio();
    // 清理场景物体并重建
    objects.forEach(function (o) { scene.remove(o.mesh); });
    objects = [];
    dom.floaters.innerHTML = '';
    dom.killfeed.innerHTML = '';
    buildMap();
    spawnHoles();
    timeLeft = (!isNaN(DEBUG_T) && DEBUG_T > 0) ? DEBUG_T : CFG.ROUND;
    lastTick = -1;
    shake = 0;
    gameState = 'play';
    dom.home.classList.add('hidden');
    dom.result.classList.add('hidden');
    dom.hud.classList.remove('hidden');
    dom.respawn.classList.add('hidden');
    camera.position.set(0, 30, 30);
    updateHUD();
  }

  function goHome() {
    gameState = 'home';
    dom.result.classList.add('hidden');
    dom.hud.classList.add('hidden');
    dom.home.classList.remove('hidden');
    buildMenuPreview();
  }

  function buildMenuPreview() {
    if (!holes.length) return;
    // 主界面保留一个缓慢自转的预览洞
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
    dom.skinPrev.addEventListener('click', function () { skinIdx = (skinIdx + SKINS.length - 1) % SKINS.length; updateSkin(); if (player && gameState === 'home') { scene.remove(player.group); holes = []; player = null; buildMenuPreview(); } });
    dom.skinNext.addEventListener('click', function () { skinIdx = (skinIdx + 1) % SKINS.length; updateSkin(); if (player && gameState === 'home') { scene.remove(player.group); holes = []; player = null; buildMenuPreview(); } });
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
    function up() {
      input.active = false; input.dx = 0; input.dy = 0;
      dom.joystick.style.display = 'none';
    }
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
      timeLeft -= dt;
      // 玩家输入：屏幕上=世界-Z，右=世界+X
      var sp = speedOf(player);
      player.vx = input.dx * sp;
      player.vz = input.dy * sp;
      // 自动觅食（调试）
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
      // 键盘控制（外接键盘 / 调试）
      if (keys['ArrowLeft'] || keys['KeyA']) player.vx = -sp;
      if (keys['ArrowRight'] || keys['KeyD']) player.vx = sp;
      if (keys['ArrowUp'] || keys['KeyW']) player.vz = -sp;
      if (keys['ArrowDown'] || keys['KeyS']) player.vz = sp;
      moveHole(player, dt);

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

      // 复活
      for (var r = 0; r < holes.length; r++) {
        var v = holes[r];
        if (!v.alive) {
          v.respawn -= dt;
          if (v.isPlayer) {
            dom.respawn.classList.remove('hidden');
            dom.respawnNum.textContent = Math.max(1, Math.ceil(v.respawn));
          }
          if (v.respawn <= 0) {
            respawnHole(v);
            if (v.isPlayer) dom.respawn.classList.add('hidden');
          }
        }
      }

      // 倒计时音效
      var sec = Math.ceil(timeLeft);
      if (sec <= 10 && sec >= 0 && sec !== lastTick) { lastTick = sec; sfxTick(); }
      if (timeLeft <= 0) showResult();
    } else if (gameState === 'home') {
      if (player) { player.group.rotation.y += dt * 0.15; player.group.position.x = Math.sin(clock.elapsedTime * 0.4) * 4; }
    } else if (gameState === 'result') {
      updateCamera(dt);
    }

    // 更新地面洞 uniform
    var n = 0;
    for (var q = 0; q < holes.length && n < 8; q++) {
      var hh = holes[q];
      if (!hh.alive) continue;
      holeUniform.uHoles.value[n].set(hh.x, hh.z, hh.radius);
      n++;
    }
    holeUniform.uHoleCount.value = n;

    renderer.render(scene, camera);
  }

  init();
})();

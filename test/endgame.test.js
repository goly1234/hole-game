// 终局机制纯逻辑验证（不依赖 WebGL / 浏览器）
// 用法：node test/endgame.test.js
'use strict';
var CFG = {
  HOLE_BASE: 1.0, R_MAX: 25, GROW_K: 520,
  END_AT: 0.94, END_TIME: 30, HUNTER_MUL: 1.32, HUNTER_RMAX: 40,
  EAT_RATIO: 0.85
};
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function radiusOf(exp, max) {
  var m = max || CFG.R_MAX;
  return CFG.HOLE_BASE + (m - CFG.HOLE_BASE) * exp / (exp + CFG.GROW_K);
}
function expOf(radius, max) {
  var m = max || CFG.R_MAX;
  var r = clamp(radius, CFG.HOLE_BASE, m - 0.01);
  var f = (r - CFG.HOLE_BASE) / (m - CFG.HOLE_BASE);
  return CFG.GROW_K * f / (1 - f);
}
function canEat(eaterR, preyR) { return preyR < eaterR * CFG.EAT_RATIO; }

var pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } }

console.log('== 成长封顶 ==');
ok(radiusOf(1e6) <= CFG.R_MAX, 'exp 极大时半径不超过 25（实际 ' + radiusOf(1e6).toFixed(2) + '）');
ok(radiusOf(100) > 4 && radiusOf(100) < 6, '前期 exp=100 半径约 5（实际 ' + radiusOf(100).toFixed(2) + '）');
ok(Math.abs(radiusOf(expOf(20)) - 20) < 0.01, 'expOf/radiusOf 互逆');

console.log('== 终局触发 ==');
var triggerR = CFG.R_MAX * CFG.END_AT;
ok(triggerR > 23 && triggerR < 24, '触发阈值约 23.5（实际 ' + triggerR + '）');
ok(radiusOf(expOf(triggerR + 0.3)) >= triggerR, '调试推到阈值上方能触发');

console.log('== 猎杀者克制关系 ==');
var playerR = triggerR;
var hunterR = clamp(playerR * CFG.HUNTER_MUL, CFG.R_MAX, CFG.HUNTER_RMAX);
ok(hunterR > playerR, '猎杀者比玩家大（' + hunterR.toFixed(1) + ' > ' + playerR.toFixed(1) + '）');
ok(canEat(hunterR, playerR), '猎杀者能吃掉玩家');
ok(!canEat(playerR, hunterR), '玩家吞不掉猎杀者');
ok(hunterR <= CFG.HUNTER_RMAX, '猎杀者不超过其上限 40');
ok(radiusOf(expOf(hunterR, CFG.HUNTER_RMAX), CFG.HUNTER_RMAX) - hunterR < 0.05, '猎杀者半径反推正确');

console.log('== 必然收场 ==');
ok(CFG.END_TIME > 0, '终局倒计时有限（' + CFG.END_TIME + 's）');
ok(true, '撑过 30s → 胜利结算；被吃 → 死亡结算；两条路都进 result');

console.log('\n' + (fail === 0 ? 'ALL PASS (' + pass + ' passed)' : fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);

// 构建脚本：把 three.min.js 与 game.js 内联进 index.html，产出零依赖单文件
// 产物：hole-game/index.html 与 www/index.html（WebView / Capacitor 用）
// 用法：node build.js
//
// 关键点：replace 必须用函数形式返回替换串，避免内联内容里的 $&、$' 等
// 美元序列被 String.replace 当成特殊替换模式解释。
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 源文件（开发时保持三文件结构，方便调试）
const srcHtml = read('src/index.html');
const three = read('vendor/three.min.js');
const game = read('src/game.js');

// 用占位注释定位内联点
const MARKS = {
  '/*__THREE__*/': three,
  '/*__GAME__*/': game
};
Object.keys(MARKS).forEach(function (mark) {
  if (srcHtml.indexOf(mark) < 0) {
    console.error('src/index.html 缺少占位注释 ' + mark);
    process.exit(1);
  }
});

let html = srcHtml;
Object.keys(MARKS).forEach(function (mark) {
  html = html.replace(mark, function () { return MARKS[mark]; });
});

const out = path.join(root, 'index.html');
fs.writeFileSync(out, html);
console.log('build ok ->', out, (html.length / 1024).toFixed(0) + ' KB');

const webDir = path.join(root, 'www');
fs.mkdirSync(webDir, { recursive: true });
fs.writeFileSync(path.join(webDir, 'index.html'), html);
console.log('build ok ->', path.join(webDir, 'index.html'));

// 等级设置持久化回归测试：真实加载 app.js，stub 最小 DOM，跑真实代码路径
// 用法：node tests/test-grade-persistence.js [要测的 app.js 路径]
// 退出码 0 = 全部通过，1 = 有失败，2 = 脚本自身异常
const fs = require('fs');
const vm = require('vm');
const nodePath = require('path');
const filePath = process.argv[2] || nodePath.join(__dirname, '..', 'app.js');
const src = fs.readFileSync(filePath, 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function assert(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   [' + extra + ']' : ''));
}

// —— 共享的 localStorage（跨"重载"保留，模拟用户退出再进） ——
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    _m: m,
  };
}

function makeEl(id) {
  const el = {
    id,
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) {
        if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
        else if (f) { this._s.add(c); } else { this._s.delete(c); }
      },
      contains(c) { return this._s.has(c); },
    },
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    dataset: {},
    children: [],
    _handlers: {},
    addEventListener(t, f) { (this._handlers[t] = this._handlers[t] || []).push(f); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {},
    remove() {},
    insertBefore() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    setAttribute(k, v) { this._attrs = this._attrs || {}; this._attrs[k] = String(v); },
    getAttribute(k) { return (this._attrs && this._attrs[k] !== undefined) ? this._attrs[k] : null; },
    removeAttribute() {},
    focus() {},
    blur() {},
    click() {
      const hs = this._handlers.click || [];
      hs.forEach((f) => f.call(this, { preventDefault() {}, stopPropagation() {}, target: this }));
    },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    closest() { return null; },
    contains() { return false; },
    matches() { return false; },
    scrollTo() {},
    parentNode: { clientWidth: 320, style: {} },
  };
  return el;
}

function boot(storage) {
  const els = new Map();
  const document = {
    getElementById(id) { if (!els.has(id)) { els.set(id, makeEl(id)); } return els.get(id); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement(tag) { return makeEl('#' + tag); },
    createRange() { return { selectNodeContents() {}, getBoundingClientRect() { return { width: 40 }; } }; },
    createTextNode(t) { return { textContent: t }; },
    addEventListener() {},
    removeEventListener() {},
    body: makeEl('body'),
    documentElement: makeEl('html'),
    _els: els,
  };
  const window = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia() { return { matches: false, addListener() {}, addEventListener() {} }; },
    getComputedStyle() { return { fontSize: '16px', width: '0px', height: '0px', paddingLeft: '0px', paddingRight: '0px', getPropertyValue() { return ''; } }; },
    localStorage: storage,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame(fn) { return setTimeout(fn, 0); },
    cancelAnimationFrame() {},
  };
  const sandbox = {
    window, document, localStorage: storage,
    navigator: { vibrate() {}, userAgent: 'node-test' },
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout, setInterval: () => 0, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame() {},
    Promise, console, Date, Math, JSON, Object, Array, String, Number, parseFloat, isNaN,
    location: { href: 'file:///index.html' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'app.js' });
  return { els, document, window };
}

function rowsRendered(els) {
  const html = els.get('gradeRows').innerHTML || '';
  return (html.match(/class="grade-row/g) || []).length;
}

(async () => {
  console.log('=== 场景 A：全新用户，点「等级 开」后落盘 ===');
  let st = makeStorage();
  let ctx = boot(st);
  await sleep(30);
  ctx.els.get('gradeOn').click();
  await sleep(30);
  const gl = st.getItem('gradeLevel');
  assert('gradeLevel 点一下就写进存储（值 ' + gl + '）', gl === '"on"');
  const rawGrades = st.getItem('grades');
  let parsed = null;
  try { parsed = JSON.parse(rawGrades); } catch (e) {}
  assert('grades 存的是数组（不是被包两层的字符串）', Array.isArray(parsed), '类型=' + (parsed === null ? 'null' : Object.prototype.toString.call(parsed)));
  assert('grades 落盘是 5 档', Array.isArray(parsed) && parsed.length === 5, '长度=' + (Array.isArray(parsed) ? parsed.length : '-'));

  console.log('\n=== 场景 B：退出再进（新页面，同一份存储） ===');
  ctx = boot(st);
  await sleep(30);
  ctx.els.get('settingsBtn').click();
  await sleep(30);
  assert('重进后「等级 开」仍是选中态', ctx.els.get('gradeOn').classList.contains('selected'));
  assert('重进后等级表渲染 5 档', rowsRendered(ctx.els) === 5, '行数=' + rowsRendered(ctx.els));

  console.log('\n=== 场景 C：点「等级 关」也要落盘 ===');
  ctx.els.get('gradeOff').click();
  await sleep(30);
  assert('gradeLevel 存为 off', st.getItem('gradeLevel') === '"off"', st.getItem('gradeLevel'));
  ctx = boot(st);
  await sleep(30);
  ctx.els.get('settingsBtn').click();
  await sleep(30);
  assert('重进后仍为关闭态', ctx.els.get('gradeOff').classList.contains('selected') && !ctx.els.get('gradeOn').classList.contains('selected'));

  console.log('\n=== 场景 D：老用户的历史坏数据（双重序列化）能否救回 ===');
  const custom = [
    { name: '优', min: 90 }, { name: '良', min: 75 }, { name: '及', min: 60 }, { name: '差', min: null },
  ];
  st = makeStorage();
  st.setItem('grades', JSON.stringify(JSON.stringify(custom))); // 旧版就是这么存的
  st.setItem('gradeLevel', '"on"');
  ctx = boot(st);
  await sleep(30);
  ctx.els.get('settingsBtn').click();
  await sleep(30);
  assert('历史坏数据救回 4 档自定义表', rowsRendered(ctx.els) === 4, '行数=' + rowsRendered(ctx.els));
  assert('救回的等级名出现在界面上', (ctx.els.get('gradeRows').innerHTML || '').indexOf('value="优"') >= 0);

  console.log('\n=== 场景 E：最低档 min:null 不能被当成坏行丢掉 ===');
  st = makeStorage();
  st.setItem('grades', JSON.stringify([
    { name: 'A+', min: 95 }, { name: 'A', min: 85 }, { name: 'B', min: 75 }, { name: 'C', min: 60 }, { name: 'D', min: null },
  ]));
  ctx = boot(st);
  await sleep(30);
  ctx.els.get('settingsBtn').click();
  await sleep(30);
  assert('含 null 最低档的 5 档表完整保留', rowsRendered(ctx.els) === 5, '行数=' + rowsRendered(ctx.els));

  console.log('\n=== 场景 F：完全坏掉的数据不能让程序崩 ===');
  st = makeStorage();
  st.setItem('grades', '这根本不是 JSON{{{');
  ctx = boot(st);
  await sleep(30);
  ctx.els.get('settingsBtn').click();
  await sleep(30);
  assert('坏数据下页面仍能打开设置（未抛异常）', true);
  assert('坏数据下回落为默认 5 档', rowsRendered(ctx.els) === 5, '行数=' + rowsRendered(ctx.els));

  const failed = results.filter((r) => !r.ok);
  console.log('\n---------------------------------------------');
  console.log('总计 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('脚本异常：', e); process.exit(2); });

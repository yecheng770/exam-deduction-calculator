/* 考试扣分计算器 — 小工具版（Chrome61/ES2017 基线，无行内事件，无 eval） */
(function () {
  'use strict';

  var STORAGE_MIN_CLIENT_VERSION = 9460; // 客户端 9.46.0 起支持 Storage JS API

  // —— 状态 ——
  var currentScore = 100;
  var totalScore = 100;
  var history = [];
  var calcMode = 'subtract'; // 'subtract' | 'add'
  var gradeLevel = false;    // 等级开关：true 时显示等级代替表情
  var grades = [];           // [{name:'A+',min:95}, ...] min=该等下界（左闭），空数组=未自定义
  var gradeRowsInit = null;  // gradeRows 容器引用（renderGradeEditor 初始化时填）
  var customEnabled = false; // 自定义数值键开关
  var customValue = 1.5;     // 自定义数值（0.05~9.9，0.05 步长）
  var keyOrderReversed = false; // 键盘顺序倒转：true 时 1-9 反转成手机输入法顺序
  var APP_VERSION = '2.0.1'; // 当前版本，用于「查看更新」提示
  var CUSTOM_MIN = 0.05;
  var CUSTOM_MAX = 9.9;


  // —— DOM ——
  var scoreDisplay = document.getElementById('currentScore');
  var scoreEmoji = document.getElementById('scoreEmoji');
  var historyContainer = document.getElementById('historyItems');
  var resetBtn = document.getElementById('resetBtn');
  var undoBtn = document.getElementById('undoBtn');
  var settingsBtn = document.getElementById('settingsBtn');
  var settingsModal = document.getElementById('settingsModal');
  var totalScoreInput = document.getElementById('totalScoreInput');
  var cancelSettings = document.getElementById('cancelSettings');
  var saveSettingsBtn = document.getElementById('saveSettings');
  var quickButtons = document.querySelectorAll('.quick-score-btn');
  var modeButtons = document.querySelectorAll('.segment-btn[data-mode]');
  var deductButtons = document.querySelectorAll('.number-btn[data-deduct]');
  var themeBtn = document.getElementById('themeBtn');
  var headerTitle = document.getElementById('headerTitle');
  var soundSwitch = document.getElementById('soundSwitch');
  var vibrateSwitch = document.getElementById('vibrateSwitch');
  var customBtn = document.getElementById('customBtn');
  var customSlot = document.getElementById('customSlot');
  var numberGrid = document.getElementById('numberGrid');
  var customSwitch = document.getElementById('customSwitch');
  var customRange = document.getElementById('customRange');
  var customValueNum = document.getElementById('customValueNum');
  var customValueBox = document.getElementById('customValueBox');
  var keyOrderSwitch = document.getElementById('keyOrderSwitch');
  var keyOrderHint = document.getElementById('keyOrderHint');
  var updateText = document.getElementById('updateText');
  var updateNote = document.getElementById('updateNote');

  // —— 平台能力：存储（平台 Storage 优先，localStorage 兜底） ——
  function readBuildVersion(launchOptions) {
    var env = launchOptions && launchOptions.miniToolEnv;
    return Number(env && env.buildVersion) || 0;
  }
  function getClientVersion(buildVersion) {
    return Math.floor(buildVersion / 1000);
  }
  function isClientVersionAtLeast(buildVersion, minimum) {
    return getClientVersion(buildVersion) >= minimum;
  }
  function getBuildVersion() {
    var xhs = window.xhs;
    var syncVersion = readBuildVersion(xhs && xhs.launchOptions);
    if (syncVersion) return Promise.resolve(syncVersion);
    var miniTool = xhs && xhs.miniTool;
    if (miniTool && typeof miniTool.getLaunchOptions === 'function') {
      return miniTool.getLaunchOptions().then(readBuildVersion).catch(function () { return 0; });
    }
    return Promise.resolve(0);
  }
  function localFallback(key, serialized) {
    try { localStorage.setItem(key, serialized); return Promise.resolve(true); }
    catch (e) { return Promise.resolve(false); }
  }
  function localRead(key) {
    try {
      var v = localStorage.getItem(key);
      return Promise.resolve(v === null ? null : v);
    } catch (e) { return Promise.resolve(null); }
  }
  function setLocalData(key, data) {
    var serialized;
    try { serialized = JSON.stringify(data); } catch (e) { return Promise.resolve(false); }
    if (typeof serialized !== 'string') return Promise.resolve(false);

    var miniTool = window.xhs && window.xhs.miniTool;
    return getBuildVersion().then(function (buildVersion) {
      if (
        isClientVersionAtLeast(buildVersion, STORAGE_MIN_CLIENT_VERSION) &&
        miniTool && typeof miniTool.setStorage === 'function'
      ) {
        return miniTool.setStorage({ key: key, data: serialized }).then(function () {
          return true;
        }).catch(function () {
          return localFallback(key, serialized);
        });
      }
      return localFallback(key, serialized);
    });
  }
  function getLocalData(key) {
    var miniTool = window.xhs && window.xhs.miniTool;
    return getBuildVersion().then(function (buildVersion) {
      if (
        isClientVersionAtLeast(buildVersion, STORAGE_MIN_CLIENT_VERSION) &&
        miniTool && typeof miniTool.getStorage === 'function'
      ) {
        return miniTool.getStorage({ key: key }).then(function (res) {
          return res && res.data !== undefined ? res.data : null;
        }).catch(function () {
          return localRead(key);
        });
      }
      return localRead(key);
    });
  }

  // —— 平台能力：振动（平台 API 优先，无能力时降级为无振动） ——
  var vibrateEnabled = true;
  function vibrateShort() {
    if (!vibrateEnabled) { return; }
    var miniTool = window.xhs && window.xhs.miniTool;
    if (miniTool && typeof miniTool.vibrateShort === 'function') {
      try {
        var r = miniTool.vibrateShort({ type: 'light' });
        if (r && typeof r.catch === 'function') { r.catch(function () {}); }
        return;
      } catch (e) { /* 降级为无振动 */ }
    }
  }

  // —— 平台能力：点击音效（WebAudio 现场合成，不依赖任何音频文件） ——
  var clickAudioCtx = null;
  var soundEnabled = true;
  function playClickSound() {
    if (!soundEnabled) { return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { return; }
    try {
      if (!clickAudioCtx) { clickAudioCtx = new AC(); }
      if (clickAudioCtx.state === 'suspended' && typeof clickAudioCtx.resume === 'function') {
        clickAudioCtx.resume();
      }
      var t = clickAudioCtx.currentTime;
      var osc = clickAudioCtx.createOscillator();
      var gain = clickAudioCtx.createGain();
      // 短促的"嗒"：频率快速下滑 + 极短包络，听起来像实体按键，不是电子音
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1100, t);
      osc.frequency.exponentialRampToValueAtTime(620, t + 0.035);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.13, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.connect(gain);
      gain.connect(clickAudioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.08);
    } catch (e) { /* 无声环境下静默降级 */ }
  }

  // —— 设置里的音效 / 震动两个小开关 ——
  function canVibrate() {
    // iOS（含小红书 / 微信内嵌）没有振动能力，开关直接隐藏，避免用户以为是坏的
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) { return false; }
    var miniTool = window.xhs && window.xhs.miniTool;
    if (miniTool) {
      if (typeof miniTool.vibrateShort === 'function') { return true; }
      return typeof navigator.vibrate === 'function';
    }
    return true; // 浏览器预览：保留开关，方便本地查看样式
  }
  function syncFeedbackSwitches() {
    if (soundSwitch) {
      soundSwitch.classList.toggle('on', soundEnabled);
      soundSwitch.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false');
    }
    if (vibrateSwitch) {
      vibrateSwitch.style.display = canVibrate() ? '' : 'none';
      vibrateSwitch.classList.toggle('on', vibrateEnabled);
      vibrateSwitch.setAttribute('aria-pressed', vibrateEnabled ? 'true' : 'false');
    }
  }

  // —— 业务 ——
  function resetScore() {
    vibrateShort();
    playClickSound();
    currentScore = calcMode === 'add' ? 0 : totalScore;
    history = [];
    updateDisplay();
  }
  function deductScore(points) {
    vibrateShort();
    playClickSound();
    if (calcMode === 'add') {
      currentScore = currentScore + points;
    } else {
      currentScore = currentScore - points;
    }
    history.push(calcMode === 'add' ? '+' + points : points);
    updateDisplay();
  }
  function undoScore() {
    if (history.length > 0) {
      vibrateShort();
      playClickSound();
      var last = history.pop();
      var undoAmount = calcMode === 'add' ? 0 : 0;
      if (calcMode === 'add') {
        undoAmount = parseFloat(String(last).replace('+', ''), 10);
        currentScore = currentScore - undoAmount;
      } else {
        undoAmount = last;
        currentScore = currentScore + undoAmount;
      }
      updateDisplay();
    }
  }
  function getEffectiveGrades() {
    if (grades && grades.length >= 2) {
      var sorted = grades.slice().sort(function (a, b) {
        if (a.min === null && b.min === null) return 0;
        if (a.min === null) return 1;
        if (b.min === null) return -1;
        return b.min - a.min;
      });
      return sorted;
    }
    // 默认等级表
    return [
      { name: 'A+', min: 95 }, { name: 'A', min: 85 }, { name: 'B', min: 75 },
      { name: 'C', min: 60 }, { name: 'D', min: null }
    ];
  }
  function gradeFor(score) {
    // 减法模式按百分比（score/totalScore），加法模式按绝对分
    var r;
    var list = getEffectiveGrades();
    if (calcMode === 'add') {
      if (score < 0) return list[list.length - 1].name;
      for (r = 0; r < list.length; r++) {
        if (score >= list[r].min) return list[r].name;
      }
      return list[list.length - 1].name;
    }
    var pct = (score < 0) ? -1e9 : Math.round((score / totalScore) * 100);
    for (r = 0; r < list.length; r++) {
      if (pct >= list[r].min) return list[r].name;
    }
    return list[list.length - 1].name;
  }
  function pickEmoji(score) {
    if (gradeLevel) {
      if (calcMode === 'add' && score < 0) return '🤔';
      return gradeFor(score);
    }
    if (calcMode === 'add') {
      if (score < 0) return '🤔';
      return '🥺';
    }
    var percentage = (score / totalScore) * 100;
    if (score < 0) return '🤔';
    if (percentage >= 90) return '😄';
    if (percentage >= 80) return '🙂';
    if (percentage >= 70) return '😐';
    if (percentage >= 60) return '😕';
    if (percentage >= 50) return '😢';
    return '💀';
  }
  function formatScore(n) {
    // 两位小数后去尾零：绝对值显示，99.75 就是 99.75，不进位也不截断
    var s = (Math.round(n * 100) / 100).toFixed(2);
    if (s.slice(-2) === '00') { s = s.slice(0, -3); }
    else if (s.slice(-1) === '0') { s = s.slice(0, -1); }
    return s;
  }
  /* 等级名统一与分数同字号；仅当真的塞不进卡片时，才按实际文字宽度等比缩小 */
  function fitGradeBadge() {
    if (scoreEmoji.className.indexOf('grade-badge') === -1) { return; }
    scoreEmoji.style.fontSize = '';
    var card = scoreEmoji.parentNode;
    var cs = window.getComputedStyle(card);
    var avail = card.clientWidth
      - parseFloat(cs.paddingLeft || 0)
      - parseFloat(cs.paddingRight || 0)
      - scoreDisplay.getBoundingClientRect().width
      - 16; /* .score-emoji 的 margin-left */
    if (!(avail > 0)) { return; }
    var i, textW, fs, next, range, rect;
    for (i = 0; i < 8; i++) {
      range = document.createRange();
      range.selectNodeContents(scoreEmoji);
      rect = range.getBoundingClientRect();
      textW = rect.width; /* 文字真实宽度，不含容器裁剪 */
      if (textW <= avail) { break; }
      fs = parseFloat(window.getComputedStyle(scoreEmoji).fontSize) || 72;
      next = Math.floor(fs * avail / textW) - 1;
      if (next < 16) { next = 16; }
      if (next >= fs) { break; }
      scoreEmoji.style.fontSize = next + 'px';
    }
  }
  function updateDisplay() {
    scoreDisplay.textContent = formatScore(currentScore);
    var shown = pickEmoji(currentScore);
    if (gradeLevel && shown.length <= 4 && !/[\uD800-\uDFFF]/.test(shown)) {
      scoreEmoji.textContent = shown;
      scoreEmoji.className = 'score-emoji grade-badge';
      fitGradeBadge();
    } else {
      scoreEmoji.textContent = shown;
      scoreEmoji.className = 'score-emoji';
      scoreEmoji.style.fontSize = '';
    }
    if (currentScore < 0 && calcMode === 'subtract') {
      scoreDisplay.style.color = '#ffe4ea';
      headerTitle.textContent = '这孩子是犯天条了吗？';
      headerTitle.classList.add('easter-egg');
    } else {
      scoreDisplay.style.color = '#ffffff';
      var baseTitle = calcMode === 'add' ? '考试扣分计算器（加法模式）' : '考试扣分计算器';
      headerTitle.textContent = baseTitle;
      headerTitle.classList.remove('easter-egg');
    }
    updateHistory();
  }

  function updateHistory() {
    var i;
    if (history.length === 0) {
      historyContainer.innerHTML = '<span class="history-empty">' + (calcMode === 'add' ? '暂无加分记录' : '暂无扣分记录') + '</span>';
      return;
    }
    var html = '';
    var historyCount = history.length;
    for (i = 0; i < historyCount; i++) {
      html += '<span class="history-item">' + history[i] + '</span>';
      if (i % 10 === 4) {
        html += '<span class="history-divider">|</span>';
      }
    }
    var remainder = historyCount % 10;                 // 该行已放的标签数
    if (remainder > 0 && remainder < 5) {
      // 行内不足 5 个：补齐到第 5 格再插竖线
      var fill;
      for (fill = remainder; fill < 5; fill++) { html += '<span></span>'; }
      html += '<span class="history-divider">|</span>';
    } else if (remainder > 5) {
      // 后半行：补齐到第 10 格即可
      var pad;
      for (pad = remainder; pad < 10; pad++) { html += '<span></span>'; }
    }
    historyContainer.innerHTML = html;
    setTimeout(function () {
      historyContainer.scrollTop = historyContainer.scrollHeight;
    }, 0);
  }

  // —— 设置 ——
  function updateQuickScoreButtons() {
    var currentValue = parseInt(totalScoreInput.value, 10);
    var i;
    var scoreBtns = document.querySelectorAll('.quick-score-btn[data-quick]');
    for (i = 0; i < scoreBtns.length; i++) {
      var btnValue = parseInt(scoreBtns[i].getAttribute('data-quick'), 10);
      if (btnValue === currentValue) {
        scoreBtns[i].classList.add('selected');
      } else {
        scoreBtns[i].classList.remove('selected');
      }
    }
    document.getElementById('modeSubtract').classList.toggle('selected', calcMode === 'subtract');
    document.getElementById('modeAdd').classList.toggle('selected', calcMode === 'add');
  }  function openSettings() {
    markUpdateSeen();
    totalScoreInput.value = totalScore;
    updateQuickScoreButtons();
    updateColorDots();
    if (!grades || grades.length < 2) { grades = defaultGrades(); }
    syncGradeToggle();
    renderGradeEditor();
    syncCustomControls();
    settingsModal.classList.add('active');
  }
  function closeSettings() {
    settingsModal.classList.remove('active');
    if (updateNote) { updateNote.style.display = 'none'; }
  }
  function persistSettings() {
    setLocalData('totalScore', totalScore);
    setLocalData('calcMode', calcMode);
    setLocalData('themeColor', document.body.getAttribute('data-theme-color') || 'pink');
    setLocalData('gradeLevel', gradeLevel ? 'on' : 'off');
    setLocalData('grades', JSON.stringify(grades));
  }
  function syncGradeToggle() {
    var on = document.getElementById('gradeOn');
    var off = document.getElementById('gradeOff');
    on.classList.toggle('selected', gradeLevel);
    off.classList.toggle('selected', !gradeLevel);
    document.getElementById('gradeEditor').style.display = gradeLevel ? 'block' : 'none';
  }
  function loadSettings() {
    getLocalData('totalScore').then(function (raw) {
      if (raw !== null) {
        try {
          var t = parseFloat(JSON.parse(raw));
          if (t > 0 && t <= 999) {
            totalScore = t;
            currentScore = calcMode === 'add' ? 0 : totalScore;
            resetBtn.textContent = calcMode === 'add' ? '归归归..归0 ' : '重置回' + totalScore + '分';
          }
        } catch (e) { /* 忽略坏数据 */ }
      }
      return getLocalData('calcMode').then(function (modeRaw) {
        if (modeRaw !== null) {
          var mode = String(modeRaw).replace(/"/g, '');
          if (mode === 'add' || mode === 'subtract') {
            calcMode = mode;
            currentScore = calcMode === 'add' ? 0 : totalScore;
            resetBtn.textContent = calcMode === 'add' ? '归归归..归0 ' : '重置回' + totalScore + '分';
            applyModeToButtons();
          }
        }
        updateDisplay();
      });
    });
    return getLocalData('gradeLevel').then(function (gRaw) {
      if (gRaw !== null) {
        gradeLevel = String(gRaw).replace(/"/g, '') === 'on';
      }
      return getLocalData('grades').then(function (gradesRaw) {
        if (gradesRaw !== null) {
          try {
            var g = JSON.parse(gradesRaw);
            if (Object.prototype.toString.call(g) === '[object Array]') {
              grades = g.filter(function (row) {
                return row && typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 4 && typeof row.min === 'number';
              }).slice(0, 8);
            }
          } catch (e) { grades = []; }
        }
        updateDisplay();
        renderGradeEditor();
      });
    });
  }

  // —— 自定义数值键 ——
  function roundCustom(v) {
    var n = Math.round(v * 20) / 20; // 0.05 步长
    if (n < CUSTOM_MIN) { n = CUSTOM_MIN; }
    if (n > CUSTOM_MAX) { n = CUSTOM_MAX; }
    return n;
  }
  function formatCustomNum(v) {
    // 0.05 精度：最多两位小数，但不带多余的 0（1.50 → 1.5，0.25 保持 0.25）
    var s = (Math.round(v * 20) / 20).toFixed(2);
    if (s.slice(-2) === '00') { s = s.slice(0, -3); }
    else if (s.slice(-1) === '0') { s = s.slice(0, -1); }
    return s;
  }
  // 键盘上的自定义键：文字 / 数值 / 显隐
  function refreshCustomButton() {
    if (!customBtn) { return; }
    var num = formatCustomNum(customValue);
    customBtn.textContent = (calcMode === 'add' ? '+' : '-') + num;
    customBtn.setAttribute('data-deduct', String(customValue));
    customBtn.style.display = customEnabled ? 'block' : 'none';
  }
  // 设置里的开关 + 滑条状态
  function syncCustomControls() {
    if (customSwitch) {
      customSwitch.classList.toggle('on', customEnabled);
      customSwitch.setAttribute('aria-pressed', customEnabled ? 'true' : 'false');
    }
    if (customValueBox) { customValueBox.style.display = customEnabled ? 'block' : 'none'; }
    if (customRange) { customRange.value = String(customValue); }
    if (customValueNum) { customValueNum.textContent = formatCustomNum(customValue); }
    refreshCustomButton();
  }

  // —— 键盘顺序倒转 ——
  // 把 number-grid 里的按钮按当前顺序排列。电脑排序是 789/456/123，
  // 倒转后变 123/456/789。0.5 / 自定义键 / 10 这三个不在 1-9 的行列里，位置不变。
  // 只调整 grid 项的顺序（CSS order），完全不重建 DOM：
  // 自定义键的容器始终留在页面里，关掉开关时那一格留空，所以 -10 永远在右下角。
  var KEY_ORDER_DEFAULT = ['7', '8', '9', '4', '5', '6', '1', '2', '3'];
  var KEY_ORDER_REVERSED = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  function applyKeyOrder() {
    if (!numberGrid) { return; }
    var cells = numberGrid.querySelectorAll('.number-btn[data-deduct]');
    var byDeduct = {};
    var i;
    for (i = 0; i < cells.length; i++) {
      if (cells[i] === customBtn) { continue; } // 自定义键数值可能与某个数字重复，不能覆盖
      byDeduct[cells[i].getAttribute('data-deduct')] = cells[i];
    }
    var order = keyOrderReversed ? KEY_ORDER_REVERSED : KEY_ORDER_DEFAULT;
    for (i = 0; i < order.length; i++) {
      if (byDeduct[order[i]]) { byDeduct[order[i]].style.order = String(i); }
    }
    // 最后一行固定为 [-0.5][自定义][-10]，自定义关闭时中间留空
    if (byDeduct['0.5']) { byDeduct['0.5'].style.order = '9'; }
    if (customSlot) { customSlot.style.order = '10'; }
    if (byDeduct['10']) { byDeduct['10'].style.order = '11'; }
  }
  function syncKeyOrderControls() {
    if (keyOrderSwitch) {
      keyOrderSwitch.classList.toggle('on', keyOrderReversed);
      keyOrderSwitch.setAttribute('aria-pressed', keyOrderReversed ? 'true' : 'false');
    }
    if (keyOrderHint) { keyOrderHint.style.display = keyOrderReversed ? '' : 'none'; }
    applyKeyOrder();
  }

  // —— 主题 ——
  function applyTheme(dark) {
    if (dark) {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
  }
  function applyThemeColor(color) {
    var valid = ['red', 'pink', 'purple', 'blue', 'teal', 'green', 'gray'];
    var i;
    for (i = 0; i < valid.length; i++) {
      if (valid[i] === color) {
        document.body.setAttribute('data-theme-color', color);
        return;
      }
    }
    document.body.removeAttribute('data-theme-color');
  }
  function updateColorDots() {
    var dots = document.querySelectorAll('.color-dot');
    var current = document.body.getAttribute('data-theme-color') || 'pink';
    var i;
    for (i = 0; i < dots.length; i++) {
      if (dots[i].getAttribute('data-theme-color') === current) {
        dots[i].classList.add('selected');
      } else {
        dots[i].classList.remove('selected');
      }
    }
  }
  // —— 等级编辑 ——
  function defaultGrades() {
    return [
      { name: 'A+', min: 95 }, { name: 'A', min: 85 }, { name: 'B', min: 75 },
      { name: 'C', min: 60 }, { name: 'D', min: null }
    ];
  }
  // "↓ 应用排序"只在等级表被改动过之后才出现（renderGradeEditor 里重置为隐藏）
  function setGradeSortVisible(v) {
    var btn = document.getElementById('gradeSort');
    if (!btn) { return; }
    btn.style.display = v ? '' : 'none';
  }
  function renderGradeEditor() {
    var rowsEl = document.getElementById('gradeRows');
    var i;
    if (gradeRowsInit === null) {
      gradeRowsInit = rowsEl;
    }
    var list = (grades && grades.length >= 2) ? grades : (grades.length ? grades : []);
    var html = '';
    for (i = 0; i < list.length; i++) {
      var isLast = (i === list.length - 1) && list.length >= 2;
      var minText = isLast ? String(list[i - 1] ? list[i - 1].min : 0) : '';
      var minCell = isLast
        ? '<span class="grade-min-input grade-min-locked">' + minText + '</span>'
        : '<input type="number" class="grade-min-input" data-gi="' + i + '" data-field="min" value="' + list[i].min + '" step="1" min="0" max="999" />';
      var geLabel = isLast ? '<span class="grade-min-label">＜</span>' : '<span class="grade-min-label">≥</span>';
      var rowCls = isLast ? '"grade-row grade-row-locked"' : '"grade-row"';
      html += '<div class=' + rowCls + '>';
      html += '<input type="text" class="grade-name-input" data-gi="' + i + '" data-field="name" value="' + String(list[i].name).replace(/"/g, '&quot;') + '" maxlength="4" placeholder="名称" />';
      html += geLabel;
      html += minCell;
      if (!isLast) {
        html += '<button type="button" class="grade-del-btn" data-gi="' + i + '" data-action="del">✕</button>';
      }
      html += '</div>';
    }
    rowsEl.innerHTML = html;
    document.getElementById('gradeEditor').style.display = gradeLevel ? 'block' : 'none';
    setGradeSortVisible(false);
  }
  function collectAndSortGrades() {
    var rowsEl = document.getElementById('gradeRows');
    var rows = rowsEl ? rowsEl.querySelectorAll('.grade-row') : [];
    var out = [];
    var i;
    var emptyNamed = false;
    for (i = 0; i < rows.length; i++) {
      var nameInput = rows[i].querySelector('.grade-name-input');
      var minInput = rows[i].querySelector('input.grade-min-input');
      var name = (nameInput.value || '').trim().slice(0, 4);
      if (minInput) {
        var min = parseFloat(minInput.value);
        if (!name) { emptyNamed = true; }
        if (name && !isNaN(min) && min >= 0) {
          out.push({ name: name, min: Math.round(min) });
        }
      } else {
        // 最低档
        if (!name) { emptyNamed = true; }
        if (name) { out.push({ name: name, min: null }); }
      }
    }
    if (emptyNamed) { return { error: 'empty-name' }; }
    // 排序
    out.sort(function (a, b) {
      if (a.min === null && b.min === null) return 0;
      if (a.min === null) return 1;
      if (b.min === null) return -1;
      return b.min - a.min;
    });
    // 查重：两个同分界（且都有 min）视为冲突
    for (i = 0; i < out.length - 1; i++) {
      if (out[i].min !== null && out[i + 1].min !== null && out[i].min === out[i + 1].min) {
        return { error: 'dup-min', value: out[i].min };
      }
    }
    return { ok: true, list: out };
  }
  function applyModeToButtons() {
    var i;
    var prefix = calcMode === 'add' ? '+' : '-';
    var changed = [];
    for (i = 0; i < deductButtons.length; i++) {
      var btn = deductButtons[i];
      if (btn === customBtn) { continue; }
      var val = btn.getAttribute('data-deduct');
      var newText = prefix + val;
      if (btn.textContent !== newText) {
        btn.textContent = newText;
        changed.push(true);
      }
    }
    if (changed.length > 0) {
      for (i = 0; i < deductButtons.length; i++) {
        deductButtons[i].classList.add('deduct');
      }
    }
    refreshCustomButton();
  }
  function toggleTheme() {
    vibrateShort();
    var dark = !document.body.classList.contains('dark');
    applyTheme(dark);
    setLocalData('theme', dark ? 'dark' : 'light');
  }

  // —— 事件绑定（替代 onclick） ——
  var i;
  for (i = 0; i < deductButtons.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        deductScore(parseFloat(btn.getAttribute('data-deduct')));
      });
    })(deductButtons[i]);
  }
  resetBtn.addEventListener('click', resetScore);
  undoBtn.addEventListener('click', undoScore);
  themeBtn.addEventListener('click', toggleTheme);
  if (soundSwitch) {
    soundSwitch.addEventListener('click', function () {
      soundEnabled = !soundEnabled;
      setLocalData('soundEnabled', soundEnabled ? 'on' : 'off');
      syncFeedbackSwitches();
      if (soundEnabled) { playClickSound(); }
    });
  }
  if (vibrateSwitch) {
    vibrateSwitch.addEventListener('click', function () {
      vibrateEnabled = !vibrateEnabled;
      setLocalData('vibrateEnabled', vibrateEnabled ? 'on' : 'off');
      syncFeedbackSwitches();
      if (vibrateEnabled) { vibrateShort(); }
    });
  }
  if (keyOrderSwitch) {
    keyOrderSwitch.addEventListener('click', function () {
      vibrateShort();
      keyOrderReversed = !keyOrderReversed;
      setLocalData('keyOrderReversed', keyOrderReversed ? 'on' : 'off');
      syncKeyOrderControls();
    });
  }
  if (customSwitch) {
    customSwitch.addEventListener('click', function () {
      vibrateShort();
      customEnabled = !customEnabled;
      setLocalData('customEnabled', customEnabled ? 'on' : 'off');
      syncCustomControls();
      applyKeyOrder();
    });
  }
  if (customRange) {
    customRange.addEventListener('input', function () {
      var v = parseFloat(customRange.value);
      customValue = roundCustom(isNaN(v) ? 0 : v);
      if (customValueNum) { customValueNum.textContent = formatCustomNum(customValue); }
      refreshCustomButton();
    });
    customRange.addEventListener('change', function () {
      setLocalData('customValue', customValue);
    });
  }
  settingsBtn.addEventListener('click', openSettings);
  cancelSettings.addEventListener('click', closeSettings);
  function showToast(title, body) {
    document.getElementById('toastTitle').textContent = title;
    document.getElementById('toastBody').textContent = body;
    document.getElementById('toastMask').classList.add('active');
  }
  document.getElementById('toastOk').addEventListener('click', function () {
    document.getElementById('toastMask').classList.remove('active');
  });

  saveSettingsBtn.addEventListener('click', function () {
    var newTotal = parseFloat(totalScoreInput.value);
    var res = collectAndSortGrades();
    if (res.error) {
      if (res.error === 'dup-min') {
        showToast('分界值重复', '有两个等级都从 ' + res.value + ' 分开始，这样没法判断分数归哪一等。改一下其中一个再保存。');
      } else {
        showToast('还有等级没起名', '有一行等级名字是空的。给它起个名（比如 B、及格），或者把这行删掉再保存。');
      }
      return;
    }
    if (newTotal > 0 && newTotal <= 999) {
      totalScore = newTotal;
      currentScore = calcMode === 'add' ? 0 : totalScore;
      history = [];
      resetBtn.textContent = calcMode === 'add' ? '归归归..归0 ' : '重置回' + totalScore + '分';
    }
    grades = res.list;
    renderGradeEditor();
    persistSettings();
    closeSettings();
    updateDisplay();
  });
  for (i = 0; i < modeButtons.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        vibrateShort();
        calcMode = btn.getAttribute('data-mode');
        currentScore = calcMode === 'add' ? 0 : totalScore;
        history = [];
        resetBtn.textContent = calcMode === 'add' ? '归归归..归0 ' : '重置回' + totalScore + '分';
        applyModeToButtons();
        document.getElementById('modeSubtract').classList.toggle('selected', calcMode === 'subtract');
        document.getElementById('modeAdd').classList.toggle('selected', calcMode === 'add');
        updateDisplay();
      });
    })(modeButtons[i]);
  }
  for (i = 0; i < quickButtons.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        vibrateShort();
        totalScoreInput.value = btn.getAttribute('data-quick');
        updateQuickScoreButtons();
      });
    })(quickButtons[i]);
  }
  totalScoreInput.addEventListener('input', updateQuickScoreButtons);
  document.getElementById('gradeOn').addEventListener('click', function () {
    vibrateShort();
    if (!grades || grades.length < 2) { grades = defaultGrades(); }
    gradeLevel = true;
    syncGradeToggle();
    renderGradeEditor();
  });
  document.getElementById('gradeOff').addEventListener('click', function () {
    vibrateShort();
    gradeLevel = false;
    syncGradeToggle();
  });
  document.getElementById('gradeSort').addEventListener('click', function () {
    vibrateShort();
    var res = collectAndSortGrades();
    if (res.error) {
      if (res.error === 'dup-min') {
        showToast('分界值重复', '有两个等级都从 ' + res.value + ' 分开始，改一下其中一个再排序。');
      } else {
        showToast('还有等级没起名', '有一行等级名字是空的，起个名或删掉那行再排序。');
      }
      return;
    }
    grades = res.list;
    renderGradeEditor();
  });
  document.getElementById('gradeAdd').addEventListener('click', function () {    vibrateShort();
    var rows = document.getElementById('gradeRows').querySelectorAll('.grade-row');
    if (rows.length >= 8) { return; }
    var idx = rows.length;
    var div = document.createElement('div');
    div.className = 'grade-row';
    div.innerHTML = '<input type="text" class="grade-name-input" data-gi="' + idx + '" data-field="name" value="" maxlength="4" placeholder="待命名" />' +
      '<span class="grade-min-label">≥</span>' +
      '<input type="number" class="grade-min-input" data-gi="' + idx + '" data-field="min" value="50" step="1" min="0" max="999" />' +
      '<button type="button" class="grade-del-btn" data-gi="' + idx + '" data-action="del">✕</button>';
    document.getElementById('gradeRows').appendChild(div);
    setGradeSortVisible(true);
  });
  var gradeRowsEl = document.getElementById('gradeRows');
  // 改名或改分界值 → 出现"应用排序"
  gradeRowsEl.addEventListener('input', function (e) {
    var t = e.target;
    if (t && (t.classList.contains('grade-name-input') || t.classList.contains('grade-min-input'))) {
      setGradeSortVisible(true);
    }
  });
  gradeRowsEl.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.grade-del-btn') : null;
    if (btn) {
      vibrateShort();
      var row = btn.parentNode;
      if (gradeRowsEl.querySelectorAll('.grade-row').length <= 2) { return; }
      row.parentNode.removeChild(row);
      setGradeSortVisible(true);
    }
  });
  var colorDots = document.querySelectorAll('.color-dot');
  for (i = 0; i < colorDots.length; i++) {
    (function (dot) {
      dot.addEventListener('click', function () {
        vibrateShort();
        applyThemeColor(dot.getAttribute('data-theme-color'));
        updateColorDots();
        setLocalData('themeColor', dot.getAttribute('data-theme-color'));
      });
    })(colorDots[i]);
  }

  // 屏幕尺寸变化（旋屏、容器缩放）后重新判断等级名是否需要微缩
  window.addEventListener('resize', function () {
    fitGradeBadge();
  });

  // —— 更新提示：版本号变了，就在设置按钮里多一条「查看更新」；点过一次设置后永久收起 ——
  function markUpdateSeen() {
    if (!settingsBtn || !settingsBtn.classList.contains('has-update')) { return; }
    settingsBtn.classList.remove('has-update');
    setLocalData('updateSeen', APP_VERSION);
  }
  function initUpdateHint() {
    if (!settingsBtn || !updateText) { return; }
    getLocalData('updateSeen').then(function (raw) {
      var seen = raw === null ? '' : String(raw).replace(/"/g, '');
      if (seen === APP_VERSION) { return; }
      settingsBtn.classList.add('has-update');
      if (updateNote) { updateNote.style.display = 'block'; }
    });
  }

  // —— 初始化 ——
  resetBtn.textContent = calcMode === 'add' ? '归归归..归0 ' : '重置回' + totalScore + '分';
  applyModeToButtons();
  getLocalData('theme').then(function (raw) {
    applyTheme(raw === '"dark"' || raw === 'dark');
  });
  getLocalData('themeColor').then(function (raw) {
    if (raw !== null) {
      applyThemeColor(String(raw).replace(/"/g, ''));
    }
    updateColorDots();
  });
  syncFeedbackSwitches();
  getLocalData('soundEnabled').then(function (raw) {
    if (raw !== null) {
      soundEnabled = String(raw).replace(/"/g, '') !== 'off';
    }
    return getLocalData('vibrateEnabled').then(function (vRaw) {
      if (vRaw !== null) {
        vibrateEnabled = String(vRaw).replace(/"/g, '') !== 'off';
      }
      syncFeedbackSwitches();
    });
  });
  getLocalData('customEnabled').then(function (raw) {
    if (raw !== null) {
      customEnabled = String(raw).replace(/"/g, '') === 'on';
    }
    return getLocalData('customValue').then(function (vRaw) {
      if (vRaw !== null) {
        var v = parseFloat(String(vRaw).replace(/"/g, ''));
        if (!isNaN(v)) { customValue = roundCustom(v); }
      }
      syncCustomControls();
      return getLocalData('keyOrderReversed').then(function (kRaw) {
        if (kRaw !== null) {
          keyOrderReversed = String(kRaw).replace(/"/g, '') === 'on';
        }
        syncKeyOrderControls();
      });
    });
  });
  loadSettings();
  initUpdateHint();
})();

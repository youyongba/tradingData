/* eslint-disable */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const fmt = (n, d = 2) => (n == null || isNaN(n)) ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  // ==== 时间：统一东八区 (UTC+8) ====
  const TZ_OFFSET_SEC = 8 * 3600; // 北京时间相对 UTC 的偏移（秒）

  /** 把 unix 秒(UTC) 转成"伪 UTC"——给 lightweight-charts 显示出来就是北京时间 */
  const toChartTime = (utcSec) => utcSec + TZ_OFFSET_SEC;

  /** 把图表内部的伪 UTC 秒还原为真实 UTC 秒 */
  const fromChartTime = (chartSec) => chartSec - TZ_OFFSET_SEC;

  /** 北京时间的 HH:mm:ss */
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
  });

  /** 北京时间的 yyyy-MM-dd HH:mm */
  const fmtDateTime = (ms) => new Date(ms).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  // ====== 图表 ======
  const chartEl = $('#chart');
  const chart = LightweightCharts.createChart(chartEl, {
    layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#1c2230' }, horzLines: { color: '#1c2230' } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#232a38' },
    rightPriceScale: { borderColor: '#232a38' },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: {
      // 鼠标悬停显示完整北京时间
      timeFormatter: (chartSec) => {
        const ms = fromChartTime(chartSec) * 1000;
        return fmtDateTime(ms) + ' (UTC+8)';
      },
    },
    autoSize: true,
  });
  const candleSeries = chart.addCandlestickSeries({
    upColor: '#26a69a', downColor: '#ef5350',
    borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
  });

  let priceLines = []; // {type, line}
  function clearPriceLines() {
    for (const o of priceLines) candleSeries.removePriceLine(o.line);
    priceLines = [];
  }
  function addPriceLine(type, price, title, color, lineStyle = LightweightCharts.LineStyle.Dashed) {
    if (price == null) return;
    const line = candleSeries.createPriceLine({
      price, color, title,
      lineWidth: 2, lineStyle,
      axisLabelVisible: true,
    });
    priceLines.push({ type, line, title });
  }

  // 高亮 1.4s
  function pulsePriceLine(type, color) {
    const obj = priceLines.find((o) => o.type === type);
    if (!obj) return;
    obj.line.applyOptions({ lineWidth: 4, color: '#ffffff' });
    setTimeout(() => obj.line.applyOptions({ lineWidth: 2, color }), 1400);
  }

  // ====== 状态 ======
  const state = {
    selectedId: null,
    plans: new Map(), // id -> plan
    klineSymbol: null,
    markPrice: null,
    currentKline: null, // 最新一根 K 线 { time, open, high, low, close }
    watches: new Map(),       // id -> watch
    watchLines: new Map(),    // id -> priceLine（仅当 watch.symbol === klineSymbol 时画线）
  };

  const HOUR_SEC = 3600;
  const bucket1h = (sec) => Math.floor(sec / HOUR_SEC) * HOUR_SEC;

  /** 用最新成交价/标记价更新当前 1H K 线（跨小时则开新 K线） */
  function applyTickToKline(price, ts = Math.floor(Date.now() / 1000)) {
    if (!Number.isFinite(price)) return;
    const t = bucket1h(ts);
    let cur = state.currentKline;
    if (!cur || t > cur.time) {
      cur = { time: t, open: price, high: price, low: price, close: price };
    } else if (t === cur.time) {
      cur = {
        time: cur.time,
        open: cur.open,
        high: Math.max(cur.high, price),
        low: Math.min(cur.low, price),
        close: price,
      };
    } else {
      return; // 历史时间，忽略
    }
    state.currentKline = cur;
    candleSeries.update(cur);
  }

  // ====== 默认符号（无活跃计划时也显示图表） ======
  const DEFAULT_SYMBOL_KEY = 'defaultSymbol';
  function getDefaultSymbol() {
    return (localStorage.getItem(DEFAULT_SYMBOL_KEY) || 'BTCUSDT').toUpperCase();
  }
  function setDefaultSymbol(s) {
    localStorage.setItem(DEFAULT_SYMBOL_KEY, s.toUpperCase());
  }
  let viewerSubscribed = null;
  async function ensureDefaultChart() {
    if (state.selectedId) return; // 有计划就不管
    const sym = getDefaultSymbol();
    $('#emptySymbol').textContent = sym;
    $('#defaultSymbolInput').value = sym;
    if (viewerSubscribed && viewerSubscribed !== sym) {
      try { await fetch('/api/unsubscribe?symbol=' + encodeURIComponent(viewerSubscribed)); } catch (_) { /* ignore */ }
    }
    await loadKlines(sym);
    if (viewerSubscribed !== sym) {
      try { await fetch('/api/subscribe?symbol=' + encodeURIComponent(sym)); } catch (_) { /* ignore */ }
      viewerSubscribed = sym;
    }
  }
  window.addEventListener('beforeunload', () => {
    if (viewerSubscribed) {
      navigator.sendBeacon
        ? navigator.sendBeacon('/api/unsubscribe?symbol=' + encodeURIComponent(viewerSubscribed))
        : fetch('/api/unsubscribe?symbol=' + encodeURIComponent(viewerSubscribed), { keepalive: true });
    }
  });
  $('#defaultSymbolApply').addEventListener('click', () => {
    const v = $('#defaultSymbolInput').value.trim().toUpperCase();
    if (!v) return;
    setDefaultSymbol(v);
    state.klineSymbol = null;
    ensureDefaultChart();
  });

  function showEmptyHint(show) {
    $('#emptyHint').classList.toggle('hidden', !show);
  }

  // ====== Plan 选择 ======
  const planSelect = $('#planSelect');
  function refreshPlanSelect() {
    const list = Array.from(state.plans.values()).sort((a, b) => b.createdAt - a.createdAt);
    planSelect.innerHTML = '';
    if (list.length === 0) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '— 暂无活跃计划 —';
      planSelect.appendChild(opt);
      return;
    }
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.symbol} · ${p.side === 'LONG' ? '多' : '空'} · ${p.state}`;
      planSelect.appendChild(opt);
    }
    if (state.selectedId && state.plans.has(state.selectedId)) {
      planSelect.value = state.selectedId;
    } else {
      planSelect.value = list[0].id;
      selectPlan(list[0].id);
    }
  }
  planSelect.addEventListener('change', () => selectPlan(planSelect.value));

  function refreshPlanList() {
    const ul = $('#planList');
    ul.innerHTML = '';
    const list = Array.from(state.plans.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (list.length === 0) {
      ul.innerHTML = '<li style="color:#8b93a7;cursor:default">暂无活跃计划</li>';
      return;
    }
    for (const p of list) {
      const li = document.createElement('li');
      if (p.id === state.selectedId) li.className = 'active';
      li.innerHTML = `
        <span class="pl-side ${p.side.toLowerCase()}">${p.side === 'LONG' ? '多' : '空'}</span>
        <span class="pl-symbol">${p.symbol}</span>
        <span class="pl-state">${p.state}</span>
        <button class="pl-cancel" data-id="${p.id}">取消</button>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.classList.contains('pl-cancel')) return;
        selectPlan(p.id);
      });
      ul.appendChild(li);
    }
    ul.querySelectorAll('.pl-cancel').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!confirm('取消该计划？')) return;
        await fetch('/api/plans/' + id, { method: 'DELETE' });
      });
    });
  }

  async function selectPlan(id) {
    if (!id || !state.plans.has(id)) return;
    state.selectedId = id;
    const plan = state.plans.get(id);
    state.klineSymbol = null; // 强制重新加载（plan 切换可能换 symbol）
    await loadKlines(plan.symbol);
    renderBadge(plan);
    drawPlanLines(plan);
    refreshPlanList();
    refreshPlanSelect();
    showEmptyHint(false);
  }

  // ====== Badge ======
  function renderBadge(plan) {
    const b = $('#planBadge');
    b.classList.remove('hidden');
    $('#badgeSide').className = 'side ' + plan.side.toLowerCase();
    $('#badgeSide').textContent = plan.side === 'LONG' ? '做多 LONG' : '做空 SHORT';
    $('#badgeSymbol').textContent = plan.symbol;
    const stateMap = {
      PENDING:   ['pending', '待入场'],
      RUNNING:   ['running', '已入场'],
      RUNNING_BE:['running_be', '保本中'],
      CLOSED:    ['closed', '已结束'],
    };
    const [cls, label] = stateMap[plan.state] || ['pending', plan.state];
    $('#badgeState').className = 'state ' + cls;
    $('#badgeState').textContent = label;

    $('#badgeEntry').textContent = fmt(plan.entry, priceDecimals(plan));
    $('#badgeTp1').textContent = fmt(plan.tp1, priceDecimals(plan));
    $('#badgeTp2').textContent = fmt(plan.tp2, priceDecimals(plan));
    $('#badgeTp3').textContent = fmt(plan.tp3, priceDecimals(plan));
    $('#badgeSl').textContent  = fmt(plan.sl,  priceDecimals(plan));
    $('#badgeTp1Pct').textContent = `+${plan.tp1Pct}%`;
    $('#badgeTp2Pct').textContent = `+${plan.tp2Pct}%`;
    $('#badgeTp3Pct').textContent = `+${plan.tp3Pct}%`;
    $('#badgeSlPct').textContent  = `-${Math.abs(plan.slPct)}%`;
    $('#badgeRr1').textContent = plan.rr1;
    $('#badgeRr2').textContent = plan.rr2;
    $('#badgeRr3').textContent = plan.rr3;
    updatePnl(plan);
  }

  function priceDecimals(plan) {
    const p = Math.max(plan.entry, plan.tp3 || 0);
    if (p >= 1000) return 2;
    if (p >= 10) return 3;
    if (p >= 1) return 4;
    return 6;
  }

  function updatePnl(plan) {
    const el = $('#badgePnl');
    if (plan.state === 'PENDING' || state.markPrice == null) {
      el.textContent = '—';
      el.style.color = '';
      return;
    }
    const sign = plan.side === 'LONG' ? 1 : -1;
    const pct = ((state.markPrice - plan.entry) / plan.entry) * 100 * sign;
    el.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    el.style.color = pct >= 0 ? '#2ecc71' : '#e74c3c';
  }

  function drawPlanLines(plan) {
    clearPriceLines();
    const isLong = plan.side === 'LONG';
    addPriceLine('ENTRY', plan.entry, `Entry ${fmt(plan.entry, priceDecimals(plan))}`, '#4f8cff');
    addPriceLine('TP1', plan.tp1, `TP1 ${fmt(plan.tp1, priceDecimals(plan))} (${isLong?'+':''}${plan.tp1Pct}% RR=${plan.rr1})`, '#26a69a');
    addPriceLine('TP2', plan.tp2, `TP2 ${fmt(plan.tp2, priceDecimals(plan))} (${isLong?'+':''}${plan.tp2Pct}% RR=${plan.rr2})`, '#2ecc71');
    addPriceLine('TP3', plan.tp3, `TP3 ${fmt(plan.tp3, priceDecimals(plan))} (${isLong?'+':''}${plan.tp3Pct}% RR=${plan.rr3})`, '#27ae60');
    addPriceLine('SL',  plan.sl,  `SL ${fmt(plan.sl, priceDecimals(plan))} (-${Math.abs(plan.slPct)}%)`, '#ef5350');
  }

  // ====== K线 ======
  async function loadKlines(symbol) {
    if (state.klineSymbol === symbol) return;
    state.klineSymbol = symbol;
    try {
      const r = await fetch('/api/klines?symbol=' + encodeURIComponent(symbol) + '&limit=300');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      const klines = j.klines.map((k) => ({ ...k, time: toChartTime(k.time) }));
      candleSeries.setData(klines);
      state.currentKline = klines[klines.length - 1] || null;
      chart.timeScale().fitContent();
      // 切换 symbol 后重新画该 symbol 对应的监测点价位线
      if (typeof refreshWatchLines === 'function') refreshWatchLines();
      if (typeof syncDefaultSymbolToForm === 'function') syncDefaultSymbolToForm();
    } catch (err) {
      console.error('加载 K 线失败', err);
    }
  }

  // ====== 事件流 ======
  function pushEvent(tag, text, cls = '') {
    const ul = $('#eventList');
    const li = document.createElement('li');
    li.innerHTML = `<span class="ev-time">${fmtTime(Date.now())}</span><span class="ev-tag ${cls}">${tag}</span>${text}`;
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 60) ul.removeChild(ul.lastChild);
  }

  // ====== 触发动画 ======
  function flashScreen(cls) {
    let el = $('.flash-overlay');
    if (!el) {
      el = document.createElement('div');
      el.className = 'flash-overlay';
      document.body.appendChild(el);
    }
    el.className = 'flash-overlay ' + cls + ' show';
    setTimeout(() => el.classList.remove('show'), 250);
  }

  // ====== SSE ======
  function connectSSE() {
    const setConn = (on) => {
      $('#conn').className = 'dot ' + (on ? 'on' : 'off');
      $('#connText').textContent = on ? '已连接' : '断线重连中…';
    };
    const es = new EventSource('/api/events');
    es.addEventListener('hello', () => setConn(true));
    es.addEventListener('mark', (e) => {
      const d = JSON.parse(e.data);
      if (state.klineSymbol === d.symbol) {
        state.markPrice = d.price;
        $('#markPrice').textContent = d.symbol + ' ' + fmt(d.price, 2);
        applyTickToKline(d.price, toChartTime(Math.floor((d.time || Date.now()) / 1000)));
        const plan = state.plans.get(state.selectedId);
        if (plan) updatePnl(plan);
      }
    });
    es.addEventListener('kline', (e) => {
      const k = JSON.parse(e.data);
      if (state.klineSymbol !== k.symbol) return;
      // 保护：lightweight-charts 的 update() 不允许 time < 当前最后一根
      if (typeof k.time !== 'number') return;
      const tChart = toChartTime(k.time);
      const lastTime = state.currentKline?.time ?? 0;
      if (tChart < lastTime) return;
      const bar = { time: tChart, open: k.open, high: k.high, low: k.low, close: k.close };
      try {
        candleSeries.update(bar);
        state.currentKline = bar;
      } catch (err) {
        console.warn('candleSeries.update 失败:', err.message, bar);
      }
    });
    es.addEventListener('plan:new', (e) => {
      const p = JSON.parse(e.data);
      state.plans.set(p.id, p);
      pushEvent('NEW', `${p.symbol} ${p.side} entry=${fmt(p.entry, priceDecimals(p))}`, 'new');
      if (!state.selectedId) selectPlan(p.id);
      refreshPlanList(); refreshPlanSelect();
    });
    es.addEventListener('plan:trigger', (e) => {
      const { plan, event: ev } = JSON.parse(e.data);
      state.plans.set(plan.id, plan);
      const tagMap = {
        ENTRY: ['ENTRY', 'entry', 'entry'],
        TP1:   ['TP1',   'tp',    'tp'],
        TP2:   ['TP2',   'tp',    'tp'],
        TP3:   ['TP3',   'tp',    'tp'],
        SL:    ['SL',    'sl',    'sl'],
        BE_SL: ['BE_SL', 'be',    'be'],
      };
      const [tag, evCls, flashCls] = tagMap[ev.type] || [ev.type, '', 'entry'];
      pushEvent(tag, `${plan.symbol} @ ${fmt(ev.price, priceDecimals(plan))}`, evCls);

      // 选中该 plan，确保用户能看到
      if (state.selectedId !== plan.id) selectPlan(plan.id);
      else { renderBadge(plan); drawPlanLines(plan); }

      // 高亮线 + 闪屏 + 音效
      const colorMap = { ENTRY: '#4f8cff', TP1: '#26a69a', TP2: '#2ecc71', TP3: '#27ae60', SL: '#ef5350', BE_SL: '#f0b90b' };
      pulsePriceLine(ev.type === 'BE_SL' ? 'SL' : ev.type, colorMap[ev.type] || '#ffffff');
      flashScreen(flashCls);
      const soundMap = { ENTRY: 'entry', TP1: 'tp', TP2: 'tp', TP3: 'tp', SL: 'sl', BE_SL: 'be' };
      Sound[soundMap[ev.type]]?.();
    });
    es.addEventListener('plan:closed', (e) => {
      const p = JSON.parse(e.data);
      state.plans.delete(p.id);
      pushEvent('CLOSE', `${p.symbol} ${p.closedReason} ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct ?? 0}%`,
        p.closedReason === 'SL' ? 'sl' : 'tp');
      if (state.selectedId === p.id) {
        state.selectedId = null;
        clearPriceLines();
        $('#planBadge').classList.add('hidden');
        ensureDefaultChart();
        showEmptyHint(true);
      }
      refreshPlanList(); refreshPlanSelect(); loadTrades();
    });
    // 监测点事件
    es.addEventListener('watch:new', (e) => {
      const w = JSON.parse(e.data);
      state.watches.set(w.id, w);
      pushEvent('WATCH+', `${w.symbol} ${w.direction} @ ${fmt(w.price, 2)}`, 'watch');
      refreshWatchList();
      refreshWatchLines();
    });
    es.addEventListener('watch:trigger', (e) => {
      const w = JSON.parse(e.data);
      pushEvent('WATCH!', `${w.symbol} ${fmt(w.triggeredPrice, 2)} 穿越 ${fmt(w.price, 2)}`, 'watch');
      const line = state.watchLines.get(w.id);
      if (line) {
        line.applyOptions({ lineWidth: 4, color: '#ffffff' });
        setTimeout(() => line.applyOptions({ lineWidth: 1, color: WATCH_COLOR }), 1400);
      }
      flashScreen('watch');
      Sound.watch?.();
    });
    es.addEventListener('watch:removed', (e) => {
      const w = JSON.parse(e.data);
      state.watches.delete(w.id);
      refreshWatchList();
      refreshWatchLines();
    });
    es.onerror = () => setConn(false);
  }

  // ====== 初始化 ======
  async function loadActivePlans() {
    const r = await fetch('/api/plans');
    const j = await r.json();
    if (!j.ok) return;
    for (const p of j.plans) state.plans.set(p.id, p);
    refreshPlanList();
    refreshPlanSelect();
    if (j.plans.length > 0 && !state.selectedId) {
      selectPlan(j.plans[0].id);
    } else {
      showEmptyHint(true);
      ensureDefaultChart();
    }
  }

  async function loadTrades() {
    const r = await fetch('/api/trades?limit=80');
    const j = await r.json();
    if (!j.ok) return;
    const ul = $('#tradeList');
    ul.innerHTML = '';
    const list = j.trades.slice().reverse();
    if (list.length === 0) {
      ul.innerHTML = '<li style="color:#8b93a7;cursor:default">暂无交易记录</li>';
      return;
    }
    for (const t of list) {
      const li = document.createElement('li');
      const pnl = t.pnlPct ?? 0;
      const cls = pnl >= 0 ? 'pos' : 'neg';
      const sign = pnl >= 0 ? '+' : '';
      li.innerHTML = `
        <span class="pl-side ${(t.side || '').toLowerCase()}">${t.side === 'LONG' ? '多' : '空'}</span>
        <span class="tr-symbol">${t.symbol}</span>
        <span class="tr-reason">${t.closedReason || ''}</span>
        <span class="tr-pnl ${cls}">${sign}${pnl}%</span>
      `;
      ul.appendChild(li);
    }
  }

  // ====== 监测点（Watch） ======
  const WATCH_COLOR = '#b069f5';

  function refreshWatchLines() {
    // 清掉所有旧线
    for (const [, line] of state.watchLines) {
      try { candleSeries.removePriceLine(line); } catch (_) { /* ignore */ }
    }
    state.watchLines.clear();
    // 仅当 watch.symbol === 当前图表 symbol 时画线
    for (const w of state.watches.values()) {
      if (w.symbol !== state.klineSymbol) continue;
      const dirArrow = { up: '↑', down: '↓', cross: '↕' }[w.direction] || '↕';
      const title = `${dirArrow} ${fmt(w.price, 2)}${w.note ? ' · ' + w.note : ''}`;
      const line = candleSeries.createPriceLine({
        price: w.price, color: WATCH_COLOR, title,
        lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true,
      });
      state.watchLines.set(w.id, line);
    }
  }

  function refreshWatchList() {
    const ul = $('#watchList');
    ul.innerHTML = '';
    const list = Array.from(state.watches.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (list.length === 0) {
      ul.innerHTML = '<li style="color:#8b93a7;cursor:default">暂无监测点</li>';
      return;
    }
    const dirLabel = { up: '↑ 上穿', down: '↓ 下穿', cross: '↕ 穿越' };
    for (const w of list) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="w-dir ${w.direction}">${dirLabel[w.direction] || w.direction}</span>
        <span class="w-symbol">${w.symbol}</span>
        <span class="w-price">${fmt(w.price, 2)}</span>
        ${w.note ? `<span class="w-note">${escapeHtml(w.note)}</span>` : ''}
        ${w.once ? '' : '<span class="w-once">持续</span>'}
        <button class="w-del" data-id="${w.id}">×</button>
      `;
      ul.appendChild(li);
    }
    ul.querySelectorAll('.w-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        await fetch('/api/watches/' + encodeURIComponent(id), { method: 'DELETE' });
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  $('#watchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      symbol: $('#wfSymbol').value.trim().toUpperCase(),
      price: parseFloat($('#wfPrice').value),
      direction: $('#wfDirection').value,
      once: $('#wfOnce').checked,
      note: $('#wfNote').value.trim(),
    };
    const r = await fetch('/api/watches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) { alert('添加失败: ' + j.error); return; }
    $('#wfPrice').value = '';
    $('#wfNote').value = '';
  });

  // 默认 symbol 表单字段联动：在切换图表 symbol 时同步
  function syncDefaultSymbolToForm() {
    const cur = state.klineSymbol || getDefaultSymbol();
    if (!$('#wfSymbol').value) $('#wfSymbol').value = cur;
  }

  async function loadWatches() {
    const r = await fetch('/api/watches');
    const j = await r.json();
    if (!j.ok) return;
    state.watches.clear();
    for (const w of j.watches) state.watches.set(w.id, w);
    refreshWatchList();
    refreshWatchLines();
  }

  // ====== 静音按钮 ======
  function refreshMuteBtn() {
    $('#muteBtn').textContent = Sound.muted ? '🔇' : '🔊';
  }
  $('#muteBtn').addEventListener('click', () => { Sound.toggleMuted(); refreshMuteBtn(); });
  $('#testSoundBtn').addEventListener('click', () => Sound.test());
  refreshMuteBtn();

  loadActivePlans();
  loadTrades();
  loadWatches();
  connectSSE();
  syncDefaultSymbolToForm();

  // 顶栏北京时间走秒
  const updateClock = () => { $('#serverTime').textContent = fmtTime(Date.now()); };
  updateClock();
  setInterval(updateClock, 1000);
})();

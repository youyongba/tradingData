'use strict';
const log = require('../utils/logger');
const bus = require('./eventBus');
const { stream } = require('./binance');
const { sendMessage } = require('./telegram');
const store = require('../utils/store');

/**
 * 价格监测点（独立于交易计划的轻量预警）
 *
 * 数据结构：
 * {
 *   id: 'watch-BTCUSDT-1700000000000',
 *   symbol: 'BTCUSDT',
 *   price: 76500,
 *   direction: 'cross' | 'up' | 'down',
 *     // up   : 价格从下方穿上来（lastPrice < target && newPrice >= target）
 *     // down : 价格从上方穿下来
 *     // cross: 任一方向首次穿越
 *   note: '关键阻力',
 *   once: true,            // 触发后自动删除
 *   createdAt: 1700000000000,
 *   triggered: false,
 *   triggeredAt: null,
 *   triggeredPrice: null,
 *   _lastPrice: null,      // 跟踪上一次 mark，用于穿越判定
 * }
 */
class WatchService {
  constructor() {
    this.watches = new Map();
    this._restore();
    bus.on('mark', (e) => this._onMark(e));
  }

  _restore() {
    const saved = store.readWatches();
    for (const id of Object.keys(saved)) {
      const w = saved[id];
      if (w.triggered && w.once) continue;
      this.watches.set(id, w);
      stream.subscribe(w.symbol);
      log.info(`恢复监测点 ${id} ${w.symbol} ${w.direction} @ ${w.price}`);
    }
  }

  _persist() {
    const out = {};
    for (const [id, w] of this.watches) out[id] = w;
    store.writeWatches(out);
  }

  list() {
    return Array.from(this.watches.values())
      .map((w) => this._safe(w))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  add(input) {
    const symbol = String(input.symbol || '').trim().toUpperCase();
    if (!symbol) throw new Error('缺少 symbol');
    const price = Number(input.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error('price 必须是正数');
    const direction = String(input.direction || 'cross').toLowerCase();
    if (!['cross', 'up', 'down'].includes(direction)) {
      throw new Error('direction 只能是 cross / up / down');
    }
    const once = input.once === undefined ? true : !!input.once;
    const note = String(input.note || '').slice(0, 200);

    const id = `watch-${symbol}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const watch = {
      id, symbol, price, direction, once, note,
      createdAt: Date.now(),
      triggered: false,
      triggeredAt: null,
      triggeredPrice: null,
      _lastPrice: stream.getMark(symbol) ?? null,
    };
    this.watches.set(id, watch);
    stream.subscribe(symbol);
    this._persist();
    log.info(`[Watch] 新增 ${id} ${symbol} ${direction} @ ${price}`);
    bus.emit('watch:new', this._safe(watch));
    this._notifyNew(watch);
    return this._safe(watch);
  }

  remove(id) {
    const w = this.watches.get(id);
    if (!w) return null;
    this.watches.delete(id);
    stream.unsubscribe(w.symbol);
    this._persist();
    log.info(`[Watch] 删除 ${id}`);
    bus.emit('watch:removed', this._safe(w));
    return this._safe(w);
  }

  removeBySymbol(symbol, direction) {
    const sym = String(symbol).toUpperCase();
    const targets = this.list().filter((w) => w.symbol === sym && (!direction || w.direction === direction));
    return targets.map((w) => this.remove(w.id)).filter(Boolean);
  }

  removeAll() {
    return this.list().map((w) => this.remove(w.id)).filter(Boolean);
  }

  _onMark({ symbol, price }) {
    for (const w of this.watches.values()) {
      if (w.symbol !== symbol) continue;
      this._check(w, price);
    }
  }

  _check(w, price) {
    if (!Number.isFinite(price)) return;
    const last = w._lastPrice;
    w._lastPrice = price;
    if (last == null) return; // 首次只记录，不触发（避免装载即触发）

    let hit = false;
    if (w.direction === 'up') {
      hit = last < w.price && price >= w.price;
    } else if (w.direction === 'down') {
      hit = last > w.price && price <= w.price;
    } else {
      // cross
      hit = (last < w.price && price >= w.price) || (last > w.price && price <= w.price);
    }
    if (!hit) return;

    w.triggered = true;
    w.triggeredAt = Date.now();
    w.triggeredPrice = price;
    log.info(`[Watch] 触发 ${w.id} ${w.symbol} ${w.direction} @ ${w.price} (实际 ${price})`);
    bus.emit('watch:trigger', this._safe(w));
    this._notifyTrigger(w);

    if (w.once) {
      // 一次性，触发后删除
      this.watches.delete(w.id);
      stream.unsubscribe(w.symbol);
      this._persist();
      bus.emit('watch:removed', this._safe(w));
    } else {
      // 持续模式：重置 triggered 但保留触发记录的最近值
      w.triggered = false;
      this._persist();
    }
  }

  _safe(w) {
    const { _lastPrice, ...rest } = w; // 去掉内部字段
    return rest;
  }

  _notifyNew(w) {
    const dir = { up: '↑ 上穿', down: '↓ 下穿', cross: '↕ 任意穿越' }[w.direction] || w.direction;
    const text =
`<b>📌 新增价格监测</b>  <code>${w.symbol}</code>
${dir}: <code>${w.price}</code>
${w.note ? '备注: ' + w.note + '\n' : ''}模式: ${w.once ? '一次性' : '持续提醒'}`;
    sendMessage(text);
  }

  _notifyTrigger(w) {
    const dir = { up: '↑ 上穿', down: '↓ 下穿', cross: '↕ 穿越' }[w.direction] || w.direction;
    const text =
`<b>🔔 价格触达</b>  <code>${w.symbol}</code>
${dir} <code>${w.price}</code>
当前价: <b>${w.triggeredPrice}</b>
${w.note ? '备注: ' + w.note + '\n' : ''}${w.once ? '（一次性，已自动删除）' : '（持续提醒）'}`;
    sendMessage(text);
  }
}

module.exports = new WatchService();

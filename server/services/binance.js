'use strict';
const axios = require('axios');
const WebSocket = require('ws');
const config = require('../config');
const log = require('../utils/logger');
const bus = require('./eventBus');
const { agent } = require('../utils/proxy');

/**
 * 拉取 1H K线历史
 * GET /fapi/v1/klines?symbol=&interval=1h&limit=
 */
async function fetchKlines(symbol, limit = 200) {
  const url = `${config.binance.rest}/fapi/v1/klines`;
  const { data } = await axios.get(url, {
    params: { symbol: symbol.toUpperCase(), interval: '1h', limit },
    timeout: 15000,
    httpsAgent: agent || undefined,
    proxy: agent ? false : undefined,
  });
  return data.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

/**
 * 拉取 mark 价格（REST 兜底）
 * GET /fapi/v1/premiumIndex?symbol=
 */
async function fetchMarkPrice(symbol) {
  const url = `${config.binance.rest}/fapi/v1/premiumIndex`;
  const { data } = await axios.get(url, {
    params: { symbol: symbol.toUpperCase() },
    timeout: 8000,
    httpsAgent: agent || undefined,
    proxy: agent ? false : undefined,
  });
  return parseFloat(data.markPrice);
}

/**
 * 标记价格 + 1H K线 订阅管理器
 *  - 每个 symbol 一组 stream：<symbol>@markPrice@1s + <symbol>@kline_1h
 *  - 引用计数：subscribe / unsubscribe
 *  - 自动重连
 */
class StreamManager {
  constructor() {
    this.ws = null;
    this.refCounts = new Map(); // symbol -> refcount
    this.lastMark = new Map();  // symbol -> price
    this.connecting = false;
    this.reconnectTimer = null;

    // REST 轮询兜底：当 WS 不可用时持续工作
    this.pollTimer = null;
    this.pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || '2000', 10);
    this.klinePollTimer = null;
    this.klinePollIntervalMs = parseInt(process.env.KLINE_POLL_INTERVAL_MS || '15000', 10);
    this.wsMsgCount = 0;
    this.lastWsMsgAt = 0;
    this.healthTimer = null;
    this.pollMode = false;
  }

  _streams() {
    const out = [];
    for (const sym of this.refCounts.keys()) {
      const s = sym.toLowerCase();
      out.push(`${s}@aggTrade`);
      out.push(`${s}@markPrice@1s`);
      out.push(`${s}@kline_1h`);
    }
    return out;
  }

  _ensure() {
    if (this.connecting) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._resubscribe();
      return;
    }
    if (this.refCounts.size === 0) return;
    this._connect();
  }

  _connect() {
    this.connecting = true;
    const url = `${config.binance.ws}/stream?streams=${this._streams().join('/')}`;
    log.info('连接币安 WS:', url);
    const ws = new WebSocket(url, agent ? { agent } : undefined);
    this.ws = ws;

    let firstLogged = false;
    this.wsMsgCount = 0;
    ws.on('open', () => {
      this.connecting = false;
      this.lastWsMsgAt = Date.now();
      log.info('币安 WS 已连接');
      this._startHealthCheck();
    });

    ws.on('message', (raw) => {
      this.wsMsgCount++;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      const data = msg.data || msg;
      if (!firstLogged) {
        firstLogged = true;
        log.info('收到首条 WS 消息:', data.e || JSON.stringify(data).slice(0, 120));
      }
      // 跳过 SUBSCRIBE/UNSUBSCRIBE 等管理消息（无 e 字段），它们不是市场数据
      if (!data || !data.e) return;
      // 只有真正的市场数据到来时才认为"WS 数据流可用"
      this.lastWsMsgAt = Date.now();
      if (this.pollMode) {
        log.info('WS 数据流恢复，停止 REST 轮询');
        this._stopPolling();
      }

      if (data.e === 'markPriceUpdate') {
        const sym = data.s;
        const price = parseFloat(data.p);
        if (!Number.isFinite(price)) return;
        this.lastMark.set(sym, price);
        bus.emit('mark', { symbol: sym, price, time: data.E });
      } else if (data.e === 'aggTrade') {
        // aggTrade 备用触发流（每笔成交都会推），价格用于触发判定更及时
        const sym = data.s;
        const price = parseFloat(data.p);
        if (!Number.isFinite(price)) return;
        this.lastMark.set(sym, price);
        bus.emit('mark', { symbol: sym, price, time: data.E });
      } else if (data.e === 'kline') {
        const k = data.k;
        bus.emit('kline', {
          symbol: data.s,
          time: Math.floor(k.t / 1000),
          open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
          closed: !!k.x,
        });
      }
    });

    this._heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        log.info(`WS 心跳：${this.wsMsgCount} 条消息已接收`);
      }
    }, 30000);

    ws.on('close', () => {
      log.warn('币安 WS 已断开，3s 后重连');
      this.ws = null;
      this.connecting = false;
      clearInterval(this._heartbeat);
      clearInterval(this.healthTimer);
      this.healthTimer = null;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this._ensure(), 3000);
      // 同步启动 REST 轮询确保不丢监控
      this._startPolling();
    });

    ws.on('error', (err) => {
      log.error('币安 WS 错误:', err.message);
      try { ws.close(); } catch (_) { /* ignore */ }
    });
  }

  _resubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const streams = this._streams();
    if (streams.length === 0) {
      try { this.ws.close(); } catch (_) { /* ignore */ }
      return;
    }
    try {
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIBE',
        params: streams,
        id: Date.now(),
      }));
    } catch (err) {
      log.error('重新订阅失败:', err.message);
    }
  }

  subscribe(symbol) {
    const s = symbol.toUpperCase();
    this.refCounts.set(s, (this.refCounts.get(s) || 0) + 1);
    log.info(`订阅 ${s}，当前引用数=${this.refCounts.get(s)}`);
    this._ensure();
    // 主动启动 REST 轮询，立即可用；WS 一来数据就关掉它
    this._startPolling();
  }

  unsubscribe(symbol) {
    const s = symbol.toUpperCase();
    const c = (this.refCounts.get(s) || 0) - 1;
    if (c <= 0) {
      this.refCounts.delete(s);
      log.info(`取消订阅 ${s}`);
    } else {
      this.refCounts.set(s, c);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
    try {
      const ls = s.toLowerCase();
      this.ws.send(JSON.stringify({
        method: 'UNSUBSCRIBE',
        params: [`${ls}@aggTrade`, `${ls}@markPrice@1s`, `${ls}@kline_1h`],
        id: Date.now(),
      }));
    } catch (_) { /* ignore */ }
    }
    if (this.refCounts.size === 0) {
      if (this.ws) { try { this.ws.close(); } catch (_) { /* ignore */ } }
      this._stopPolling();
    }
  }

  getMark(symbol) {
    return this.lastMark.get(symbol.toUpperCase());
  }

  // ===== REST 轮询兜底 =====
  _startHealthCheck() {
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastWsMsgAt;
      // WS 已 open 但 30 秒没数据 -> 启动 REST 轮询作为兜底
      if (idleMs > 30000 && !this.pollMode && this.refCounts.size > 0) {
        log.warn(`WS 已 ${Math.round(idleMs / 1000)}s 无数据，启用 REST 轮询兜底`);
        this._startPolling();
      }
    }, 5000);
  }

  _startPolling() {
    if (this.refCounts.size === 0) return;
    if (!this.pollMode) {
      this.pollMode = true;
      log.info(`启动 REST 轮询模式，markPrice 每 ${this.pollIntervalMs}ms / kline 每 ${this.klinePollIntervalMs}ms`);
      this._tick();
      this.pollTimer = setInterval(() => this._tick(), this.pollIntervalMs);
    }
    if (!this.klinePollTimer) {
      this._tickKline();
      this.klinePollTimer = setInterval(() => this._tickKline(), this.klinePollIntervalMs);
    }
  }

  _stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.klinePollTimer) clearInterval(this.klinePollTimer);
    this.pollTimer = null;
    this.klinePollTimer = null;
    this.pollMode = false;
  }

  async _tick() {
    const symbols = Array.from(this.refCounts.keys());
    await Promise.all(symbols.map(async (sym) => {
      try {
        const price = await fetchMarkPrice(sym);
        if (Number.isFinite(price)) {
          this.lastMark.set(sym, price);
          bus.emit('mark', { symbol: sym, price, time: Date.now() });
        }
      } catch (err) {
        log.warn(`轮询 ${sym} markPrice 失败: ${err.message}`);
      }
    }));
  }

  async _tickKline() {
    const symbols = Array.from(this.refCounts.keys());
    await Promise.all(symbols.map(async (sym) => {
      try {
        // 只取最新一根（in-progress 的当前 1H K 线）
        // lightweight-charts 的 update() 不支持回写更早的 K 线
        const ks = await fetchKlines(sym, 1);
        const k = ks[ks.length - 1];
        if (k) bus.emit('kline', { symbol: sym, ...k, closed: false });
      } catch (err) {
        log.warn(`轮询 ${sym} kline 失败: ${err.message}`);
      }
    }));
  }
}

const stream = new StreamManager();

module.exports = { fetchKlines, stream };

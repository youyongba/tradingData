'use strict';
const express = require('express');
const engine = require('../services/engine');
const { fetchKlines, stream } = require('../services/binance');
const { readTradeLog } = require('../utils/store');
const bus = require('../services/eventBus');

const router = express.Router();

router.get('/plans', (req, res) => {
  res.json({ ok: true, plans: engine.list() });
});

router.get('/plans/:id', (req, res) => {
  const p = engine.get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: '不存在' });
  res.json({ ok: true, plan: p });
});

router.delete('/plans/:id', (req, res) => {
  const p = engine.cancel(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: '不存在' });
  res.json({ ok: true, plan: p });
});

router.get('/klines', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    const limit = Math.min(parseInt(req.query.limit || '300', 10), 1000);
    if (!symbol) return res.status(400).json({ ok: false, error: '缺少 symbol' });
    const klines = await fetchKlines(symbol, limit);
    res.json({ ok: true, symbol, interval: '1h', klines });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/mark', (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  res.json({ ok: true, symbol, price: stream.getMark(symbol) ?? null });
});

// 前端 viewer 临时订阅（用于"无活跃计划时也展示实时 K 线"）
// 简单实现：每次调用都 +1 引用，由前端在 unload 时调用 unsubscribe 释放
router.get('/subscribe', (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ ok: false, error: '缺少 symbol' });
  stream.subscribe(symbol);
  res.json({ ok: true, symbol });
});

router.get('/unsubscribe', (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ ok: false, error: '缺少 symbol' });
  stream.unsubscribe(symbol);
  res.json({ ok: true, symbol });
});

router.get('/trades', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  res.json({ ok: true, trades: readTradeLog(limit) });
});

// SSE 实时事件
router.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('hello', { ts: Date.now() });

  const onMark = (e) => send('mark', e);
  const onKline = (e) => send('kline', e);
  const onNew = (p) => send('plan:new', p);
  const onTrigger = (e) => send('plan:trigger', e);
  const onClosed = (p) => send('plan:closed', p);

  bus.on('mark', onMark);
  bus.on('kline', onKline);
  bus.on('plan:new', onNew);
  bus.on('plan:trigger', onTrigger);
  bus.on('plan:closed', onClosed);

  const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25000);

  req.on('close', () => {
    clearInterval(ping);
    bus.off('mark', onMark);
    bus.off('kline', onKline);
    bus.off('plan:new', onNew);
    bus.off('plan:trigger', onTrigger);
    bus.off('plan:closed', onClosed);
  });
});

module.exports = router;

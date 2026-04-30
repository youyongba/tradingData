'use strict';
const express = require('express');
const config = require('../config');
const { parsePlan } = require('../services/plan');
const engine = require('../services/engine');
const watchService = require('../services/watch');
const log = require('../utils/logger');

const router = express.Router();

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token || token !== config.authToken) {
    return res.status(401).json({ ok: false, error: '未授权' });
  }
  next();
}

router.post('/webhook', auth, (req, res) => {
  try {
    const plan = parsePlan(req.body);
    engine.add(plan);
    res.json({ ok: true, plan });
  } catch (err) {
    log.warn('解析计划失败:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * 取消计划（webhook 形态）
 *
 * Body 任一种：
 *   { "id": "BTCUSDT-1777..." }     // 按 id 精确取消
 *   { "symbol": "BTCUSDT" }         // 取消该 symbol 下所有活跃计划
 *   { "symbol": "BTCUSDT", "side": "LONG" }   // 同 symbol+side 全部取消
 *   { "all": true }                 // 取消所有活跃计划
 */
router.post('/webhook/cancel', auth, (req, res) => {
  try {
    const { id, symbol, side, all } = req.body || {};

    if (id) {
      const p = engine.cancel(String(id));
      if (!p) return res.status(404).json({ ok: false, error: '计划不存在或已结束' });
      log.info(`[Webhook] 取消计划 ${p.id}`);
      return res.json({ ok: true, cancelled: [p] });
    }

    let targets = engine.list();
    if (!all) {
      if (!symbol) return res.status(400).json({ ok: false, error: '需提供 id / symbol / all 之一' });
      const sym = String(symbol).toUpperCase();
      targets = targets.filter((p) => p.symbol === sym);
      if (side) {
        const s = String(side).toUpperCase();
        targets = targets.filter((p) => p.side === s);
      }
    }

    if (targets.length === 0) {
      return res.status(404).json({ ok: false, error: '没有匹配的活跃计划' });
    }

    const cancelled = targets
      .map((p) => engine.cancel(p.id))
      .filter(Boolean);
    log.info(`[Webhook] 批量取消 ${cancelled.length} 个计划: ${cancelled.map((p) => p.id).join(', ')}`);
    res.json({ ok: true, cancelled });
  } catch (err) {
    log.warn('取消计划失败:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * 添加价格监测点（无关交易计划，独立预警）
 * Body:
 *   {
 *     "symbol": "BTCUSDT",
 *     "price": 76500,
 *     "direction": "cross" | "up" | "down",   // 默认 cross
 *     "note": "关键阻力",
 *     "once": true                              // 默认 true
 *   }
 *
 * 也支持批量：传 watches: [...]
 */
router.post('/webhook/watch', auth, (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.watches) ? body.watches : [body];
    const created = items.map((it) => watchService.add(it));
    res.json({ ok: true, watches: created });
  } catch (err) {
    log.warn('添加监测点失败:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * 删除价格监测点
 * Body 任一种：
 *   { "id": "watch-..." }
 *   { "symbol": "BTCUSDT" }
 *   { "symbol": "BTCUSDT", "direction": "up" }
 *   { "all": true }
 */
router.post('/webhook/watch/cancel', auth, (req, res) => {
  try {
    const { id, symbol, direction, all } = req.body || {};
    if (id) {
      const w = watchService.remove(String(id));
      if (!w) return res.status(404).json({ ok: false, error: '不存在' });
      return res.json({ ok: true, removed: [w] });
    }
    if (all) {
      const removed = watchService.removeAll();
      return res.json({ ok: true, removed });
    }
    if (!symbol) return res.status(400).json({ ok: false, error: '需提供 id / symbol / all' });
    const removed = watchService.removeBySymbol(symbol, direction);
    if (removed.length === 0) return res.status(404).json({ ok: false, error: '没有匹配的监测点' });
    res.json({ ok: true, removed });
  } catch (err) {
    log.warn('删除监测点失败:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;

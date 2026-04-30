'use strict';
const log = require('../utils/logger');
const bus = require('./eventBus');
const { stream } = require('./binance');
const { sendMessage } = require('./telegram');
const store = require('../utils/store');

/**
 * 交易状态机
 *  PENDING  -> entry 触发 -> RUNNING
 *  RUNNING  -> tp1 命中    -> RUNNING_BE   （SL 移到入场价 = 保本）
 *  RUNNING_* -> tp3/sl 命中 -> CLOSED
 *
 * 触发判定（依据标记价格）：
 *  LONG:
 *    entry 触发：price <= entry  (回踩进场)
 *    tp 触发  ：price >= tp_n
 *    sl 触发  ：price <= sl
 *  SHORT:
 *    entry 触发：price >= entry  (反弹进场)
 *    tp 触发  ：price <= tp_n
 *    sl 触发  ：price >= sl
 */
class Engine {
  constructor() {
    this.plans = new Map(); // id -> plan
    this._restore();
    bus.on('mark', (e) => this._onMark(e));
  }

  _restore() {
    const saved = store.readActive();
    for (const id of Object.keys(saved)) {
      const p = saved[id];
      if (p.state !== 'CLOSED') {
        this.plans.set(id, p);
        stream.subscribe(p.symbol);
        log.info(`恢复活跃计划 ${id} ${p.symbol} ${p.side} state=${p.state}`);
      }
    }
  }

  _persist() {
    const out = {};
    for (const [id, p] of this.plans) out[id] = p;
    store.writeActive(out);
  }

  list() {
    return Array.from(this.plans.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    return this.plans.get(id);
  }

  add(plan) {
    this.plans.set(plan.id, plan);
    stream.subscribe(plan.symbol);
    this._persist();
    log.info(`新增计划 ${plan.id} ${plan.symbol} ${plan.side} entry=${plan.entry}`);
    bus.emit('plan:new', plan);
    this._notifyNew(plan);
    return plan;
  }

  cancel(id) {
    const p = this.plans.get(id);
    if (!p) return null;
    if (p.state === 'CLOSED') return p;
    p.state = 'CLOSED';
    p.closedReason = 'CANCELLED';
    p.closedAt = Date.now();
    p.pnlPct = 0;
    store.appendTradeLog(p);
    bus.emit('plan:closed', p);
    this._notifyClose(p);
    this.plans.delete(id);
    stream.unsubscribe(p.symbol);
    this._persist();
    return p;
  }

  _onMark({ symbol, price }) {
    for (const plan of this.plans.values()) {
      if (plan.symbol !== symbol) continue;
      this._checkPlan(plan, price);
    }
  }

  _checkPlan(plan, price) {
    const isLong = plan.side === 'LONG';

    if (plan.state === 'PENDING') {
      const hit = isLong ? price <= plan.entry : price >= plan.entry;
      if (hit) return this._trigger(plan, 'ENTRY', price);
      return;
    }

    // 已入场：先看止损，再看止盈（保守）
    const slHit = isLong ? price <= plan.sl : price >= plan.sl;
    if (slHit) {
      const reason = plan.state === 'RUNNING_BE' ? 'BE_SL' : 'SL';
      return this._trigger(plan, reason, price);
    }

    if (!plan.triggers.find((t) => t.type === 'TP1')) {
      const hit = isLong ? price >= plan.tp1 : price <= plan.tp1;
      if (hit) return this._trigger(plan, 'TP1', price);
    } else if (!plan.triggers.find((t) => t.type === 'TP2')) {
      const hit = isLong ? price >= plan.tp2 : price <= plan.tp2;
      if (hit) return this._trigger(plan, 'TP2', price);
    } else if (!plan.triggers.find((t) => t.type === 'TP3')) {
      const hit = isLong ? price >= plan.tp3 : price <= plan.tp3;
      if (hit) return this._trigger(plan, 'TP3', price);
    }
  }

  _trigger(plan, type, price) {
    if (plan.triggers.find((t) => t.type === type)) return;
    const evt = { type, price, time: Date.now() };
    plan.triggers.push(evt);
    log.info(`[触发] ${plan.symbol} ${plan.side} ${type} @ ${price}`);

    if (type === 'ENTRY') {
      plan.state = 'RUNNING';
    } else if (type === 'TP1') {
      // 动态保本：SL 移动到入场价
      plan.sl = plan.entry;
      plan.state = 'RUNNING_BE';
      log.info(`[保本] ${plan.symbol} SL 移至入场价 ${plan.entry}`);
    } else if (type === 'TP2') {
      // 可选：把 SL 进一步移到 TP1（这里采用更激进的保本：SL=TP1）
      plan.sl = plan.tp1;
      log.info(`[滚动止损] ${plan.symbol} SL 移至 TP1 ${plan.tp1}`);
    } else if (type === 'TP3' || type === 'SL' || type === 'BE_SL') {
      plan.state = 'CLOSED';
      plan.closedReason = type;
      plan.closedAt = Date.now();
      plan.exitPrice = price;
      plan.pnlPct = this._calcPnl(plan, price);
    }

    this._persist();
    bus.emit('plan:trigger', { plan, event: evt });
    this._notifyTrigger(plan, evt);

    if (plan.state === 'CLOSED') {
      store.appendTradeLog(plan);
      bus.emit('plan:closed', plan);
      this._notifyClose(plan);
      this.plans.delete(plan.id);
      stream.unsubscribe(plan.symbol);
      this._persist();
    }
  }

  _calcPnl(plan, exitPrice) {
    const sign = plan.side === 'LONG' ? 1 : -1;
    return round(((exitPrice - plan.entry) / plan.entry) * 100 * sign, 3);
  }

  _notifyNew(plan) {
    const arrow = plan.side === 'LONG' ? '🟢 多' : '🔴 空';
    const text =
`<b>新交易计划</b>  ${arrow}  <code>${plan.symbol}</code>
入场: <code>${plan.entry}</code>
TP1: <code>${plan.tp1}</code>  (${plan.tp1Pct}%, RR=${plan.rr1})
TP2: <code>${plan.tp2}</code>  (${plan.tp2Pct}%, RR=${plan.rr2})
TP3: <code>${plan.tp3}</code>  (${plan.tp3Pct}%, RR=${plan.rr3})
SL : <code>${plan.sl}</code>  (-${Math.abs(plan.slPct)}%)
${plan.comment ? '备注: ' + plan.comment : ''}`;
    sendMessage(text);
  }

  _notifyTrigger(plan, evt) {
    const arrow = plan.side === 'LONG' ? '🟢 多' : '🔴 空';
    const tag = {
      ENTRY: '✅ 入场',
      TP1: '🎯 TP1',
      TP2: '🎯 TP2',
      TP3: '🏁 TP3',
      SL: '🛑 止损',
      BE_SL: '🟦 保本止损',
    }[evt.type] || evt.type;

    let extra = '';
    if (evt.type === 'TP1') extra = '\n→ 已自动将止损移至入场价（保本）';
    if (evt.type === 'TP2') extra = '\n→ 已自动将止损移至 TP1（锁定收益）';
    const text =
`<b>${tag}</b>  ${arrow}  <code>${plan.symbol}</code>
价格: <code>${evt.price}</code>
入场: <code>${plan.entry}</code>  当前 SL: <code>${plan.sl}</code>${extra}`;
    sendMessage(text);
  }

  _notifyClose(plan) {
    const arrow = plan.side === 'LONG' ? '🟢 多' : '🔴 空';
    const reason = {
      TP3: '✅ 全部止盈',
      SL: '❌ 止损',
      BE_SL: '🟦 保本离场',
      CANCELLED: '⚪ 手动取消',
    }[plan.closedReason] || plan.closedReason;
    const pnl = plan.pnlPct;
    const sign = pnl >= 0 ? '+' : '';
    const text =
`<b>交易结束 · ${reason}</b>  ${arrow}  <code>${plan.symbol}</code>
入场: <code>${plan.entry}</code>
离场: <code>${plan.exitPrice}</code>
盈亏: <b>${sign}${pnl}%</b>
触发顺序: ${plan.triggers.map((t) => t.type).join(' → ')}`;
    sendMessage(text);
  }
}

function round(n, d = 2) {
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
}

module.exports = new Engine();

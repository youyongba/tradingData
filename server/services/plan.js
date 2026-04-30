'use strict';

/**
 * 解析交易计划
 *
 * 模式一（精确）：
 *   { symbol, side, entry, tp1, tp2, tp3, sl, comment? }
 *
 * 模式二（百分比）：
 *   {
 *     symbol, side, entry,
 *     tp1Pct, tp2Pct, tp3Pct, slPct,   // 间隔百分比，正数；如 0.5 表示 0.5%
 *     comment?
 *   }
 *
 * 输出标准化对象，并附带方向校验、盈亏比 RR。
 */
function parsePlan(body) {
  if (!body || typeof body !== 'object') throw new Error('请求体必须是 JSON');

  const symbol = String(body.symbol || '').trim().toUpperCase();
  if (!symbol) throw new Error('缺少 symbol');

  const side = String(body.side || '').trim().toUpperCase();
  if (!['LONG', 'SHORT'].includes(side)) throw new Error('side 必须是 LONG 或 SHORT');

  const entry = num(body.entry, 'entry');

  let tp1, tp2, tp3, sl;
  let mode;

  const hasExact = ['tp1', 'tp2', 'tp3', 'sl'].some((k) => body[k] !== undefined);
  const hasPct = ['tp1Pct', 'tp2Pct', 'tp3Pct', 'slPct'].some((k) => body[k] !== undefined);

  if (hasExact && !hasPct) {
    mode = 'exact';
    tp1 = num(body.tp1, 'tp1');
    tp2 = num(body.tp2, 'tp2');
    tp3 = num(body.tp3, 'tp3');
    sl = num(body.sl, 'sl');
  } else if (hasPct && !hasExact) {
    mode = 'percent';
    const tp1Pct = num(body.tp1Pct, 'tp1Pct');
    const tp2Pct = num(body.tp2Pct, 'tp2Pct');
    const tp3Pct = num(body.tp3Pct, 'tp3Pct');
    const slPct = num(body.slPct, 'slPct');
    if (side === 'LONG') {
      tp1 = entry * (1 + tp1Pct / 100);
      tp2 = entry * (1 + tp2Pct / 100);
      tp3 = entry * (1 + tp3Pct / 100);
      sl = entry * (1 - slPct / 100);
    } else {
      tp1 = entry * (1 - tp1Pct / 100);
      tp2 = entry * (1 - tp2Pct / 100);
      tp3 = entry * (1 - tp3Pct / 100);
      sl = entry * (1 + slPct / 100);
    }
  } else {
    throw new Error('请提供 tp1/tp2/tp3/sl 或 tp1Pct/tp2Pct/tp3Pct/slPct（二选一）');
  }

  validateSide(side, entry, tp1, tp2, tp3, sl);

  const tp1Pct = pct(side, entry, tp1);
  const tp2Pct = pct(side, entry, tp2);
  const tp3Pct = pct(side, entry, tp3);
  const slPct = pct(side, entry, sl) * -1;

  const reward1 = Math.abs(tp1 - entry);
  const reward2 = Math.abs(tp2 - entry);
  const reward3 = Math.abs(tp3 - entry);
  const risk = Math.abs(entry - sl);
  const rr1 = round(reward1 / risk, 2);
  const rr2 = round(reward2 / risk, 2);
  const rr3 = round(reward3 / risk, 2);

  return {
    id: `${symbol}-${Date.now()}`,
    symbol,
    side,
    mode,
    entry: round(entry, 8),
    tp1: round(tp1, 8),
    tp2: round(tp2, 8),
    tp3: round(tp3, 8),
    sl: round(sl, 8),
    initialSl: round(sl, 8),
    tp1Pct: round(tp1Pct, 3),
    tp2Pct: round(tp2Pct, 3),
    tp3Pct: round(tp3Pct, 3),
    slPct: round(slPct, 3),
    rr1, rr2, rr3,
    state: 'PENDING',
    triggers: [],
    createdAt: Date.now(),
    comment: body.comment || '',
  };
}

function num(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字`);
  return n;
}

function validateSide(side, entry, tp1, tp2, tp3, sl) {
  if (side === 'LONG') {
    if (!(sl < entry)) throw new Error('LONG: sl 必须 < entry');
    if (!(entry < tp1 && tp1 < tp2 && tp2 < tp3))
      throw new Error('LONG: 必须满足 entry < tp1 < tp2 < tp3');
  } else {
    if (!(sl > entry)) throw new Error('SHORT: sl 必须 > entry');
    if (!(entry > tp1 && tp1 > tp2 && tp2 > tp3))
      throw new Error('SHORT: 必须满足 entry > tp1 > tp2 > tp3');
  }
}

function pct(side, entry, target) {
  const diff = (target - entry) / entry * 100;
  return side === 'LONG' ? diff : -diff;
}

function round(n, d = 2) {
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
}

module.exports = { parsePlan };

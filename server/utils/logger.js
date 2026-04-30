'use strict';

// 东八区时间，格式：2026-05-01 04:01:23.123 +0800
function ts() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)} +0800`;
}

function fmt(level, args) {
  return `[${ts()}] [${level}] ` + args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }
    return String(a);
  }).join(' ');
}

module.exports = {
  info: (...a) => console.log(fmt('INFO', a)),
  warn: (...a) => console.warn(fmt('WARN', a)),
  error: (...a) => console.error(fmt('ERR ', a)),
  debug: (...a) => process.env.DEBUG && console.log(fmt('DBG ', a)),
};

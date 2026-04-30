'use strict';

const ts = () => new Date().toISOString();

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

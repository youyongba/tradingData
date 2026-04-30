'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ACTIVE_FILE = path.join(DATA_DIR, 'active.json');
const TRADES_LOG = path.join(DATA_DIR, 'trades.log');
const WATCHES_FILE = path.join(DATA_DIR, 'watches.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readActive() {
  ensureDir();
  if (!fs.existsSync(ACTIVE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8') || '{}');
  } catch (_) {
    return {};
  }
}

function writeActive(map) {
  ensureDir();
  fs.writeFileSync(ACTIVE_FILE, JSON.stringify(map, null, 2));
}

function appendTradeLog(record) {
  ensureDir();
  fs.appendFileSync(TRADES_LOG, JSON.stringify(record) + '\n');
}

function readTradeLog(limit = 200) {
  ensureDir();
  if (!fs.existsSync(TRADES_LOG)) return [];
  const lines = fs.readFileSync(TRADES_LOG, 'utf8').trim().split('\n').filter(Boolean);
  const slice = lines.slice(-limit);
  return slice.map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

function readWatches() {
  ensureDir();
  if (!fs.existsSync(WATCHES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(WATCHES_FILE, 'utf8') || '{}');
  } catch (_) {
    return {};
  }
}

function writeWatches(map) {
  ensureDir();
  fs.writeFileSync(WATCHES_FILE, JSON.stringify(map, null, 2));
}

module.exports = {
  readActive, writeActive,
  appendTradeLog, readTradeLog,
  readWatches, writeWatches,
};

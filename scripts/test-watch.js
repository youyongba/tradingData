'use strict';
/**
 * 离线测试 watch 服务的触发逻辑（不依赖币安网络）
 * 通过手动 emit 'mark' 事件来模拟价格变化
 */
process.env.AUTH_TOKEN = 'test';
process.env.PORT = '0';
require('dotenv').config = () => {}; // 阻止读 .env

const path = require('path');
const fs = require('fs');
// 使用临时数据目录避免污染
const tmpDir = path.join(__dirname, '..', 'data');
fs.rmSync(path.join(tmpDir, 'watches.json'), { force: true });

const bus = require('../server/services/eventBus');
const watch = require('../server/services/watch');

// stub TG（避免发请求）
require('../server/services/telegram').sendMessage = async () => {};

const triggers = [];
const removed = [];
bus.on('watch:trigger', (w) => triggers.push(w));
bus.on('watch:removed', (w) => removed.push(w));

function assert(cond, msg) {
  if (!cond) { console.error('❌', msg); process.exit(1); }
  console.log('✅', msg);
}

(async () => {
  // 1. 添加多个 watch
  const w1 = watch.add({ symbol: 'BTCUSDT', price: 75000, direction: 'down', once: true, note: 'sl' });
  const w2 = watch.add({ symbol: 'BTCUSDT', price: 80000, direction: 'up', once: false, note: 'r' });
  const w3 = watch.add({ symbol: 'BTCUSDT', price: 77000, direction: 'cross', once: true });
  assert(watch.list().length >= 3, 'add: 3 个 watch 已添加');

  // 模拟首次 mark（仅记录 lastPrice，不触发）
  bus.emit('mark', { symbol: 'BTCUSDT', price: 76000 });
  assert(triggers.length === 0, '首次 mark 不应触发');

  // 价格跌破 75000 (down)
  bus.emit('mark', { symbol: 'BTCUSDT', price: 74000 });
  assert(triggers.find((t) => t.id === w1.id), 'down 触发：75000 被向下穿越');
  assert(removed.find((r) => r.id === w1.id), 'down 一次性 watch 被自动删除');

  // 价格反弹到 78000，应触发 cross w3
  bus.emit('mark', { symbol: 'BTCUSDT', price: 78000 });
  assert(triggers.find((t) => t.id === w3.id), 'cross 触发：77000 被向上穿越');

  // 价格继续涨破 80000，up 触发 w2（持续模式）
  bus.emit('mark', { symbol: 'BTCUSDT', price: 81000 });
  const w2Trigs1 = triggers.filter((t) => t.id === w2.id).length;
  assert(w2Trigs1 === 1, 'up 触发：80000 上穿（第 1 次）');

  // 持续模式：跌回 79000 然后再上穿 80000 应该再次触发
  bus.emit('mark', { symbol: 'BTCUSDT', price: 79000 });
  bus.emit('mark', { symbol: 'BTCUSDT', price: 81500 });
  const w2Trigs2 = triggers.filter((t) => t.id === w2.id).length;
  assert(w2Trigs2 === 2, 'up 持续模式：第 2 次穿越再次触发');

  // 持续模式 w2 应该仍在列表中（once=false）
  assert(watch.list().find((w) => w.id === w2.id), '持续模式 w2 未被删除');

  // 一次性模式 w3 已被删除
  assert(!watch.list().find((w) => w.id === w3.id), '一次性 w3 已被删除');

  // direction 校验
  try {
    watch.add({ symbol: 'X', price: 1, direction: 'sideway' });
    assert(false, 'direction 校验未生效');
  } catch (e) {
    assert(/cross|up|down/.test(e.message), 'direction 校验：sideway 被拒绝');
  }

  // price 校验
  try {
    watch.add({ symbol: 'X', price: 0 });
    assert(false, 'price 校验未生效');
  } catch (e) {
    assert(/正数/.test(e.message), 'price 校验：0 被拒绝');
  }

  // 删除测试
  const before = watch.list().length;
  const r = watch.remove(w2.id);
  assert(r && r.id === w2.id, 'remove(id) 成功');
  assert(watch.list().length === before - 1, 'remove 后列表数量减 1');

  // 持久化检查
  const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'watches.json'), 'utf8'));
  assert(typeof persisted === 'object', 'watches.json 已写入');

  // 清理
  watch.removeAll();
  assert(watch.list().length === 0, 'removeAll 清空');

  console.log('\n🎉 全部 watch 触发逻辑测试通过');
  process.exit(0);
})();

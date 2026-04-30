# 币安合约 1H 预警系统

全栈预警系统：Webhook 接收交易计划 → 币安合约 WebSocket 实时监控标记价格 → 命中入场/止盈/止损时高亮、音效、Telegram 推送、动态保本止损、自动盈亏记录。

- **后端**：Express.js + ws (币安 WebSocket) + SSE 事件总线
- **前端**：TradingView Lightweight Charts + WebAudio 合成音效
- **持久化**：`data/active.json`（活跃计划，重启恢复）+ `data/trades.log`（已结束交易盈亏，按行 JSON）

---

## 目录结构

```
.
├── package.json
├── .env.example
├── server/
│   ├── index.js                # Express 入口
│   ├── config.js
│   ├── routes/
│   │   ├── webhook.js          # POST /webhook
│   │   └── api.js              # /api/plans /api/klines /api/events(SSE) /api/trades
│   ├── services/
│   │   ├── plan.js             # 解析计划（精确/百分比双模式）
│   │   ├── binance.js          # 1H K线拉取 + WS 订阅管理
│   │   ├── engine.js           # 状态机 + 触发判定 + 动态保本
│   │   ├── telegram.js
│   │   └── eventBus.js
│   └── utils/
│       ├── logger.js
│       └── store.js
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── sound.js                # WebAudio 合成 4 种音效
│   └── app.js                  # 图表 + SSE 订阅
└── data/                       # 运行时生成
```

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入：
#   AUTH_TOKEN  ——  Webhook 鉴权 Bearer Token
#   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  ——  可选，留空则只在前端展示，不推送

# 3. 启动
npm start            # 或 npm run dev (使用 nodemon)

# 4. 访问前端
# http://localhost:8787/
```

> **大陆网络环境**：`fapi.binance.com` 直连会被 RST。在 `.env` 设置 `HTTPS_PROXY=http://127.0.0.1:7890`（或你本地代理地址）即可让 REST / WebSocket / Telegram 全部走代理。

---

## Webhook：提交交易计划

`POST /webhook`，Header `Authorization: Bearer <AUTH_TOKEN>`，Body 为 JSON。

**模式 A · 精确价位**（直接给 entry/tp1-3/sl）：

```bash
curl -X POST http://localhost:8787/webhook \
  -H "Authorization: Bearer change-me-please" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "side": "LONG",
    "entry": 64500.5,
    "tp1": 65000,
    "tp2": 65500,
    "tp3": 66000,
    "sl": 64000,
    "comment": "1H 多头形态确认"
  }'
```

**模式 B · 百分比间隔**（系统据 entry 自动算价位）：

```bash
curl -X POST http://localhost:8787/webhook \
  -H "Authorization: Bearer change-me-please" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "ETHUSDT",
    "side": "SHORT",
    "entry": 3200,
    "tp1Pct": 0.5,
    "tp2Pct": 1.0,
    "tp3Pct": 1.8,
    "slPct": 0.6
  }'
```

> `tp*Pct` / `slPct` 都填**正数**，方向由 `side` 自动决定。例如 LONG 时 `slPct: 0.6` 表示 SL 在入场下方 0.6%。

**取消计划**：

```bash
# 按 id 精确取消
curl -X POST http://localhost:8787/webhook/cancel \
  -H "Authorization: Bearer change-me-please" \
  -H "Content-Type: application/json" \
  -d '{"id":"BTCUSDT-1777..."}'

# 按 symbol 取消（同一标的所有活跃计划）
curl -X POST http://localhost:8787/webhook/cancel \
  -H "Authorization: Bearer change-me-please" \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT"}'

# 按 symbol+side 精确批量取消
curl -X POST http://localhost:8787/webhook/cancel \
  -H "Authorization: Bearer change-me-please" \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","side":"LONG"}'

# 一键全部取消
curl -X POST http://localhost:8787/webhook/cancel \
  -H "Authorization: Bearer change-me-please" \
  -H "Content-Type: application/json" \
  -d '{"all":true}'
```

返回：

```json
{ "ok": true, "cancelled": [ { "id": "...", "closedReason": "CANCELLED", ... } ] }
```

取消后会同时：写入 `data/trades.log`、广播 SSE `plan:closed` 给前端、推送 TG 通知。

返回值会带上系统计算好的标准化字段：

```jsonc
{
  "ok": true,
  "plan": {
    "id": "ETHUSDT-1714400000000",
    "symbol": "ETHUSDT", "side": "SHORT",
    "entry": 3200, "tp1": 3184, "tp2": 3168, "tp3": 3142.4, "sl": 3219.2,
    "tp1Pct": 0.5, "tp2Pct": 1, "tp3Pct": 1.8, "slPct": 0.6,
    "rr1": 0.83, "rr2": 1.67, "rr3": 3,
    "state": "PENDING"
  }
}
```

校验规则：
- `LONG`：`sl < entry < tp1 < tp2 < tp3`
- `SHORT`：`tp3 < tp2 < tp1 < entry < sl`
- 不满足直接 400。

---

## 状态机 & 动态保本

```
PENDING ──(price 触及 entry)──► RUNNING
RUNNING ──(price 触及 tp1)──► RUNNING_BE  · 自动 SL → entry（保本）
RUNNING_BE ──(price 触及 tp2)──► RUNNING_BE  · 自动 SL → tp1（锁定收益）
RUNNING_BE ──(price 触及 tp3 / SL)──► CLOSED  · 写入 trades.log
```

- 触发判定基于币安**标记价格**（`<symbol>@markPrice@1s` stream）
- 计划存于 `data/active.json`，进程重启会自动恢复并重新订阅
- 结束后 `pnlPct = (exit - entry) / entry * 100 * (LONG?1:-1)`，按行追加到 `data/trades.log`

---

## REST / SSE 接口

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /webhook` | 提交计划（鉴权） |
| `POST /webhook/cancel` | 取消计划（鉴权，支持 id / symbol[+side] / all） |
| `GET  /api/plans` | 当前活跃计划列表 |
| `GET  /api/plans/:id` | 单个计划详情 |
| `DELETE /api/plans/:id` | 取消计划 |
| `GET  /api/klines?symbol=BTCUSDT&limit=300` | 1H K线历史 |
| `GET  /api/mark?symbol=BTCUSDT` | 当前缓存的标记价 |
| `GET  /api/trades?limit=200` | 已结束交易盈亏记录 |
| `GET  /api/events` | **SSE 总线**：`hello` / `mark` / `kline` / `plan:new` / `plan:trigger` / `plan:closed` |

---

## 前端

- 顶栏：连接状态 / 当前选中计划 / 实时标记价 / 静音按钮 / 试听音效
- 主图：1H K 线 + 5 条价位线（Entry/TP1/TP2/TP3/SL），带价格标签和百分比、RR
- 左上角徽章：方向（多/空）+ 状态徽标 + 价位 & 间隔 % + RR1/RR2/RR3 + 实时盈亏%
- 右侧：活跃计划 / 事件流 / 已完成盈亏记录
- 触发瞬间：对应价位线高亮、屏幕短闪、播放对应音效（入场 / 止盈三连 / 止损低沉 / 保本提示）

---

## Telegram

- 创建 Bot：与 [@BotFather](https://t.me/BotFather) 私聊，`/newbot` 取得 `TELEGRAM_BOT_TOKEN`
- 取得 chat_id：与你的 Bot 私聊任意消息，访问 `https://api.telegram.org/bot<TOKEN>/getUpdates`，从返回里读 `chat.id`
- 推送消息内容包含：方向、symbol、入场价、当前 SL、间隔百分比、RR、保本提示、最终盈亏

未配置 TG 时不会报错，仅终端日志提示并跳过推送。

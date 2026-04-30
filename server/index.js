'use strict';
const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const log = require('./utils/logger');

require('./services/engine'); // 初始化引擎（恢复活跃计划）

const webhookRouter = require('./routes/webhook');
const apiRouter = require('./routes/api');

const app = express();
app.use(cors());
app.use(express.json({ limit: '128kb' }));

app.use(webhookRouter);
app.use('/api', apiRouter);

// 静态前端
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((err, req, res, _next) => {
  log.error('未捕获异常:', err);
  res.status(500).json({ ok: false, error: err.message });
});

app.listen(config.port, () => {
  log.info(`✅ 服务已启动: http://localhost:${config.port}`);
  log.info(`   Webhook: POST /webhook   (Authorization: Bearer ${config.authToken.slice(0, 4)}***)`);
  log.info(`   前端:    http://localhost:${config.port}/`);
});

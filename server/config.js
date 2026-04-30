'use strict';
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '8787', 10),
  authToken: process.env.AUTH_TOKEN || 'change-me-please',
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  binance: {
    rest: process.env.BINANCE_FUTURES_REST || 'https://fapi.binance.com',
    ws: process.env.BINANCE_FUTURES_WS || 'wss://fstream.binance.com',
  },
};

module.exports = config;

'use strict';
const axios = require('axios');
const config = require('../config');
const log = require('../utils/logger');
const { agent } = require('../utils/proxy');

async function sendMessage(text) {
  const { token, chatId } = config.telegram;
  if (!token || !chatId) {
    log.warn('Telegram 未配置，跳过推送：', text.split('\n')[0]);
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      {
        timeout: 10000,
        httpsAgent: agent || undefined,
        proxy: agent ? false : undefined,
      }
    );
    log.info('TG 推送成功');
  } catch (err) {
    log.error('TG 推送失败:', err.response?.data || err.message);
  }
}

module.exports = { sendMessage };

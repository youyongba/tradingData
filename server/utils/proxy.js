'use strict';
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxy =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  '';

let agent = null;
if (proxy) {
  agent = new HttpsProxyAgent(proxy);
  console.log(`[INFO] 已启用 HTTPS 代理: ${proxy}`);
}

module.exports = { agent, proxy };

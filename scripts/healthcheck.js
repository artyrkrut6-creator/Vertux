#!/usr/bin/env node
const fs = require('fs');
const net = require('net');

const FETCH_TIMEOUT = 5000;

function fetchWithTimeout(url, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
}

async function checkHttp(url) {
  try {
    const res = await fetchWithTimeout(url);
    const text = await res.text();
    return { ok: true, status: res.status, length: text.length, snippet: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

function checkPort(host, port, timeout = 2000) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;
    socket.setTimeout(timeout);
    socket.on('connect', () => { settled = true; socket.destroy(); resolve({ ok: true }); });
    socket.on('error', (e) => { if (!settled) { settled = true; resolve({ ok: false, error: String(e) }); } });
    socket.on('timeout', () => { if (!settled) { settled = true; resolve({ ok: false, error: 'timeout' }); } });
    socket.connect(port, host);
  });
}

(async () => {
  console.log('Healthcheck start', new Date().toISOString());
  console.log('Node', process.version);

  const checks = {};
  checks.node = { version: process.version };

  // Server diagnostics (default port 5176)
  const serverUrl = 'http://127.0.0.1:5176/api/diagnostics';
  checks.server_http = await checkHttp(serverUrl);
  checks.server_port = await checkPort('127.0.0.1', 5176);

  // MEXC public API probes
  const mexcUrls = [
    'https://api.mexc.com/api/v3/ticker/price?symbol=BTCUSDT',
    'https://www.mexc.com/open/api/v2/market/ticker?symbol=BTC_USDT'
  ];
  checks.mexc = {};
  for (const u of mexcUrls) {
    checks.mexc[u] = await checkHttp(u);
  }

  // Silicon/DeepSeek key presence
  const keyPath = 'server/siliconflow';
  checks.silicon_key_file = { path: keyPath, exists: fileExists(keyPath) };
  checks.env_silicon = { SILICON_KEY: !!process.env.SILICON_KEY };

  // last scheduled prediction file
  const predictionPaths = ['server/last_scheduled_prediction.json', 'last_scheduled_prediction.json'];
  checks.predictions = {};
  for (const p of predictionPaths) {
    if (fileExists(p)) {
      try {
        const txt = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(txt);
        checks.predictions[p] = { ok: true, keys: Object.keys(parsed).slice(0, 20) };
      } catch (e) {
        checks.predictions[p] = { ok: false, error: String(e) };
      }
    } else checks.predictions[p] = { exists: false };
  }

  console.log(JSON.stringify(checks, null, 2));

  const failures = [];
  if (!checks.server_http.ok) failures.push('server_http');
  if (!checks.server_port.ok) failures.push('server_port');
  const mexcOk = Object.values(checks.mexc).some(x => x.ok === true);
  if (!mexcOk) failures.push('mexc');
  if (!checks.silicon_key_file.exists && !checks.env_silicon.SILICON_KEY) failures.push('silicon_key_missing');

  console.log('Summary:', failures.length ? 'FAIL: ' + failures.join(', ') : 'OK');
  process.exit(failures.length ? 1 : 0);
})();

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { BollingerBands } = require('technicalindicators');
const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');

process.on('unhandledRejection', (e) => console.error('[process] unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('[process] uncaughtException', e));

const PORT = Number(process.env.PORT || 5176);
const app = express();

app.use(cors({ origin: true, credentials: true }));

// IMPORTANT: keep raw body for CryptoPay webhook signature verification
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const DATA_FILE = path.join(__dirname, 'last_scheduled_prediction.json');

const PROXY_URL = process.env.PROXY_URL || null;
let agent = null;
if (PROXY_URL) {
  try {
    agent = new HttpsProxyAgent(PROXY_URL);
  } catch (_) {}
}

// ------------------- CONFIG -------------------
const MIN_PRICE_FT = 0.02;
const MIN_PRICE_AI = 0.10;

const MIN_QUOTEVOL_FT = 700_000;
const MIN_QUOTEVOL_AI = 1_000_000;

const CHUNK_SIZE = 20;

const FT_INTERVAL = 60_000;
const AI_INTERVAL = 300_000;
const LOOP_INTERVAL = 30_000;

const SIGNAL_AUTO_REMOVE_MS = 3000;
const AI_MAX_ACTIVE = 1;
const COOLDOWN_MS = 15 * 60_000;

// NEW: AI max lifetime 10 hours
const AI_MAX_LIFETIME_MS = 10 * 60 * 60_000;

const SILICON_KEY = process.env.SILICON_KEY || null;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || null;

// Crypto Bot / Crypto Pay API token
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN || process.env.CRYPTO_BOT_TOKEN || null;
// subscription price in USDT for CryptoPay invoices
const PREMIUM_PRICE_USDT = Number(process.env.PREMIUM_PRICE_USDT || 10);

const WEBAPP_URL = process.env.WEBAPP_URL || 'https://vortex-ai-nffc.onrender.com';
const MONGO_URI = process.env.MONGO_URI || null;

const MANAGER_USERNAME = process.env.MANAGER_USERNAME || 'meanfive1';
const ADMIN_ID = Number(process.env.ADMIN_ID || 8270078362);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@VortexAiOff';
const CHANNEL_URL = `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`;

// ------------------- STATE -------------------
let scanInFlight = false;

let nextFtScan = Date.now() + FT_INTERVAL;
let nextAiScan = Date.now() + AI_INTERVAL;

const activeSignals = new Map();
let lastFtPicks = [];

const cooldowns = new Map(); // symbol -> cooldownUntil
const sseClients = new Set();
const pendingVerifications = new Map();

// timers to remove signals “almost instantly”
const removalTimers = new Map(); // symbol -> timeoutId

// ------------------- HELPERS -------------------
function normalizeSymbol(s) {
  return String(s || '').trim().toUpperCase();
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function sseBroadcast(evt, data) {
  const payload = `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((c) => {
    try {
      c.write(payload);
    } catch (_) {}
  });
}

function isSaneUsdtSymbol(sym) {
  return /^[A-Z0-9]{2,}USDT$/.test(sym);
}
function isStablecoinLike(sym) {
  return /USDC|USDP|TUSD|DAI|FDUSD|USD1|USDE|PAXG|EUR|GBP/.test(sym);
}
function isLeveraged(sym) {
  return /(3L|3S|5L|5S|UP|DOWN|BULL|BEAR)USDT$/.test(sym);
}
function isTokenizedStock(sym) {
  return /ONUSDT$/.test(sym);
}

function isInCooldown(symbol) {
  const sym = normalizeSymbol(symbol);
  const until = cooldowns.get(sym);
  if (!until) return false;
  if (Date.now() >= until) {
    cooldowns.delete(sym);
    return false;
  }
  return true;
}

function putCooldown(symbol) {
  cooldowns.set(normalizeSymbol(symbol), Date.now() + COOLDOWN_MS);
}

function cleanupCooldowns() {
  const now = Date.now();
  for (const [sym, until] of cooldowns.entries()) {
    if (now >= until) cooldowns.delete(sym);
  }
}

function countActiveAiActiveOnly() {
  let n = 0;
  for (const s of activeSignals.values()) {
    if (s?.tag === 'AI' && String(s.status || '').toUpperCase() === 'ACTIVE') n++;
  }
  return n;
}

function scheduleRemoval(symbol) {
  const sym = normalizeSymbol(symbol);
  const sig = activeSignals.get(sym);
  if (!sig?.removeAt) return;

  // clear old timer
  const old = removalTimers.get(sym);
  if (old) clearTimeout(old);

  const delay = Math.max(0, sig.removeAt - Date.now()) + 50;
  const t = setTimeout(() => {
    const s = activeSignals.get(sym);
    if (s && s.removeAt && Date.now() >= s.removeAt) {
      activeSignals.delete(sym);
      persistAndBroadcast(buildPayload());
    }
    removalTimers.delete(sym);
  }, delay);

  removalTimers.set(sym, t);
}

async function mexcFetchJSON(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = agent
      ? await fetch(url, { agent, signal: controller.signal })
      : await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return null;
    return res.json();
  } catch (_) {
    clearTimeout(id);
    return null;
  }
}

async function fetch24hrTickers() {
  return mexcFetchJSON('https://api.mexc.com/api/v3/ticker/24hr');
}

async function fetchMexcKlines(symbol, interval = '1m', limit = 50) {
  const url = `https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const data = await mexcFetchJSON(url);
  return Array.isArray(data) ? data : [];
}

async function fetchMexcDepth(symbol, limit = 20) {
  const url = `https://api.mexc.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
  return mexcFetchJSON(url);
}

function relStdDevPct(closes) {
  if (!closes.length) return 999;
  const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
  if (!mean) return 999;
  const variance = closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / closes.length;
  return (Math.sqrt(variance) / mean) * 100;
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0,
    losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function stripJsonFences(s) {
  if (!s) return '';
  let out = String(s).trim();
  if (out.includes('```')) {
    const parts = out.split('```');
    let best = out;
    for (const p of parts) {
      const t = p.trim();
      if (t.startsWith('{') && t.endsWith('}')) best = t;
    }
    out = best;
  }
  return out.trim();
}

function validateAiOutput(obj, lastClose) {
  const tp = safeNum(obj?.target_price);
  const sl = safeNum(obj?.stop_loss_price);
  const dir = String(obj?.direction || '').toUpperCase();
  const conf = safeNum(obj?.confidence);

  if (!tp || !sl) return null;
  if (dir !== 'LONG' && dir !== 'SHORT') return null;

  const tpMove = Math.abs(tp / lastClose - 1);
  const slMove = Math.abs(sl / lastClose - 1);
  if (tpMove > 0.08 || slMove > 0.08) return null;

  if (dir === 'LONG') {
    if (!(tp > lastClose && sl < lastClose)) return null;
  } else {
    if (!(tp < lastClose && sl > lastClose)) return null;
  }

  return {
    target_price: tp,
    stop_loss_price: sl,
    direction: dir,
    confidence: clamp(conf ?? 70, 0, 100),
    forecast_1m: Array.isArray(obj?.forecast_1m) ? obj.forecast_1m : [],
  };
}

// ------------------- IDEAL SCANNER: anomaly scoring -------------------
function bollingerSqueezeScore(closes) {
  if (closes.length < 20) return 0;
  const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  const last = bb[bb.length - 1];
  if (!last) return 0;
  const width = (last.upper - last.lower) / (last.middle || 1);
  if (width <= 0) return 0;
  return clamp((0.03 - width) / 0.03, 0, 1);
}

function momentumScore(closes) {
  if (closes.length < 10) return 0;
  const c0 = closes[0];
  const c9 = closes[closes.length - 1];
  if (!c0) return 0;
  const move = Math.abs(c9 / c0 - 1);
  return clamp(move / 0.03, 0, 1);
}

function volumeSpikeScore(volumes) {
  if (volumes.length < 10) return 0;
  const last = volumes[volumes.length - 1];
  const avg = volumes.slice(0, -1).reduce((s, v) => s + v, 0) / (volumes.length - 1);
  if (!avg) return 0;
  const spike = last / avg;
  return clamp((spike - 1) / 3, 0, 1);
}

function rsiExtremesScore(rsi) {
  if (!Number.isFinite(rsi)) return 0;
  const oversold = clamp((35 - rsi) / 20, 0, 1);
  const overbought = clamp((rsi - 65) / 20, 0, 1);
  return Math.max(oversold, overbought);
}

function buildTop5Candidates(enriched) {
  const scored = enriched.map((x) => {
    const closes10 = x.klines15.slice(-10).map((k) => Number(k[4]));
    const vols10 = x.klines15.slice(-10).map((k) => Number(k[5]));

    const score =
      0.30 * volumeSpikeScore(vols10) +
      0.25 * momentumScore(closes10) +
      0.20 * rsiExtremesScore(x.rsi) +
      0.15 * bollingerSqueezeScore(x.klines15.map((k) => Number(k[4]))) +
      0.10 * clamp((x.stdDev || 0) / 1.2, 0, 1);

    return { ...x, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ------------------- STAGE 1: DeepSeek choose winner -------------------
async function deepseekSelectWinner(top5) {
  if (!SILICON_KEY) return null;

  const system =
    'You are a Senior Quant Trader. ' +
    'Pick the SINGLE BEST asset for a 5-20 minute trade based on provided 10 candles + RSI + volume behavior. ' +
    'Return ONLY the winning symbol like "BTCUSDT". No extra text.';

  let userMsg = 'Assets:\n';
  top5.forEach((c, i) => {
    const candles = c.klines15.slice(-10).map((k) => ({
      openTime: new Date(Number(k[0])).toISOString(),
      closeTime: new Date(Number(k[6] || (Number(k[0]) + 60_000))).toISOString(),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));

    userMsg += `#${i + 1} ${c.symbol}\n`;
    userMsg += `rsi=${c.rsi.toFixed(2)} score=${Number(c.score || 0).toFixed(3)}\n`;
    userMsg += `candles_10=${JSON.stringify(candles)}\n\n`;
  });

  try {
    const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SILICON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-ai/DeepSeek-V3',
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        temperature: 0.1,
      }),
    });

    if (!r.ok) return null;
    const j = await r.json();
    const content = String(j?.choices?.[0]?.message?.content || '').toUpperCase();
    return top5.find((c) => content.includes(String(c.symbol).toUpperCase())) || null;
  } catch (_) {
    return null;
  }
}

// ------------------- STAGE 2: DeepSeek execution -------------------
async function deepseekExecution(winner) {
  if (!SILICON_KEY) return null;

  const klines = await fetchMexcKlines(winner.symbol, '1m', 50);
  if (!klines || klines.length < 20) return null;

  const closes = klines.map((k) => Number(k[4]));
  const lastClose = closes[closes.length - 1];
  const rsi = calculateRSI(closes.slice(-40), 14);

  const candles20 = klines.slice(-20).map((k) => ({
    openTime: new Date(Number(k[0])).toISOString(),
    closeTime: new Date(Number(k[6] || (Number(k[0]) + 60_000))).toISOString(),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));

  const depth = await fetchMexcDepth(winner.symbol, 20);
  const orderBook = {
    bidsTop: depth?.bids?.slice(0, 10) || [],
    asksTop: depth?.asks?.slice(0, 10) || [],
  };

  const system =
    'You are Vortex AI. Return ONLY valid JSON object. No markdown. ' +
    'Schema: {"target_price":number,"stop_loss_price":number,"direction":"LONG"|"SHORT","confidence":0-100,"forecast_1m":[{"close":number}]} ' +
    'Constraints: prediction must resolve within 5-20 minutes. Keep TP/SL within 1%..3% from lastClose. ' +
    'LONG => target_price > lastClose and stop_loss_price < lastClose. ' +
    'SHORT => target_price < lastClose and stop_loss_price > lastClose. ' +
    'forecast_1m must contain exactly 5 items and move smoothly toward target.';

  const user =
    `Symbol: ${winner.symbol}\n` +
    `lastClose: ${lastClose}\n` +
    `rsi: ${rsi.toFixed(2)}\n` +
    `orderBookTop: ${JSON.stringify(orderBook)}\n` +
    `candles_1m_last20: ${JSON.stringify(candles20)}\n` +
    `Return JSON now.`;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 25_000);

  try {
    const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SILICON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-ai/DeepSeek-V3',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(id);
    if (!r.ok) return null;

    const j = await r.json();
    let content = stripJsonFences(j?.choices?.[0]?.message?.content || '{}');

    let parsed = null;
    try { parsed = JSON.parse(content); } catch (_) { parsed = null; }

    const v = validateAiOutput(parsed, lastClose);
    if (!v) return null;

    const now = Date.now();
    const forecast = [];
    const path = v.forecast_1m.slice(0, 5);
    for (let i = 0; i < 5; i++) {
      const c = safeNum(path?.[i]?.close);
      const fallbackClose = lastClose + (v.target_price - lastClose) * ((i + 1) / 5);
      forecast.push({ t: now + (i + 1) * 60_000, close: c ?? fallbackClose });
    }

    return {
      candles: forecast,
      target_price: Number(v.target_price),
      stop_loss_price: Number(v.stop_loss_price),
      direction: v.direction,
      confidence: Number(v.confidence),
      source: 'deepseek',
    };
  } catch (_) {
    clearTimeout(id);
    return null;
  }
}

// ------------------- SIGNAL LIFECYCLE -------------------
function markSignalDone(sym, status) {
  const s = activeSignals.get(sym);
  if (!s) return;
  s.status = status;
  s.removeAt = Date.now() + SIGNAL_AUTO_REMOVE_MS;
  putCooldown(sym);
  scheduleRemoval(sym);
}

function updateSignalStatus(sig, price) {
  if (!sig || sig.status !== 'ACTIVE') return false;

  let done = false;
  if (sig.direction === 'LONG') {
    if (price >= sig.target_price) { done = true; markSignalDone(sig.symbol, 'WON'); }
    else if (price <= sig.stop_loss_price) { done = true; markSignalDone(sig.symbol, 'LOST'); }
  } else {
    if (price <= sig.target_price) { done = true; markSignalDone(sig.symbol, 'WON'); }
    else if (price >= sig.stop_loss_price) { done = true; markSignalDone(sig.symbol, 'LOST'); }
  }

  return done;
}

function expireOldSignals() {
  const now = Date.now();
  let changed = false;
  for (const [sym, sig] of activeSignals.entries()) {
    if (!sig || sig.tag !== 'AI') continue;
    if (String(sig.status || '').toUpperCase() !== 'ACTIVE') continue;

    const startedAt = Number(sig.addedAt || sig.detectedAt || 0) || now;
    if (now - startedAt >= AI_MAX_LIFETIME_MS) {
      sig.status = 'EXPIRED';
      sig.removeAt = now + SIGNAL_AUTO_REMOVE_MS;
      putCooldown(sym);
      scheduleRemoval(sym);
      changed = true;
    }
  }
  if (changed) persistAndBroadcast(buildPayload());
}

// ------------------- PERSIST / PAYLOAD -------------------
function buildPayload() {
  const finalDetected = [...Array.from(activeSignals.values()), ...lastFtPicks];

  const forecastsBySymbol = {};
  activeSignals.forEach((s) => {
    forecastsBySymbol[s.symbol] = {
      generatedAt: s.addedAt,
      horizonMinutes: 5,
      candles: s.forecastCandles || [],
      target_price: s.target_price,
      stop_loss_price: s.stop_loss_price,
      direction: s.direction,
      status: s.status,
      source: s.source || 'deepseek',
      confidence: s.confidence ?? 0,
      removeAt: s.removeAt || null,
    };
  });

  return {
    ts: new Date().toISOString(),
    nextScanAt: nextFtScan,
    nextFtScan,
    nextAiScan,
    parsed: { detected: finalDetected, forecastsBySymbol },
  };
}

function persistAndBroadcast(payload) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(payload)); } catch (_) {}
  sseBroadcast('scheduled_update', payload);
}

function loadPersistedSignals() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const latest = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const detected = latest?.parsed?.detected || [];
    const forecasts = latest?.parsed?.forecastsBySymbol || {};

    detected.forEach((d) => {
      if (d?.tag === 'AI' && d?.symbol) {
        const sym = normalizeSymbol(d.symbol);
        const f = forecasts[sym] || forecasts[d.symbol];
        activeSignals.set(sym, {
          ...d,
          symbol: sym,
          target_price: f?.target_price ?? d.target_price,
          stop_loss_price: f?.stop_loss_price ?? d.stop_loss_price,
          direction: f?.direction ?? d.direction,
          status: f?.status ?? d.status,
          forecastCandles: f?.candles ?? d.forecastCandles ?? [],
          addedAt: f?.generatedAt ?? d.addedAt ?? Date.now(),
          confidence: f?.confidence ?? d.confidence ?? 0,
          removeAt: f?.removeAt ?? d.removeAt ?? null,
        });

        // if already marked for removal => schedule
        const sig = activeSignals.get(sym);
        if (sig?.removeAt) scheduleRemoval(sym);
      }
    });

    // keep only 1 ACTIVE AI after restart
    const actives = Array.from(activeSignals.values())
      .filter((s) => s?.tag === 'AI' && String(s.status || '').toUpperCase() === 'ACTIVE')
      .sort((a, b) => Number(b.addedAt || b.detectedAt || 0) - Number(a.addedAt || a.detectedAt || 0));

    if (actives.length > AI_MAX_ACTIVE) {
      const keep = new Set(actives.slice(0, AI_MAX_ACTIVE).map((s) => normalizeSymbol(s.symbol)));
      for (const [sym, sig] of activeSignals.entries()) {
        if (sig?.tag !== 'AI') continue;
        if (String(sig.status || '').toUpperCase() === 'ACTIVE' && !keep.has(sym)) {
          sig.status = 'STALE';
          sig.removeAt = Date.now() + SIGNAL_AUTO_REMOVE_MS;
          scheduleRemoval(sym);
        }
      }
    }
  } catch (_) {}
}

// ------------------- SCANNER LOOP -------------------
async function runScannerJob() {
  if (scanInFlight) return;
  scanInFlight = true;

  try {
    const all = await fetch24hrTickers();
    if (!all) throw new Error('MEXC API Fail');

    const base = all
      .map((x) => ({
        symbol: normalizeSymbol(x.symbol),
        quoteVolume: Number(x.quoteVolume),
        lastPrice: Number(x.lastPrice),
        priceChangePercent: Number(x.priceChangePercent),
      }))
      .filter((x) => x.symbol.endsWith('USDT'))
      .filter((x) => isSaneUsdtSymbol(x.symbol))
      .filter((x) => !isStablecoinLike(x.symbol))
      .filter((x) => !isLeveraged(x.symbol))
      .filter((x) => !isTokenizedStock(x.symbol));

    const baseMap = new Map(base.map((b) => [b.symbol, b]));
    const now = Date.now();

    // update AI signals (TP/SL checks)
    for (const [sym, sig] of activeSignals.entries()) {
      const tick = baseMap.get(sym);
      if (!tick) continue;
      const price = Number(tick.lastPrice);
      sig.price = price;
      if (sig.status === 'ACTIVE') updateSignalStatus(sig, price);
    }

    cleanupCooldowns();
    expireOldSignals();

    // AI scan
    if (now >= nextAiScan) {
      nextAiScan = now + AI_INTERVAL;

      if (countActiveAiActiveOnly() < AI_MAX_ACTIVE) {
        const pool = base
          .filter((x) => x.lastPrice >= MIN_PRICE_AI)
          .filter((x) => x.quoteVolume >= MIN_QUOTEVOL_AI)
          .filter((x) => !['BTCUSDT', 'ETHUSDT'].includes(x.symbol))
          .filter((x) => !isInCooldown(x.symbol))
          .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
          .slice(0, 25);

        const enriched = [];
        for (const c of pool) {
          const kl = await fetchMexcKlines(c.symbol, '1m', 15);
          if (!kl || kl.length < 15) continue;
          const closes = kl.map((k) => Number(k[4]));
          enriched.push({
            symbol: c.symbol,
            price: c.lastPrice,
            quoteVolume: c.quoteVolume,
            priceChangePercent: c.priceChangePercent,
            klines15: kl,
            rsi: calculateRSI(closes, 14),
            stdDev: relStdDevPct(closes),
          });
        }

        const top5 = buildTop5Candidates(enriched);
        if (top5.length) {
          const winner = await deepseekSelectWinner(top5);
          if (winner && countActiveAiActiveOnly() < AI_MAX_ACTIVE) {
            const exec = await deepseekExecution(winner);
            if (exec && !isInCooldown(winner.symbol)) {
              const sym = normalizeSymbol(winner.symbol);
              activeSignals.set(sym, {
                symbol: sym,
                tag: 'AI',
                price: winner.price,
                quoteVolume: winner.quoteVolume,
                change24hPct: winner.priceChangePercent ?? 0,
                stdDev: winner.stdDev ?? 0,

                target_price: exec.target_price,
                stop_loss_price: exec.stop_loss_price,
                direction: exec.direction,
                confidence: exec.confidence ?? 0,
                forecastCandles: exec.candles || [],

                detectedAt: Date.now(),
                status: 'ACTIVE',
                addedAt: Date.now(),
                source: exec.source || 'deepseek',
              });
            }
          }
        }
      }
    }

    // FT scan (snapshot, expiresAt = nextFtScan)
    if (now >= nextFtScan) {
      nextFtScan = now + FT_INTERVAL;

      const ftPool = base
        .filter((x) => !activeSignals.has(x.symbol))
        .filter((x) => !isInCooldown(x.symbol))
        .filter((x) => x.quoteVolume >= MIN_QUOTEVOL_FT && x.lastPrice >= MIN_PRICE_FT)
        .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
        .slice(0, 60);

      const ftPicks = [];
      for (let i = 0; i < ftPool.length; i += CHUNK_SIZE) {
        const chunk = ftPool.slice(i, i + CHUNK_SIZE);
        await Promise.all(
          chunk.map(async (t) => {
            const k = await fetchMexcKlines(t.symbol, '1m', 20);
            if (!k || k.length < 15) return;

            const closes = k.map((x) => Number(x[4]));
            const rsi = calculateRSI(closes, 14);

            let signal = 'NEUTRAL';
            if (rsi < 35) signal = 'LONG';
            if (rsi > 65) signal = 'SHORT';

            ftPicks.push({
              symbol: t.symbol,
              tag: 'FT',
              price: t.lastPrice,
              quoteVolume: t.quoteVolume,
              priceChangePercent: t.priceChangePercent,
              change24hPct: t.priceChangePercent,
              rsi,
              signal,
              stdDev: relStdDevPct(closes),
              detectedAt: Date.now(),
              expiresAt: nextFtScan, // FIX: FT never "1000 hours"
            });
          })
        );
      }

      const longs = ftPicks.filter((f) => f.signal === 'LONG').slice(0, 7);
      const shorts = ftPicks.filter((f) => f.signal === 'SHORT').slice(0, 7);
      const vols = ftPicks.filter((f) => f.signal === 'NEUTRAL').slice(0, 6);

      lastFtPicks = [...longs, ...shorts, ...vols];
    }

    persistAndBroadcast(buildPayload());
  } catch (e) {
    console.error(e);
  } finally {
    scanInFlight = false;
    setTimeout(runScannerJob, LOOP_INTERVAL);
  }
}

// ------------------- DB & USER -------------------
if (MONGO_URI) {
  mongoose.connect(MONGO_URI).then(() => console.log('[DB] Connected')).catch((e) => console.error('[DB] Error', e));
}

const UserSchema = new mongoose.Schema({
  tgId: { type: String, unique: true },
  isPremium: Boolean,
  expiresAt: Number,
  language: { type: String, default: 'ru' },
  notificationsEnabled: { type: Boolean, default: true },
  firstName: String,
  username: String,
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const InvoiceSchema = new mongoose.Schema({
  invoiceId: { type: Number, unique: true },
  tgId: String,
  status: String,
  createdAt: Number,
  payUrl: String,
  asset: String,
  amount: String,
});
const Invoice = mongoose.models.Invoice || mongoose.model('Invoice', InvoiceSchema);

async function activateUser(id) {
  try {
    await User.findOneAndUpdate(
      { tgId: String(id) },
      { isPremium: true, expiresAt: Date.now() + 30 * 24 * 3600_000 },
      { upsert: true }
    );
  } catch (_) {}
}

async function checkUser(id) {
  try {
    const u = await User.findOne({ tgId: String(id) });
    return Boolean(u && u.isPremium && u.expiresAt > Date.now());
  } catch (_) {
    return false;
  }
}

async function getUserLang(tgId) {
  try {
    const u = await User.findOne({ tgId: String(tgId) });
    return u?.language === 'en' ? 'en' : 'ru';
  } catch (_) {
    return 'ru';
  }
}

// ------------------- CRYPTO PAY API -------------------
async function cryptoPayRequest(method, params = {}) {
  if (!CRYPTO_PAY_TOKEN) throw new Error('CRYPTO_PAY_TOKEN missing');

  const r = await fetch(`https://pay.crypt.bot/api/${method}`, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': CRYPTO_PAY_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  const j = await r.json().catch(() => null);
  if (!j || !j.ok) {
    const msg = j?.error?.name || j?.error || `CryptoPay ${method} failed`;
    throw new Error(msg);
  }
  return j.result;
}

async function cryptoPayCreateInvoice({ tgId }) {
  const amount = String(PREMIUM_PRICE_USDT.toFixed(2));
  const asset = 'USDT';

  const result = await cryptoPayRequest('createInvoice', {
    asset,
    amount,
    description: 'Vortex PRO (1 month)',
    // after payment button inside Crypto Bot (optional)
    paid_btn_name: 'openBot',
    paid_btn_url: WEBAPP_URL,
  });

  // result: { invoice_id, pay_url, ... }
  const invoiceId = Number(result.invoice_id);
  const payUrl = String(result.pay_url);

  await Invoice.findOneAndUpdate(
    { invoiceId },
    {
      invoiceId,
      tgId: String(tgId),
      status: 'active',
      createdAt: Date.now(),
      payUrl,
      asset,
      amount,
    },
    { upsert: true }
  );

  return { invoiceId, payUrl, asset, amount };
}

async function cryptoPayGetInvoice(invoiceId) {
  const res = await cryptoPayRequest('getInvoices', { invoice_ids: String(invoiceId) });
  const inv = res?.items?.[0];
  return inv || null;
}

// Webhook endpoint for CryptoPay (optional but recommended)
app.post('/api/crypto/webhook', async (req, res) => {
  try {
    // signature verify (if token set)
    if (CRYPTO_PAY_TOKEN) {
      const sig = req.headers['crypto-pay-api-signature'];
      if (sig) {
        const raw = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from(JSON.stringify(req.body || {}));
        const h = crypto.createHmac('sha256', CRYPTO_PAY_TOKEN).update(raw).digest('hex');
        if (String(sig) !== h) {
          return res.status(401).send('bad signature');
        }
      }
    }

    const update = req.body || {};
    // update.payload.invoice_id (usually)
    const payload = update.payload || {};
    const invoiceId = Number(payload.invoice_id || payload.invoiceId);
    const status = String(payload.status || '');

    if (invoiceId) {
      const doc = await Invoice.findOne({ invoiceId }).catch(() => null);
      if (doc && (status === 'paid' || status === 'completed')) {
        await Invoice.findOneAndUpdate({ invoiceId }, { status: 'paid' }).catch(() => {});
        await activateUser(doc.tgId);
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[crypto webhook] error', e);
    return res.json({ ok: true }); // do not retry forever
  }
});

// ------------------- TEXTS -------------------
const TEXTS = {
  ru: {
    welcome: "👋 Добро пожаловать в Vortex AI!\n\nПожалуйста, подпишитесь на наш канал, чтобы продолжить.",
    sub_check: "🔄 Проверить подписку",
    sub_error: "❌ Вы не подписаны на канал.",
    lang_select: "🌐 Выберите язык / Select Language:",
    menu: { app: "🚀 Vortex App", premium: "💎 Premium", market: "📊 Рынок", settings: "⚙️ Настройки", help: "❓ Помощь" },
    market: "🔄 Сканирую рынок...",
    premium_status: "✅ Ваш статус: PRO",
    premium_buy: "💎 **VORTEX PRO**\n\n• AI Снайпер Сигналы\n• Без задержек\n• Полный доступ\n\n**Цена:** 1000 RUB / 1 Месяц",
    pay_methods: { crypto: "💠 Крипта (USDT)", stars: "⭐️ Telegram Stars", card: "💳 Карта РФ" },
    disclaimer: "⚠️ **ЮРИДИЧЕСКИЙ ДИСКЛЕЙМЕР**\n\nТорговля — риск. Возврата нет.",
    agree_pay: "✅ Согласен, Оплатить",
    manual_pay: "💳 **Способ оплаты: Перевод на карту**\n\n👋 Напиши менеджеру по кнопке ниже.\n\nПосле оплаты нажми \"✅ Я Оплатил\" и отправь скриншот.\n\nДоступ выдаётся в течение 5 минут.",
    btn_manager: "📩 Написать Менеджеру",
    btn_paid: "✅ Я Оплатил",
    btn_back: "🔙 Назад",
    settings: "⚙️ **Настройки**",
    alerts: "🔔 Уведомления AI:",
    lang_btn: "🌐 Сменить Язык",
    profile: "👤 **ПРОФИЛЬ**",
    no_sub: "❌ Нет подписки",
    days_left: "дней",
    help: "📚 **ПОМОЩЬ**\n\n• AI Signals: входы от DeepSeek.\n• FT: RSI зоны.\n\nSupport: @meanfive1",
    app_desc: "📱 **Vortex Web App**\n\nНажмите кнопку ниже, чтобы запустить:",
    crypto_invoice: "💠 **Оплата криптой (Crypto Bot)**\n\nНажми кнопку ниже и оплати инвойс.\nПосле оплаты нажми «Проверить оплату».",
    crypto_check: "🔄 Проверить оплату",
    crypto_wait: "⏳ Оплата не найдена. Если оплатили только что — подождите 10-20 секунд и проверьте ещё раз.",
    crypto_ok: "✅ Оплата подтверждена. Premium активирован.",
  },
  en: {
    welcome: "👋 Welcome to Vortex AI!\n\nPlease subscribe to our channel to continue.",
    sub_check: "🔄 Check Subscription",
    sub_error: "❌ You are not subscribed.",
    lang_select: "🌐 Select Language:",
    menu: { app: "🚀 Vortex App", premium: "💎 Premium", market: "📊 Market", settings: "⚙️ Settings", help: "❓ Help" },
    app_desc: "📱 **Vortex Web App**\n\nClick below to launch:",
    market: "🔄 Scanning...",
    premium_status: "✅ Your Status: PRO",
    premium_buy: "💎 **VORTEX PRO**\n\n• AI Sniper Signals\n• Zero Latency\n• Full Access\n\n**Price:** $10 / 1 Month",
    pay_methods: { crypto: "💠 Crypto (USDT)", stars: "⭐️ Telegram Stars", card: "💳 Bank Card" },
    disclaimer: "⚠️ **LEGAL DISCLAIMER**\n\nTrading involves risk. No refunds.",
    agree_pay: "✅ I Agree & Pay",
    manual_pay: "💳 **Payment Method: Bank Card**\n\nContact manager below.\n\nAfter payment click «✅ I Paid» and send screenshot.\n\nAccess granted within 5 mins.",
    btn_manager: "📩 Contact Manager",
    btn_paid: "✅ I Paid",
    btn_back: "🔙 Back",
    settings: "⚙️ **Settings**",
    alerts: "🔔 AI Alerts:",
    lang_btn: "🌐 Change Language",
    profile: "👤 **PROFILE**",
    no_sub: "❌ No Subscription",
    days_left: "days",
    help: "📚 **HELP**\n\n• AI Signals: DeepSeek entries.\n• FT: RSI zones.\n\nSupport: @meanfive1",
    crypto_invoice: "💠 **Crypto payment (Crypto Bot)**\n\nTap button below to pay.\nAfter payment tap «Check payment».",
    crypto_check: "🔄 Check payment",
    crypto_wait: "⏳ Payment not found yet. If you just paid, wait 10-20 seconds and check again.",
    crypto_ok: "✅ Payment confirmed. Premium activated.",
  }
};

// ------------------- TELEGRAM BOT -------------------
async function isSubscribed(bot, userId) {
  try {
    const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
    return !['left', 'kicked'].includes(member.status);
  } catch (_) {
    // if bot can't check, do not hard block (optional)
    return false;
  }
}

if (TG_BOT_TOKEN) {
  (async () => {
    try {
      const bot = new Telegraf(TG_BOT_TOKEN);
      bot.catch((err) => console.error('[bot] runtime error:', err));

      // Polling (stable)
      try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch (_) {}

      const getMenu = (lang) => {
        const T = TEXTS[lang] || TEXTS.ru;
        return Markup.keyboard([
          [T.menu.app, T.menu.premium],
          [T.menu.market, T.menu.settings],
          [T.menu.help]
        ]).resize();
      };

      const sendSubscribeGate = async (ctx, lang) => {
        const T = TEXTS[lang] || TEXTS.ru;
        return ctx.reply(
          T.welcome,
          Markup.inlineKeyboard([
            [Markup.button.url('📢 Channel', CHANNEL_URL)],
            [Markup.button.callback(T.sub_check, 'check_sub')]
          ])
        );
      };

      const sendAppEntry = async (ctx, lang) => {
        const T = TEXTS[lang] || TEXTS.ru;
        return ctx.reply(
          T.app_desc || 'Open:',
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.webApp(T.menu.app, WEBAPP_URL)]]) }
        );
      };

      bot.command('start', async (ctx) => {
        await ctx.reply(TEXTS.ru.lang_select, Markup.inlineKeyboard([
          Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
          Markup.button.callback('🇺🇸 English', 'lang_en')
        ]));
      });

      bot.action(/^lang_(.+)$/, async (ctx) => {
        const lang = ctx.match[1] === 'en' ? 'en' : 'ru';
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage(); } catch (_) {}
        try { await User.findOneAndUpdate({ tgId: String(ctx.from.id) }, { language: lang }, { upsert: true }); } catch (_) {}

        const ok = await isSubscribed(bot, ctx.from.id);
        if (!ok) return sendSubscribeGate(ctx, lang);

        await ctx.reply('✅ OK', getMenu(lang));
        return sendAppEntry(ctx, lang);
      });

      bot.action('check_sub', async (ctx) => {
        const lang = await getUserLang(ctx.from.id);
        await ctx.answerCbQuery();

        const ok = await isSubscribed(bot, ctx.from.id);
        if (!ok) {
          try {
            await ctx.editMessageText(TEXTS[lang].sub_error, Markup.inlineKeyboard([
              [Markup.button.url('📢 Channel', CHANNEL_URL)],
              [Markup.button.callback(TEXTS[lang].sub_check, 'check_sub')]
            ]));
            return;
          } catch (_) {
            return sendSubscribeGate(ctx, lang);
          }
        }

        await ctx.reply('✅ OK', getMenu(lang));
        return sendAppEntry(ctx, lang);
      });

      // Gate all messages if not subscribed (except admin/start/lang)
      bot.use(async (ctx, next) => {
        if (!ctx.from) return next();
        if (String(ctx.from.id) === String(ADMIN_ID)) return next();

        const text = ctx.message?.text || '';
        if (text.startsWith('/start')) return next();

        // allow callbacks for language and check_sub
        if (ctx.callbackQuery?.data && /^(lang_|check_sub)/.test(ctx.callbackQuery.data)) return next();

        if (ctx.message || ctx.callbackQuery) {
          const ok = await isSubscribed(bot, ctx.from.id);
          if (!ok) {
            const lang = await getUserLang(ctx.from.id);
            await sendSubscribeGate(ctx, lang);
            return;
          }
        }
        return next();
      });

      // App
      bot.hears([/🚀 Vortex App/, /App/], async (ctx) => {
        const lang = await getUserLang(ctx.from.id);
        return sendAppEntry(ctx, lang);
      });

      // Settings
      bot.hears([/⚙️ Настройки/, /⚙️ Settings/], async (ctx) => {
        const lang = await getUserLang(ctx.from.id);
        const T = TEXTS[lang] || TEXTS.ru;
        const u = await User.findOne({ tgId: String(ctx.from.id) }).catch(() => null);
        const s = u?.notificationsEnabled ? '✅ ON' : '❌ OFF';
        return ctx.reply(`${T.settings}\n\n${T.alerts} ${s}`, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(T.lang_btn, 'change_lang')],
            [Markup.button.callback('Toggle Alerts', 'toggle_alerts')]
          ])
        });
      });

      bot.action('change_lang', async (ctx) => {
        await ctx.answerCbQuery();
        return ctx.reply(TEXTS.ru.lang_select, Markup.inlineKeyboard([
          Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
          Markup.button.callback('🇺🇸 English', 'lang_en')
        ]));
      });

      bot.action('toggle_alerts', async (ctx) => {
        await ctx.answerCbQuery();
        const u = await User.findOne({ tgId: String(ctx.from.id) }).catch(() => null);
        if (!u?.isPremium) return ctx.reply('PRO only');
        u.notificationsEnabled = !u.notificationsEnabled;
        await u.save().catch(() => {});
        return ctx.reply(u.notificationsEnabled ? 'Alerts: ON' : 'Alerts: OFF');
      });

      // Help
      bot.hears([/❓ Help/, /❓ Помощь/], async (ctx) => {
        const lang = await getUserLang(ctx.from.id);
        const T = TEXTS[lang] || TEXTS.ru;
        return ctx.reply(T.help, { parse_mode: 'Markdown' });
      });

      // Premium
      bot.hears([/💎 Premium/, /💎 Премиум/], async (ctx) => {
        const lang = await getUserLang(ctx.from.id);
        const T = TEXTS[lang] || TEXTS.ru;

        const isPro = await checkUser(ctx.from.id);
        if (isPro) return ctx.reply(T.premium_status);

        return ctx.reply(T.disclaimer, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback(T.agree_pay, 'show_pay')]])
        });
      });

      bot.action('show_pay', async (ctx) => {
        const lang = await getUserLang(ctx.from.id);
        const T = TEXTS[lang] || TEXTS.ru;
        await ctx.answerCbQuery();

        return ctx.editMessageText(T.premium_buy, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(T.pay_methods.card, 'pay_manager')],
            [Markup.button.callback(T.pay_methods.crypto, 'pay_crypto')],
            [Markup.button.callback(T.pay_methods.stars, 'pay_stars')]
          ])
        });
      });

      // Manager pay (manual)
      bot.action('pay_manager', async (ctx) => {
        const lang = await getUserLang(ctx.from.id);
        const T = TEXTS[lang] || TEXTS.ru;
        await ctx.answerCbQuery();

        const msg = lang === 'en' ? 'Hello, I want to buy Premium.' : 'Привет, нужны реквизиты для оплаты.';
        const link = `https://t.me/${MANAGER_USERNAME}?text=${encodeURIComponent(msg)}`;

        return ctx.editMessageText(T.manual_pay, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.url(T.btn_manager, link)],
            [Markup.button.callback(T.btn_paid, 'paid_manual')],
            [Markup.button.callback(T.btn_back, 'show_pay')]
          ])
        });
      });

      bot.action('paid_manual', async (ctx) => {
        await ctx.answerCbQuery();
        pendingVerifications.set(ctx.from.id, true);
        return ctx.reply('📸 Отправь скрин оплаты / Send screenshot.');
      });

      bot.on('photo', async (ctx) => {
        if (!pendingVerifications.get(ctx.from.id)) return;
        pendingVerifications.delete(ctx.from.id);

        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        await ctx.reply('OK. Sent to admin.');

        try {
          await bot.telegram.sendPhoto(ADMIN_ID, fileId, {
            caption: `Payment from ${ctx.from.first_name || ''} (ID: ${ctx.from.id})`,
            ...Markup.inlineKeyboard([
              Markup.button.callback('Approve', `approve_${ctx.from.id}`),
              Markup.button.callback('Reject', `reject_${ctx.from.id}`)
            ])
          });
        } catch (e) {
          console.error('[bot] sendPhoto to admin failed', e?.message || e);
        }
      });

      bot.action(/^approve_(\d+)$/, async (ctx) => {
        if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.answerCbQuery('Unauthorized');
        const userId = ctx.match[1];
        await activateUser(userId);
        try { await bot.telegram.sendMessage(userId, 'Premium activated.'); } catch (_) {}
        await ctx.answerCbQuery('OK');
        try { await ctx.editMessageCaption((ctx.callbackQuery.message.caption || '') + '\n\nApproved'); } catch (_) {}
      });

      bot.action(/^reject_(\d+)$/, async (ctx) => {
        if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.answerCbQuery('Unauthorized');
        const userId = ctx.match[1];
        try { await bot.telegram.sendMessage(userId, 'Payment rejected.'); } catch (_) {}
        await ctx.answerCbQuery('OK');
        try { await ctx.editMessageCaption((ctx.callbackQuery.message.caption || '') + '\n\nRejected'); } catch (_) {}
      });

      // Crypto payment (Crypto Bot invoice)
      bot.action('pay_crypto', async (ctx) => {
        const lang = await getUserLang(ctx.from.id);
        const T = TEXTS[lang] || TEXTS.ru;
        await ctx.answerCbQuery();

        if (!CRYPTO_PAY_TOKEN) {
          return ctx.reply('Crypto pay is not configured on server.');
        }

        try {
          const { invoiceId, payUrl, asset, amount } = await cryptoPayCreateInvoice({ tgId: ctx.from.id });

          return ctx.editMessageText(
            `${T.crypto_invoice}\n\nInvoice: ${invoiceId}\nAmount: ${amount} ${asset}`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.url('💠 Pay via Crypto Bot', payUrl)],
                [Markup.button.callback(T.crypto_check, `check_invoice_${invoiceId}`)],
                [Markup.button.callback(T.btn_back, 'show_pay')],
              ]),
            }
          );
        } catch (e) {
          return ctx.reply('Failed to create crypto invoice: ' + (e?.message || String(e)));
        }
      });

      bot.action(/^check_invoice_(\d+)$/, async (ctx) => {
        const invoiceId = Number(ctx.match[1]);
        const lang = await getUserLang(ctx.from.id);
        const T = TEXTS[lang] || TEXTS.ru;
        await ctx.answerCbQuery();

        if (!CRYPTO_PAY_TOKEN) return ctx.reply('Crypto pay is not configured.');

        try {
          const inv = await cryptoPayGetInvoice(invoiceId);
          const status = String(inv?.status || '').toLowerCase();

          if (status === 'paid') {
            await activateUser(ctx.from.id);
            await Invoice.findOneAndUpdate({ invoiceId }, { status: 'paid' }).catch(() => {});
            return ctx.reply(T.crypto_ok);
          }

          return ctx.reply(T.crypto_wait + `\nStatus: ${status || 'unknown'}`);
        } catch (e) {
          return ctx.reply('Check failed: ' + (e?.message || String(e)));
        }
      });

      bot.action('pay_stars', async (ctx) => {
        await ctx.answerCbQuery('Stars not configured');
      });

      // Market (без синтаксических ошибок)
      bot.hears(/📊 Market|📊 Рынок/, async (ctx) => {
        const lang = await getUserLang(ctx.from.id);
        const T = TEXTS[lang] || TEXTS.ru;

        const msg = await ctx.reply(T.market);

        try {
          const all = await fetch24hrTickers();
          if (!all) throw new Error('API Fail');

          const btc = all.find(x => x.symbol === 'BTCUSDT');

          const gainers = all
            .filter(x => String(x.symbol).endsWith('USDT') && Number(x.quoteVolume) > 1_000_000)
            .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent))
            .slice(0, 3);

          const losers = all
            .filter(x => String(x.symbol).endsWith('USDT') && Number(x.quoteVolume) > 1_000_000)
            .sort((a, b) => Number(a.priceChangePercent) - Number(b.priceChangePercent))
            .slice(0, 3);

          let text = `<b>Market Overview</b>\n\n`;
          if (btc) text += `BTC: $${Number(btc.lastPrice).toFixed(0)} (${Number(btc.priceChangePercent).toFixed(2)}%)\n\n`;

          text += `<b>Top Gainers</b>\n`;
          gainers.forEach(c => { text += `• ${c.symbol}: +${Number(c.priceChangePercent).toFixed(1)}%\n`; });

          text += `\n<b>Top Losers</b>\n`;
          losers.forEach(c => { text += `• ${c.symbol}: ${Number(c.priceChangePercent).toFixed(1)}%\n`; });

          await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, text, { parse_mode: 'HTML' });
        } catch (_) {
          try { await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, 'Market unavailable'); } catch (_) {}
        }
      });

      // Admin force
      bot.command('force', async (ctx) => {
        if (String(ctx.from.id) !== String(ADMIN_ID)) return;
        const sym = normalizeSymbol(ctx.message.text.split(' ')[1] || 'BTCUSDT');
        const k = await fetchMexcKlines(sym, '1m', 1);
        if (!k.length) return ctx.reply('No data');
        const price = Number(k[0][4]);

        activeSignals.set(sym, {
          symbol: sym,
          tag: 'AI',
          price,
          quoteVolume: 0,
          change24hPct: 0,
          stdDev: 0,
          target_price: price * 1.005,
          stop_loss_price: price * 0.995,
          direction: 'LONG',
          confidence: 50,
          forecastCandles: [],
          detectedAt: Date.now(),
          status: 'ACTIVE',
          addedAt: Date.now(),
          source: 'manual',
        });

        persistAndBroadcast(buildPayload());
        return ctx.reply(`Forced: ${sym}`);
      });

      await bot.launch({ dropPendingUpdates: true });
      console.log('[bot] started (polling)');
    } catch (e) {
      console.error('[bot] failed to start:', e?.message || e);
    }
  })();
} else {
  console.log('[bot] TG_BOT_TOKEN missing, bot disabled');
}

// ------------------- WEBAPP API -------------------
app.get('/api/user/status', async (req, res) => {
  const id = req.query.tg_id;
  const hasAccess = await checkUser(id);
  res.json({ isPremium: hasAccess });
});

app.get('/api/user/reset', async (req, res) => {
  try {
    const id = req.query.tg_id;
    if (!id) return res.json({ ok: false, error: 'tg_id required' });
    await User.findOneAndUpdate({ tgId: String(id) }, { isPremium: false, expiresAt: 0 }, { upsert: true });
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/api/scheduler/latest', (req, res) => {
  try {
    if (fs.existsSync(DATA_FILE)) return res.json(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (_) {}
  res.json({});
});

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  sseClients.add(res);

  if (fs.existsSync(DATA_FILE)) {
    res.write(`event: scheduled_update\ndata: ${fs.readFileSync(DATA_FILE, 'utf8')}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/api/live/candles', async (req, res) => {
  const symbol = normalizeSymbol(req.query.symbol || 'BTCUSDT');
  const limit = Number(req.query.limit || 100);
  const kl = await fetchMexcKlines(symbol, '1m', limit);
  res.json(kl.map(k => ({
    time: Number(k[0]) / 1000,
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
  })));
});

app.get('/api/live/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const sym = normalizeSymbol(req.query.symbol || 'BTCUSDT');
  const iv = setInterval(async () => {
    const kl = await fetchMexcKlines(sym, '1m', 1);
    if (kl.length) {
      res.write(`event: candle_update\ndata: ${JSON.stringify({
        time: Number(kl[0][0]) / 1000,
        open: Number(kl[0][1]),
        high: Number(kl[0][2]),
        low: Number(kl[0][3]),
        close: Number(kl[0][4]),
      })}\n\n`);
    }
  }, 2000);

  req.on('close', () => clearInterval(iv));
});

// ------------------- FRONTEND SERVE -------------------
app.use(express.static(path.join(__dirname, '../dist')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/events')) return;
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// ------------------- START -------------------
app.listen(PORT, () => {
  try { loadPersistedSignals(); } catch (_) {}
  console.log(`🚀 Server on ${PORT}`);

  // expire old signals every minute even if scanner fails
  setInterval(expireOldSignals, 60_000);

  runScannerJob();
});
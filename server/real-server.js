require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { BollingerBands } = require('technicalindicators');
const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');

// ------------------- PROCESS SAFETY -------------------
process.on('unhandledRejection', (err) => console.error('[process] unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('[process] uncaughtException:', err));

const PORT = Number(process.env.PORT || 5176);
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

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
const AI_INTERVAL = 300_000; // 5 min
const LOOP_INTERVAL = 30_000; // main loop tick

const SIGNAL_AUTO_REMOVE_MS = 3000;

// MAX ACTIVE AI signals (fix: not AI=3)
const AI_MAX_ACTIVE = 1;

// cooldown to prevent "AI coin comes back as FT"
const COOLDOWN_MS = 15 * 60_000;

const SILICON_KEY = process.env.SILICON_KEY || null;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || null;

const WEBAPP_URL = process.env.WEBAPP_URL || 'https://vortex-ai-nffc.onrender.com';
const MONGO_URI = process.env.MONGO_URI || null;

const MANAGER_USERNAME = process.env.MANAGER_USERNAME || 'meanfive1';
const ADMIN_ID = Number(process.env.ADMIN_ID || 8270078362);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@VortexAiOff';

// Render gives this automatically. If present - webhook mode is best.
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || null;

// ------------------- STATE -------------------
let scanInFlight = false;

// initialize timers in future
let nextFtScan = Date.now() + FT_INTERVAL;
let nextAiScan = Date.now() + AI_INTERVAL;

const activeSignals = new Map(); // persistent AI
let lastFtPicks = []; // snapshot FT list

const cooldowns = new Map(); // symbol -> cooldownUntil
const sseClients = new Set();

// Bot instance (for webhook route)
let bot = null;

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
  let gains = 0, losses = 0;

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

    const sSqueeze = bollingerSqueezeScore(x.klines15.map((k) => Number(k[4])));
    const sMom = momentumScore(closes10);
    const sVol = volumeSpikeScore(vols10);
    const sRsi = rsiExtremesScore(x.rsi);
    const sStd = clamp((x.stdDev || 0) / 1.2, 0, 1);

    const score =
      0.30 * sVol +
      0.25 * sMom +
      0.20 * sRsi +
      0.15 * sSqueeze +
      0.10 * sStd;

    return { ...x, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ------------------- STAGE 1: choose winner -------------------
async function deepseekSelectWinner(top5) {
  if (!SILICON_KEY) return null;

  const system =
    'You are a Senior Quant Trader. ' +
    'Pick the SINGLE BEST asset for a 5-20 minute trade based on provided 10 candles + RSI + volume behavior. ' +
    'Return ONLY the winning symbol like "BTCUSDT". No extra text.';

  let userMsg = 'Assets:\n';
  top5.forEach((c, i) => {
    const candles = c.klines15.slice(-10).map((k) => {
      const openTime = new Date(Number(k[0])).toISOString();
      const closeTime = new Date(Number(k[6] || (Number(k[0]) + 60_000))).toISOString();
      return {
        openTime,
        closeTime,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      };
    });

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

// ------------------- STAGE 2: execution TP/SL -------------------
async function deepseekExecution(winner) {
  if (!SILICON_KEY) return null;

  const klines = await fetchMexcKlines(winner.symbol, '1m', 50);
  if (!klines || klines.length < 20) return null;

  const candles20 = klines.slice(-20).map((k) => ({
    openTime: new Date(Number(k[0])).toISOString(),
    closeTime: new Date(Number(k[6] || (Number(k[0]) + 60_000))).toISOString(),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));

  const closes = klines.map((k) => Number(k[4]));
  const lastClose = closes[closes.length - 1];
  const rsi = calculateRSI(closes.slice(-40), 14);

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
    let content = j?.choices?.[0]?.message?.content || '{}';
    content = stripJsonFences(content);

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
function updateSignalStatus(sig, price) {
  if (!sig || sig.status !== 'ACTIVE') return false;

  let done = false;
  if (sig.direction === 'LONG') {
    if (price >= sig.target_price) { sig.status = 'WON'; done = true; }
    else if (price <= sig.stop_loss_price) { sig.status = 'LOST'; done = true; }
  } else if (sig.direction === 'SHORT') {
    if (price <= sig.target_price) { sig.status = 'WON'; done = true; }
    else if (price >= sig.stop_loss_price) { sig.status = 'LOST'; done = true; }
  }

  if (done) {
    sig.removeAt = Date.now() + SIGNAL_AUTO_REMOVE_MS;
    putCooldown(sig.symbol);
  }
  return done;
}

function cleanupExpiredSignals() {
  const now = Date.now();
  for (const [sym, sig] of activeSignals.entries()) {
    if (sig?.removeAt && now >= sig.removeAt) {
      activeSignals.delete(sym);
    }
  }
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
    nextScanAt: nextFtScan, // fallback
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
      }
    });

    // keep only AI_MAX_ACTIVE active
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

    // update active AI
    for (const [sym, sig] of activeSignals.entries()) {
      const tick = baseMap.get(sym);
      if (!tick) continue;
      const price = Number(tick.lastPrice);
      sig.price = price;
      if (sig.status === 'ACTIVE') updateSignalStatus(sig, price);
    }

    cleanupExpiredSignals();
    cleanupCooldowns();

    // AI scan (once per AI_INTERVAL, only if we have free slot)
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

        if (top5.length > 0) {
          console.log('🧠 AI Stage 1: selecting winner from top5...');
          const winner = await deepseekSelectWinner(top5);

          if (winner && countActiveAiActiveOnly() < AI_MAX_ACTIVE) {
            console.log('🏆 Winner chosen:', winner.symbol);
            console.log('🧠 AI Stage 2: execution...');
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

    // FT scan every minute (snapshot, expiresAt = nextFtScan)
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
              expiresAt: nextFtScan, // FIX 1000h
            });
          })
        );
      }

      const longs = ftPicks.filter((f) => f.signal === 'LONG').slice(0, 7);
      const shorts = ftPicks.filter((f) => f.signal === 'SHORT').slice(0, 7);
      const vols = ftPicks.filter((f) => f.signal === 'NEUTRAL').slice(0, 6);
      lastFtPicks = [...longs, ...shorts, ...vols];
    }

    const payload = buildPayload();
    persistAndBroadcast(payload);

    console.log(`✅ Update: AI(active)=${countActiveAiActiveOnly()}, AI(total)=${activeSignals.size}, FT=${lastFtPicks.length}`);
  } catch (e) {
    console.error(e);
  } finally {
    scanInFlight = false;
    setTimeout(runScannerJob, LOOP_INTERVAL);
  }
}

// ------------------- DB & USER -------------------
if (MONGO_URI) {
  mongoose
    .connect(MONGO_URI)
    .then(() => console.log('[DB] Connected'))
    .catch((e) => console.error('[DB] Error', e));
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

// used by front triple click
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

app.get('/api/user/status', async (req, res) => {
  const id = req.query.tg_id;
  const hasAccess = await checkUser(id);
  res.json({ isPremium: hasAccess });
});

// ------------------- TELEGRAM BOT (ROBUST) -------------------
const TEXTS = {
  ru: {
    welcome: 'Добро пожаловать в Vortex AI.\nОткройте приложение:',
    menu_app: 'Открыть приложение',
    need_sub: 'Подпишитесь на канал, чтобы пользоваться ботом.',
    check_sub: 'Проверить подписку',
  },
  en: {
    welcome: 'Welcome to Vortex AI.\nOpen the app:',
    menu_app: 'Open app',
    need_sub: 'Subscribe to the channel to use the bot.',
    check_sub: 'Check subscription',
  },
};

async function getUserLang(tgId) {
  try {
    const u = await User.findOne({ tgId: String(tgId) });
    return u?.language === 'en' ? 'en' : 'ru';
  } catch (_) {
    return 'ru';
  }
}

async function ensureSubscribed(ctx) {
  try {
    const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, ctx.from.id);
    if (['left', 'kicked'].includes(member.status)) return false;
    return true;
  } catch (_) {
    // if bot can't check, do not block hard
    return true;
  }
}

async function startTelegramBot() {
  if (!TG_BOT_TOKEN) {
    console.log('[bot] TG_BOT_TOKEN missing -> bot disabled');
    return;
  }

  bot = new Telegraf(TG_BOT_TOKEN);

  bot.catch((err) => console.error('[bot] runtime error:', err));

  // basic user upsert
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      try {
        await User.findOneAndUpdate(
          { tgId: String(ctx.from.id) },
          { firstName: ctx.from.first_name, username: ctx.from.username },
          { upsert: true }
        );
      } catch (_) {}
    }
    return next();
  });

  bot.command('start', async (ctx) => {
    const lang = await getUserLang(ctx.from.id);
    const T = TEXTS[lang];

    const ok = await ensureSubscribed(ctx);
    if (!ok) {
      return ctx.reply(
        T.need_sub,
        Markup.inlineKeyboard([
          Markup.button.url('Channel', `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`),
          Markup.button.callback(T.check_sub, 'check_sub'),
        ])
      );
    }

    await ctx.reply(
      T.welcome,
      Markup.inlineKeyboard([Markup.button.webApp(T.menu_app, WEBAPP_URL)])
    );
  });

  bot.action('check_sub', async (ctx) => {
    const ok = await ensureSubscribed(ctx);
    await ctx.answerCbQuery(ok ? 'OK' : 'Not subscribed');
    if (ok) {
      const lang = await getUserLang(ctx.from.id);
      const T = TEXTS[lang];
      await ctx.reply(T.welcome, Markup.inlineKeyboard([Markup.button.webApp(T.menu_app, WEBAPP_URL)]));
    }
  });

  bot.command('give', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /give <tg_id>');
    await activateUser(id);
    await ctx.reply(`OK: premium activated for ${id}`);
  });

  bot.command('del', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /del <tg_id>');
    await User.findOneAndUpdate({ tgId: String(id) }, { isPremium: false, expiresAt: 0 });
    await ctx.reply(`OK: premium removed for ${id}`);
  });

  // --------- START MODE: webhook on Render, polling locally ----------
  const useWebhook = Boolean(RENDER_EXTERNAL_URL);

  try {
    const me = await bot.telegram.getMe();
    console.log('[bot] getMe ok:', me.username);
  } catch (e) {
    console.error('[bot] getMe failed:', e?.response?.description || e?.message || e);
    return;
  }

  if (useWebhook) {
    const hookPath = '/tg/webhook';
    const hookUrl = `${RENDER_EXTERNAL_URL}${hookPath}`;
    try {
      await bot.telegram.setWebhook(hookUrl);
      console.log('[bot] webhook set:', hookUrl);
    } catch (e) {
      console.error('[bot] setWebhook failed:', e?.response?.description || e?.message || e);
    }

    // Express route for webhook
    app.post(hookPath, (req, res) => {
      try {
        bot.handleUpdate(req.body, res);
      } catch (e) {
        console.error('[bot] handleUpdate error:', e?.message || e);
        res.sendStatus(200);
      }
    });
  } else {
    // polling mode
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      console.log('[bot] webhook cleared (polling mode)');
    } catch (_) {}

    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log('[bot] started polling');
      process.once('SIGINT', () => bot.stop('SIGINT'));
      process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } catch (e) {
      console.error('[bot] launch failed:', e?.response?.description || e?.message || e);
    }
  }
}

// ------------------- SSE + API -------------------
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
  res.json(
    kl.map((k) => ({
      time: Number(k[0]) / 1000,
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
    }))
  );
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
      res.write(
        `event: candle_update\ndata: ${JSON.stringify({
          time: Number(kl[0][0]) / 1000,
          open: Number(kl[0][1]),
          high: Number(kl[0][2]),
          low: Number(kl[0][3]),
          close: Number(kl[0][4]),
        })}\n\n`
      );
    }
  }, 2000);

  req.on('close', () => clearInterval(iv));
});

// ------------------- FRONTEND SERVE -------------------
app.use(express.static(path.join(__dirname, '../dist')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/events') || req.path.startsWith('/tg/')) return;
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// ------------------- START -------------------
app.listen(PORT, async () => {
  try { loadPersistedSignals(); } catch (_) {}

  console.log(`🚀 Server on ${PORT}`);

  // start bot (webhook on Render, polling locally)
  try {
    await startTelegramBot();
  } catch (e) {
    console.error('[bot] startTelegramBot fatal:', e?.message || e);
  }

  // run scanner
  runScannerJob();
});
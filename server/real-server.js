require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { BullishEngulfing, BearishEngulfing, Hammer, ShootingStar, Doji, BollingerBands } = require('technicalindicators');

const PORT = Number(process.env.PORT || 5176);
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

const DATA_FILE = path.join(__dirname, 'last_scheduled_prediction.json');
const PROXY_URL = process.env.PROXY_URL || null;
let agent = null;
if (PROXY_URL) {
  try { agent = new HttpsProxyAgent(PROXY_URL); } catch (_) {}
}

// --- CONSTANTS ---
const MIN_PRICE_FT = 0.02;
const MIN_PRICE_AI = 0.10;
const MIN_QUOTEVOL_FT = 700_000;
const MIN_QUOTEVOL_AI = 2_500_000;
const MAX_SPREAD_FT_PCT = 0.50;
const MAX_SPREAD_AI_PCT = 0.20;
const DEPTH_BAND_PCT = 0.20;
const MIN_DEPTH_FT_USDT = 10_000;
const MIN_DEPTH_AI_USDT = 15_000;
const BACKTEST_KLINES = 40;
const CHUNK_SIZE = 20; 
const UI_INTERVAL = 300_000; 
const PRE_WORK_TIME = 45_000;
const SILICON_KEY = process.env.SILICON_KEY || null;

// --- STATE ---
let scanInFlight = false;
let lastRunTs = null;
let lastAiPickCount = 0;
const forecastSourceBySymbol = {};
const lastDemoteReasonCounts = { lowPriceVol:0, spreadDepth:0, stddev:0, backtestError:0, backtestThreshold:0, directionalFail:0, insufficientKlines:0, sawtooth:0 };
const activeSignals = new Map();
const sseClients = new Set();

// --- HELPERS ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function mexcFetchJSON(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 10000);
  try {
    const res = agent ? await fetch(url, { agent, signal: controller.signal }) : await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return null;
    return res.json();
  } catch (e) { return null; }
}

async function fetch24hrTickers() { 
    return mexcFetchJSON('https://api.mexc.com/api/v3/ticker/24hr'); 
}

async function fetchMexcKlines(symbol, interval='1m', limit=50) {
  const url = `https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const data = await mexcFetchJSON(url);
  return Array.isArray(data) ? data : [];
}

async function fetchMexcDepth(symbol, limit=20) {
  const url = `https://api.mexc.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
  return mexcFetchJSON(url);
}

function sseBroadcast(evt, data) { 
    sseClients.forEach(c => c.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`)); 
}

function isSaneUsdtSymbol(sym) { return /^[A-Z0-9]{2,}USDT$/.test(sym); }
function isStablecoinLike(sym) { return /USDC|USDP|TUSD|DAI|FDUSD|USD1|USDE|PAXG|EUR|GBP/.test(sym); }
function isLeveraged(sym) { return /(3L|3S|5L|5S|UP|DOWN|BULL|BEAR)USDT$/.test(sym); }
function isTokenizedStock(sym) { return /ONUSDT$/.test(sym); }

function relStdDevPct(closes) {
  if (!closes.length) return 999;
  const mean = closes.reduce((s,v)=>s+v,0)/closes.length;
  if (!mean) return 999;
  const variance = closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / closes.length;
  return (Math.sqrt(variance) / mean) * 100;
}

function calculateRSI(closes, period=14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// --- PATTERN DETECTION ---
function detectPattern(klines) {
    if (klines.length < 5) return null;
    const input = {
        open: klines.map(k=>Number(k[1])),
        high: klines.map(k=>Number(k[2])),
        low: klines.map(k=>Number(k[3])),
        close: klines.map(k=>Number(k[4])),
    };
    
    if (BullishEngulfing.hasPattern(input)) return "Bullish Engulfing";
    if (BearishEngulfing.hasPattern(input)) return "Bearish Engulfing";
    if (Hammer.hasPattern(input)) return "Hammer";
    if (ShootingStar.hasPattern(input)) return "Shooting Star";

    const bb = BollingerBands.calculate({period: 20, stdDev: 2, values: input.close});
    if (bb.length > 0) {
        const last = bb[bb.length-1];
        const width = (last.upper - last.lower) / (last.middle || 1);
        if (width < 0.015) return "Bollinger Squeeze";
    }
    return null;
}

// --- DEEPSEEK ---
async function deepseekForecast5(symbol, contextCandles, patternName) {
  if (!SILICON_KEY) return null;

  const system = `You are Vortex AI. Your goal: Find a sniper entry point on MEXC.
A technical pattern "${patternName || 'High Volatility'}" has been detected.

**TASK:**
1. Analyze 50 candles (1m).
2. Determine direction (LONG/SHORT) based on Market Structure (Higher Highs/Lower Lows).
3. Calculate TARGET PRICE (Nearest support/resistance in 5 mins).
4. Calculate STOP LOSS.

**JSON OUTPUT FORMAT:**
{
  "target_price": <number>,
  "stop_loss_price": <number>,
  "direction": "LONG" | "SHORT",
  "confidence": <number 0-100>,
  "reasoning": "string",
  "forecast_1m": [ ...5 candles... ]
}`;

  const user = `Symbol: ${symbol}. Last close: ${contextCandles[contextCandles.length-1].close}. Recent 30m closes: ${contextCandles.map(c=>c.close).join(',')}. Predict now.`;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 25000); 

  try {
    const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${SILICON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-ai/DeepSeek-V3', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.1, response_format: { type: 'json_object' } }),
      signal: controller.signal
    });
    clearTimeout(id);
    if (!r.ok) return null;

    const j = await r.json();
    let content = j?.choices?.[0]?.message?.content || '{}';
    if (content.includes('```json')) content = content.split('```json')[1].split('```')[0].trim();
    const parsed = JSON.parse(content);
    if (!parsed.target_price) return null;

    const now = Date.now();
    return {
        candles: parsed.forecast_1m.map((c, i) => ({ t: now + (i+1)*60000, close: Number(c.close) })),
        target_price: Number(parsed.target_price),
        stop_loss_price: Number(parsed.stop_loss_price),
        direction: parsed.direction,
        confidence: Number(parsed.confidence),
        source: 'deepseek'
    };
  } catch (e) { return null; }
}

// --- ADAPTIVE PICKER ---
async function pickAiWithAdaptiveGates(aiPool) {
  const adaptiveSteps = [{ gates: { maxSpreadPct: 0.25, minDepth: 15_000, stddevMax: 0.20 } }];
  const accepted = [];
  const pool = aiPool.slice().sort((a,b) => b.quoteVolume - a.quoteVolume).slice(0, 10);
  const blacklist = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'USDCUSDT', 'FDUSDUSDT'];

  for (const step of adaptiveSteps) {
    const candidatesToCheck = [];
    for (const t of pool) {
        if (blacklist.includes(t.symbol)) continue; 
        if (t.quoteVolume < MIN_QUOTEVOL_AI) continue;
        candidatesToCheck.push(t);
    }

    const results = await Promise.all(candidatesToCheck.slice(0, 5).map(async (candidate) => {
        try {
            const kl = await fetchMexcKlines(candidate.symbol, '1m', 35);
            if (kl.length < 35) return null;
            
            // PATTERN DETECTION
            const pattern = detectPattern(kl);
            if (!pattern) return null; // No pattern -> No AI

            const ctx = kl.map(k=>({close:Number(k[4])}));
            const ds = await deepseekForecast5(candidate.symbol, ctx, pattern);
            if (!ds || ds.confidence < 75) return null;

            return { ...candidate, ...ds };
        } catch (e) { return null; }
    }));

    results.filter(r => r).forEach(v => accepted.push(v));
    if (accepted.length >= 1) break; 
  }
  return accepted.slice(0, 2);
}

function loadPersistedSignals() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const latest = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (latest.parsed?.detected || []).forEach(d => {
        if (d.tag === 'AI' && d.symbol) {
             const f = latest.parsed?.forecastsBySymbol?.[d.symbol];
             if (f) activeSignals.set(d.symbol, { ...d, ...f, forecastCandles: f.candles });
        }
    });
  } catch (e) {}
}

// --- SIMPLE USERS DB (JSON) ---
const USERS_FILE = path.join(__dirname, 'users.json');
function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) { return []; }
}
function writeUsers(list) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2)); } catch (e) {}
}
function getUser(tgId) {
  const list = readUsers();
  return list.find(u => Number(u.id) === Number(tgId));
}
function setUserPremium(tgId, isPremium, expireDate = null) {
  const list = readUsers();
  let u = list.find(x => Number(x.id) === Number(tgId));
  if (!u) { u = { id: Number(tgId), isPremium: !!isPremium, expireDate: expireDate }; list.push(u); }
  else { u.isPremium = !!isPremium; u.expireDate = expireDate; }
  writeUsers(list);
  return u;
}

// --- TELEGRAM BOT (Telegraf) ---
try {
  const TG_TOKEN = process.env.TG_BOT_TOKEN;
  if (TG_TOKEN) {
    let Telegraf; let Markup;
    try { ({ Telegraf, Markup } = require('telegraf')); } catch (e) { console.warn('[TG] telegraf not installed'); }
    if (Telegraf) {
      const bot = new Telegraf(TG_TOKEN);
      const WEBAPP_URL = process.env.WEBAPP_URL || 'https://t.me';

      bot.start(async (ctx) => {
        const uid = ctx.from && ctx.from.id;
        if (uid) setUserPremium(uid, false, null);
        try {
          await ctx.reply('Welcome to Vortex AI! Use the buttons below to open the WebApp or buy PRO.', Markup.inlineKeyboard([
            Markup.button.webApp('🚀 Launch Vortex AI', WEBAPP_URL),
            Markup.button.callback('💎 Buy PRO', 'buy')
          ]));
        } catch (e) {
          try { await ctx.reply('Welcome to Vortex AI! Send /buy to purchase PRO.'); } catch(_){}
        }
      });

      bot.command('buy', async (ctx) => {
        try {
          await ctx.reply('Price: 1000 RUB. You can pay via Crypto or Card. After payment click ✅ I Paid.', Markup.inlineKeyboard([Markup.button.callback('✅ I Paid', 'paid')]));
        } catch (e) { try { await ctx.reply('Price: 1000 RUB. Send /paid after payment.'); } catch(_){} }
      });

      bot.action('buy', async (ctx) => { try { await ctx.answerCbQuery(); await ctx.reply('Price: 1000 RUB. Click ✅ I Paid when done.', Markup.inlineKeyboard([Markup.button.callback('✅ I Paid', 'paid')])); } catch(_){} });

      bot.action('paid', async (ctx) => {
        try {
          const uid = ctx.from && ctx.from.id;
          if (uid) {
            setUserPremium(uid, true, Date.now() + 365*24*3600*1000);
            await ctx.reply('Thank you! Your account has been activated as Premium for testing purposes.');
          }
        } catch (e) {}
      });

      bot.command('activate', async (ctx) => {
        try {
          const parts = (ctx.message && ctx.message.text || '').split(/\s+/);
          if (parts.length < 2) return ctx.reply('Usage: /activate <tg_id>');
          const id = Number(parts[1]);
          setUserPremium(id, true, Date.now() + 365*24*3600*1000);
          return ctx.reply(`Activated ${id}`);
        } catch (e) { return; }
      });

      bot.launch().then(() => console.log('[TG] Bot started')).catch((e) => console.warn('[TG] Bot launch failed', e));
    }
  }
} catch (e) { console.warn('[TG] Bot init error', e); }

// --- SIMPLE API: user status ---
app.get('/api/user/status', (req, res) => {
  try {
    const id = Number(req.query.tg_id || req.query.id);
    if (!id) return res.json({ isPremium: false });
    const u = getUser(id);
    const ok = !!(u && u.isPremium && (!u.expireDate || Number(u.expireDate) > Date.now()));
    return res.json({ isPremium: ok });
  } catch (e) { return res.json({ isPremium: false }); }
});

async function runScannerJob() {
  if (scanInFlight) return;
  scanInFlight = true;
  console.log('\n🔍 Running Elite Scanner Job...');

  try {
    console.log('Fetching tickers...');
    const all = await fetch24hrTickers();
    console.log('Tickers fetched:', Array.isArray(all) ? all.length : (all === null ? 'null' : typeof all));
    if (!all) throw new Error("MEXC API Fail");

    const base = all.map(x => ({ symbol: x.symbol, quoteVolume: Number(x.quoteVolume), lastPrice: Number(x.lastPrice), priceChangePercent: Number(x.priceChangePercent) }))
        .filter(x => x.symbol.endsWith('USDT') && isSaneUsdtSymbol(x.symbol) && !isStablecoinLike(x.symbol) && !isLeveraged(x.symbol));

    // Update Signals
    const baseMap = new Map(base.map(b => [b.symbol, b]));
    const toRemove = [];
    for (const [sym, sig] of Array.from(activeSignals.entries())) {
      const tick = baseMap.get(sym);
      if (!tick) continue;
      const price = Number(tick.lastPrice);
      if (sig.status === 'ACTIVE') {
        if ((sig.direction==='LONG' && price >= sig.target_price) || (sig.direction==='SHORT' && price <= sig.target_price)) {
            sig.status = 'WON'; sig.removeAt = Date.now()+60000; toRemove.push(sym);
        } else if ((sig.direction==='LONG' && price <= sig.stop_loss_price) || (sig.direction==='SHORT' && price >= sig.stop_loss_price)) {
            sig.status = 'LOST'; sig.removeAt = Date.now()+60000; toRemove.push(sym);
        }
        sig.price = price;
      }
    }
    toRemove.forEach(s => activeSignals.delete(s));

    // Pick New AI
    if (activeSignals.size < 5) {
        const aiPool = base.filter(x => x.quoteVolume > MIN_QUOTEVOL_AI);
        const newPicks = await pickAiWithAdaptiveGates(aiPool);
        newPicks.forEach(p => {
            if (!activeSignals.has(p.symbol)) activeSignals.set(p.symbol, { ...p, tag: 'AI', detectedAt: Date.now(), status: 'ACTIVE', addedAt: Date.now() });
        });
    }

    // Pick FT
    const ftPicks = [];
    const ftCandidates = base.filter(x => x.quoteVolume >= MIN_QUOTEVOL_FT && x.lastPrice >= MIN_PRICE_FT && !activeSignals.has(x.symbol))
        .sort((a,b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent)).slice(0, 60);

    for (let i=0; i<ftCandidates.length; i+=CHUNK_SIZE) {
        const chunk = ftCandidates.slice(i, i+CHUNK_SIZE);
        await Promise.all(chunk.map(async (t) => {
            const k = await fetchMexcKlines(t.symbol, '1m', 20);
            if(k.length < 15) return;
            const rsi = calculateRSI(k.map(x=>Number(x[4])), 14);
            let signal = 'NEUTRAL'; if (rsi < 35) signal = 'LONG'; if (rsi > 65) signal = 'SHORT';
            ftPicks.push({ ...t, rsi, signal, tag: 'FT', stdDev: relStdDevPct(k.map(x=>Number(x[4]))) });
        }));
    }

    // Save & Broadcast
    const finalDetected = [...Array.from(activeSignals.values())];
    const forecasts = {};
    activeSignals.forEach(s => {
        forecasts[s.symbol] = {
            generatedAt: s.addedAt, horizonMinutes: 5, candles: s.forecastCandles,
            target_price: s.target_price, stop_loss_price: s.stop_loss_price, direction: s.direction, status: s.status, source: 'deepseek'
        };
    });

    const longs = ftPicks.filter(f => f.signal === 'LONG').slice(0,7);
    const shorts = ftPicks.filter(f => f.signal === 'SHORT').slice(0,7);
    const vols = ftPicks.filter(f => f.signal === 'NEUTRAL').slice(0,6);
    [...longs, ...shorts, ...vols].forEach(ft => finalDetected.push({
        symbol: ft.symbol, tag: 'FT', price: ft.lastPrice, stdDev: ft.stdDev, quoteVolume: ft.quoteVolume,
        change24hPct: ft.priceChangePercent, detectedAt: Date.now(), expiresAt: Date.now()+600000, signal: ft.signal, rsi: ft.rsi
    }));

    console.log(`✅ Final: AI=${activeSignals.size}, FT=${finalDetected.length - activeSignals.size}`);

    const payload = { ts: new Date().toISOString(), nextScanAt: Date.now() + UI_INTERVAL, parsed: { detected: finalDetected, forecastsBySymbol: forecasts } };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload));
    sseBroadcast('scheduled_update', payload);

    setTimeout(runScannerJob, Math.max(0, UI_INTERVAL - PRE_WORK_TIME));

  } catch (e) { console.error(e); setTimeout(runScannerJob, 60000); } 
  finally { scanInFlight = false; }
}

// --- SERVER START ---
app.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  sseClients.add(res);
  if (fs.existsSync(DATA_FILE)) res.write(`event: scheduled_update\ndata: ${fs.readFileSync(DATA_FILE, 'utf8')}\n\n`);
});
app.get('/api/live/candles', async (req, res) => {
    const kl = await fetchMexcKlines(req.query.symbol || 'BTCUSDT', '1m', req.query.limit || 100);
    res.json(kl.map(k=>({time:Number(k[0])/1000,open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4])})));
});
app.get('/api/live/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const sym = req.query.symbol || 'BTCUSDT';
    const iv = setInterval(async () => {
        const kl = await fetchMexcKlines(sym, '1m', 1);
        if (kl.length) res.write(`event: candle_update\ndata: ${JSON.stringify({time:Number(kl[0][0])/1000,open:Number(kl[0][1]),high:Number(kl[0][2]),low:Number(kl[0][3]),close:Number(kl[0][4])})}\n\n`);
    }, 2000);
    req.on('close', () => clearInterval(iv));
});
app.get('/api/scheduler/latest', (req, res) => {
    if (fs.existsSync(DATA_FILE)) res.json(JSON.parse(fs.readFileSync(DATA_FILE))); else res.json({});
});
// Раздача фронтенда
app.use(express.static(path.join(__dirname, '../dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});
app.listen(PORT, () => { try { loadPersistedSignals(); } catch(e){} console.log(`🚀 Server on ${PORT}`); runScannerJob(); });
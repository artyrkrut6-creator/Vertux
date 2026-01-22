require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { BullishEngulfing, BearishEngulfing, Hammer, ShootingStar, Doji, BollingerBands } = require('technicalindicators');
const mongoose = require('mongoose');
const { Telegraf, Markup } = require('telegraf');

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

// ------------------- CONSTANTS -------------------
const MIN_PRICE_FT = 0.02;
const MIN_PRICE_AI = 0.10;

const MIN_QUOTEVOL_FT = 700_000;
const MIN_QUOTEVOL_AI = 1_200_000;

const CHUNK_SIZE = 20;

// Тайминги
const FT_INTERVAL = 60_000;     // FT скан раз в минуту
const AI_INTERVAL = 300_000;    // AI скан раз в 5 минут
const SIGNAL_AUTO_REMOVE_MS = 3000; // Удаление через 3 сек
const COOLDOWN_MS = 15 * 60_000;    // Монета не возвращается 15 минут после AI

const SILICON_KEY = process.env.SILICON_KEY || null;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || null;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://vortex-ai-nffc.onrender.com';
const MONGO_URI = process.env.MONGO_URI || null;

const MANAGER_USERNAME = 'meanfive1';
const ADMIN_ID = 8270078362;
const CHANNEL_USERNAME = '@VortexAiOff';

// ------------------- STATE -------------------
let scanInFlight = false;
let nextFtScan = Date.now() + FT_INTERVAL;
let nextAiScan = Date.now() + AI_INTERVAL;

const activeSignals = new Map(); // AI сигналы (живут пока не сработают)
let lastFtPicks = [];            // FT сигналы (живут 1 минуту)
const cooldowns = new Map();     // Blacklist для отработавших монет

const sseClients = new Set();
const pendingVerifications = new Map();

// ------------------- HELPERS -------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function sseBroadcast(evt, data) {
  const payload = `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => {
    try { c.write(payload); } catch (_) {}
  });
}

async function mexcFetchJSON(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 10000);
  try {
    const res = agent
      ? await fetch(url, { agent, signal: controller.signal })
      : await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return null;
    return res.json();
  } catch (e) { return null; }
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

function isSaneUsdtSymbol(sym) { return /^[A-Z0-9]{2,}USDT$/.test(sym); }
function isStablecoinLike(sym) { return /USDC|USDP|TUSD|DAI|FDUSD|USD1|USDE|PAXG|EUR|GBP/.test(sym); }
function isLeveraged(sym) { return /(3L|3S|5L|5S|UP|DOWN|BULL|BEAR)USDT$/.test(sym); }
function isTokenizedStock(sym) { return /ONUSDT$/.test(sym); }

function relStdDevPct(closes) {
  if (!closes.length) return 999;
  const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
  if (!mean) return 999;
  return (Math.sqrt(closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / closes.length) / mean) * 100;
}

function calculateRSI(closes, period = 14) {
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
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function detectPattern(klines) {
  if (klines.length < 20) return null;
  const input = {
    open: klines.map(k => Number(k[1])),
    high: klines.map(k => Number(k[2])),
    low: klines.map(k => Number(k[3])),
    close: klines.map(k => Number(k[4])),
  };
  if (BullishEngulfing.hasPattern(input)) return "Bullish Engulfing";
  if (BearishEngulfing.hasPattern(input)) return "Bearish Engulfing";
  if (Hammer.hasPattern(input)) return "Hammer";
  if (ShootingStar.hasPattern(input)) return "Shooting Star";
  const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: input.close });
  if (bb.length > 0) {
    const last = bb[bb.length - 1];
    if ((last.upper - last.lower) / (last.middle || 1) < 0.015) return "Bollinger Squeeze";
  }
  return null;
}

// ------------------- AI LOGIC (2-Stage) -------------------
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
  if (tpMove > 0.15 || slMove > 0.15) return null; // до 15% движения

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
    forecast_1m: Array.isArray(obj?.forecast_1m) ? obj.forecast_1m : []
  };
}

// Stage 1: Selection
async function deepseekSelectWinner(candidates) {
  if (!SILICON_KEY) return null;

  const system = `You are a Senior Quant Trader.
Analyze assets. Pick the SINGLE BEST opportunity for a 5-20 min scalp.
Criteria: Market Structure, Volume Anomalies, RSI Divergence.
OUTPUT: Just the Ticker Symbol of the winner (e.g. "BTCUSDT").`;

  let userMsg = "Analyze these assets:\n";
  candidates.forEach((c, i) => {
    const candlesStr = c.klines15.slice(-10).map(k => `[O:${k[1]} H:${k[2]} L:${k[3]} C:${k[4]} V:${k[5]}]`).join(' ');
    userMsg += `Asset ${i + 1}: ${c.symbol}. RSI: ${c.rsi.toFixed(1)}. Candles: ${candlesStr}\n\n`;
  });
  userMsg += "Which one is the winner? Return ONLY the symbol.";

  try {
    const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SILICON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-ai/DeepSeek-V3',
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
        temperature: 0.1
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const content = String(j?.choices?.[0]?.message?.content || '').toUpperCase();
    const winner = candidates.find(c => content.includes(String(c.symbol).toUpperCase()));
    return winner || null;
  } catch (e) { return null; }
}

// Stage 2: Execution
async function deepseekExecution(winner) {
  if (!SILICON_KEY) return null;

  const klines = await fetchMexcKlines(winner.symbol, '1m', 50);
  if (!klines || klines.length < 20) return null;
  const lastClose = Number(klines[klines.length - 1][4]);

  const depth = await fetchMexcDepth(winner.symbol, 20);

  const system = `You are Vortex AI. Return ONLY valid JSON.
Schema: {"target_price":number,"stop_loss_price":number,"direction":"LONG"|"SHORT","confidence":0-100,"forecast_1m":[{"close":number}]}
Trade horizon: 5-20 mins. Keep TP/SL within 1-5%.
LONG => tp > close > sl. SHORT => tp < close < sl.
Forecast: 5 candle prices moving to target.`;

  const user = `Symbol: ${winner.symbol}
LastClose: ${lastClose}
Bids: ${JSON.stringify(depth?.bids?.slice(0,3))}
Asks: ${JSON.stringify(depth?.asks?.slice(0,3))}
Candles (last 20): ${JSON.stringify(klines.slice(-20).map(k=>Number(k[4])))}
Return JSON.`;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 25000);

  try {
    const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SILICON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-ai/DeepSeek-V3',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });

    clearTimeout(id);
    if (!r.ok) return null;

    const j = await r.json();
    let content = stripJsonFences(j?.choices?.[0]?.message?.content);
    const parsed = JSON.parse(content);
    
    const v = validateAiOutput(parsed, lastClose);
    if (!v) return null;

    const now = Date.now();
    const candles = [];
    const path = v.forecast_1m.slice(0, 5);
    for (let i = 0; i < 5; i++) {
      const c = safeNum(path?.[i]?.close);
      const fallback = lastClose + (v.target_price - lastClose) * ((i + 1) / 5);
      candles.push({ t: now + (i + 1) * 60000, close: c ?? fallback });
    }

    return {
      candles,
      target_price: Number(v.target_price),
      stop_loss_price: Number(v.stop_loss_price),
      direction: v.direction,
      confidence: Number(v.confidence),
      source: 'deepseek'
    };
  } catch (e) {
    clearTimeout(id);
    return null;
  }
}

// ------------------- LOGIC: STATUS & CLEANUP -------------------
function updateSignalStatus(sig, price) {
  if (!sig || sig.status !== 'ACTIVE') return false;
  let done = false;
  
  if (sig.direction === 'LONG') {
    if (price >= sig.target_price) { sig.status = 'WON'; done = true; }
    else if (price <= sig.stop_loss_price) { sig.status = 'LOST'; done = true; }
  } else {
    if (price <= sig.target_price) { sig.status = 'WON'; done = true; }
    else if (price >= sig.stop_loss_price) { sig.status = 'LOST'; done = true; }
  }

  if (done) {
    sig.removeAt = Date.now() + SIGNAL_AUTO_REMOVE_MS;
    // FIX: Добавляем в кулдаун, чтобы FT сканер не подхватил её сразу
    cooldowns.set(sig.symbol, Date.now() + COOLDOWN_MS);
  }
  return done;
}

function cleanupGlobals() {
  const now = Date.now();
  // Чистим сигналы
  for (const [sym, sig] of activeSignals.entries()) {
    if (sig.removeAt && now >= sig.removeAt) activeSignals.delete(sym);
  }
  // Чистим кулдауны
  for (const [sym, exp] of cooldowns.entries()) {
    if (now >= exp) cooldowns.delete(sym);
  }
}

function buildPayload() {
  const detected = [...Array.from(activeSignals.values()), ...lastFtPicks];
  
  const forecastsBySymbol = {};
  activeSignals.forEach(s => {
    forecastsBySymbol[s.symbol] = {
      generatedAt: s.addedAt,
      horizonMinutes: 5,
      candles: s.forecastCandles || [],
      target_price: s.target_price,
      stop_loss_price: s.stop_loss_price,
      direction: s.direction,
      status: s.status,
      source: s.source,
      confidence: s.confidence ?? 0,
      removeAt: s.removeAt || null
    };
  });

  return {
    ts: new Date().toISOString(),
    nextFtScan, // FIX: Отправляем точное время для таймера
    nextAiScan,
    parsed: { detected, forecastsBySymbol }
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
    (latest?.parsed?.detected || []).forEach(d => {
      if (d.tag === 'AI') {
        activeSignals.set(d.symbol, { ...d, source: 'deepseek' });
      }
    });
  } catch (_) {}
}

// ------------------- MAIN SCANNER LOOP -------------------
async function runScannerJob() {
  if (scanInFlight) return;
  scanInFlight = true;

  try {
    const all = await fetch24hrTickers();
    if (!all) throw new Error("MEXC API Fail");

    const base = all
      .map(x => ({
        symbol: x.symbol,
        quoteVolume: Number(x.quoteVolume),
        lastPrice: Number(x.lastPrice),
        priceChangePercent: Number(x.priceChangePercent)
      }))
      .filter(x => 
        x.symbol.endsWith('USDT') && 
        isSaneUsdtSymbol(x.symbol) && 
        !isStablecoinLike(x.symbol) && 
        !isLeveraged(x.symbol) &&
        !isTokenizedStock(x.symbol)
      );

    const baseMap = new Map(base.map(b => [b.symbol, b]));
    const now = Date.now();

    // 1. Обновляем статус AI сигналов
    for (const [sym, sig] of activeSignals.entries()) {
      const tick = baseMap.get(sym);
      if (tick) {
        sig.price = tick.lastPrice;
        if (sig.status === 'ACTIVE') updateSignalStatus(sig, tick.lastPrice);
      }
    }
    cleanupGlobals();

    // 2. AI Scan (раз в 5 минут)
    if (now >= nextAiScan && activeSignals.size < 5) {
      console.log('🧠 Running AI Selection...');
      nextAiScan = now + AI_INTERVAL;
      
      const pool = base
        .filter(x => x.quoteVolume > MIN_QUOTEVOL_AI && x.lastPrice >= MIN_PRICE_AI)
        .filter(x => !['BTCUSDT', 'ETHUSDT'].includes(x.symbol))
        .filter(x => !cooldowns.has(x.symbol)) // Пропускаем тех, кто в кулдауне
        .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
        .slice(0, 15);

      const enriched = [];
      for (const c of pool) {
        const kl = await fetchMexcKlines(c.symbol, '1m', 15);
        if (kl.length >= 15) {
          const closes = kl.map(k=>Number(k[4]));
          enriched.push({ 
            symbol: c.symbol, 
            price: Number(c.lastPrice), 
            quoteVolume: Number(c.quoteVolume), 
            rsi: calculateRSI(closes), 
            klines15: kl,
            stdDev: relStdDevPct(closes)
          });
        }
      }

      if (enriched.length > 0) {
        const winner = await deepseekSelectWinner(enriched);
        if (winner) {
          console.log('🏆 Winner Chosen:', winner.symbol);
          const signal = await deepseekExecution(winner);
          if (signal) {
            activeSignals.set(winner.symbol, {
              symbol: winner.symbol,
              tag: 'AI',
              price: winner.price,
              target_price: signal.target_price,
              stop_loss_price: signal.stop_loss_price,
              direction: signal.direction,
              confidence: signal.confidence,
              forecastCandles: signal.candles || [],
              detectedAt: Date.now(),
              status: 'ACTIVE',
              addedAt: Date.now(),
              stdDev: winner.stdDev,
              quoteVolume: winner.quoteVolume,
              change24hPct: 0,
              source: signal.source
            });
          }
        }
      }
    }

    // 3. FT Scan (раз в минуту)
    if (now >= nextFtScan) {
      console.log('⚡ FT Scan running...');
      nextFtScan = now + FT_INTERVAL;
      
      // FIX: Сбрасываем старые пики, чтобы не копились (баг 1000 часов)
      lastFtPicks = [];

      const ftPool = base
        .filter(x => !activeSignals.has(x.symbol))
        .filter(x => !cooldowns.has(x.symbol)) // FIX: Не берем зомби
        .filter(x => x.quoteVolume >= MIN_QUOTEVOL_FT)
        .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
        .slice(0, 60);

      const ftPicks = [];
      for (let i = 0; i < ftPool.length; i += CHUNK_SIZE) {
        const chunk = ftPool.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (t) => {
          const k = await fetchMexcKlines(t.symbol, '1m', 20);
          if (k.length >= 15) {
            const closes = k.map(x=>Number(x[4]));
            const rsi = calculateRSI(closes, 14);
            let signal = 'NEUTRAL';
            if (rsi < 35) signal = 'LONG';
            if (rsi > 65) signal = 'SHORT';
            
            ftPicks.push({
              symbol: t.symbol,
              tag: 'FT',
              price: t.lastPrice,
              quoteVolume: t.quoteVolume,
              change24hPct: t.priceChangePercent,
              rsi,
              signal,
              stdDev: relStdDevPct(closes),
              detectedAt: Date.now(),
              expiresAt: Date.now() + 600000
            });
          }
        }));
      }
      
      const longs = ftPicks.filter(f => f.signal === 'LONG').slice(0, 7);
      const shorts = ftPicks.filter(f => f.signal === 'SHORT').slice(0, 7);
      const vols = ftPicks.filter(f => f.signal === 'NEUTRAL').slice(0, 6);
      lastFtPicks = [...longs, ...shorts, ...vols];
    }

    const payload = buildPayload();
    persistAndBroadcast(payload);

  } catch (e) {
    console.error(e);
  } finally {
    scanInFlight = false;
    setTimeout(runScannerJob, 2000); // Частый цикл для обновления цены, но сканы по таймеру
  }
}

// ------------------- DB & USER -------------------
if (MONGO_URI) {
  mongoose.connect(MONGO_URI).then(() => console.log('[DB] Connected')).catch(e => console.error('[DB] Error', e));
}

const UserSchema = new mongoose.Schema({
  tgId: { type: String, unique: true },
  isPremium: Boolean,
  expiresAt: Number,
  language: { type: String, default: 'en' },
  notificationsEnabled: { type: Boolean, default: true },
  firstName: String,
  username: String
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

async function activateUser(id) {
  try { await User.findOneAndUpdate({ tgId: String(id) }, { isPremium: true, expiresAt: Date.now() + 30 * 24 * 3600000 }, { upsert: true }); } catch (e) {}
}
async function checkUser(id) {
  try { const u = await User.findOne({ tgId: String(id) }); return u && u.isPremium && u.expiresAt > Date.now(); } catch (e) { return false; }
}

let notifyProUsers = async (message) => { console.log('[notify] ' + message); };

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
    manual_pay: "💳 **Способ оплаты: Перевод на карту** 🇷🇺\n💰 **К оплате:** 1000 RUB\n\n👋 Напиши менеджеру по кнопке ниже, он выдаст реквизиты.\n\n🍇 **ПОСЛЕ ПЕРЕВОДА** — возвращайся сюда и жми кнопку **\"✅ Я Оплатил\"**. Затем отправляй скриншот.\n\n_Доступ выдаётся в течение 5 минут._",
    btn_manager: "📩 Написать Менеджеру",
    btn_paid: "✅ Я Оплатил",
    btn_back: "🔙 Назад",
    settings: "⚙️ **Настройки**",
    alerts: "🔔 Уведомления AI:",
    lang_btn: "🌐 Сменить Язык",
    profile: "👤 **ПРОФИЛЬ**",
    no_sub: "❌ Нет подписки",
    days_left: "дней",
    buy_btn: "💎 Купить Premium",
    help: "📚 **ПОМОЩЬ**\n\n• **AI Signals:** Снайперские входы от DeepSeek.\n• **FT:** Зоны перекупленности.\n\nSupport: @meanfive1",
    app_desc: "📱 **Vortex Web App**\n\nНажмите кнопку ниже, чтобы запустить:"
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
    manual_pay: "💳 **Payment Method: Bank Card**\n💰 **Price:** $10\n\n👋 Contact manager below.\n\n🍇 **AFTER PAYMENT** — come back and click **\"✅ I Paid\"**. Then send a screenshot.\n\n_Access granted within 5 mins._",
    btn_manager: "📩 Contact Manager",
    btn_paid: "✅ I Paid",
    btn_back: "🔙 Back",
    settings: "⚙️ **Settings**",
    alerts: "🔔 AI Alerts:",
    lang_btn: "🌐 Change Language",
    profile: "👤 **PROFILE**",
    no_sub: "❌ No Subscription",
    days_left: "days",
    buy_btn: "💎 Buy Premium",
    help: "📚 **HELP**\n\n• **AI Signals:** Sniper entries by DeepSeek.\n• **FT:** RSI Oversold/Overbought zones.\n\nSupport: @meanfive1"
  }
};

// ------------------- TELEGRAM BOT -------------------
if (TG_BOT_TOKEN) {
  try {
    const bot = new Telegraf(TG_BOT_TOKEN);

    const getMenu = (lang) => {
      const T = TEXTS[lang] || TEXTS['ru'];
      return Markup.keyboard([[T.menu.app, T.menu.premium], [T.menu.market, T.menu.settings], [T.menu.help]]).resize();
    };

    const getT = async (ctx) => {
      const u = await User.findOne({ tgId: String(ctx.from.id) });
      return TEXTS[u?.language || 'ru'] || TEXTS['ru'];
    };

    bot.use(async (ctx, next) => {
      if (ctx.from) {
        try {
          await User.findOneAndUpdate(
            { tgId: String(ctx.from.id) },
            { firstName: ctx.from.first_name, username: ctx.from.username },
            { upsert: true }
          );
        } catch (e) {}
      }
      if (ctx.message && ctx.message.text && !ctx.message.text.startsWith('/')) {
        try {
          const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, ctx.from.id);
          if (['left', 'kicked'].includes(member.status)) {
            const T = await getT(ctx);
            return ctx.reply(T.sub_error, Markup.inlineKeyboard([
              Markup.button.url('📢 Channel', `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`),
              Markup.button.callback(T.sub_check, 'check_sub')
            ]));
          }
        } catch (e) {}
      }
      return next();
    });

    notifyProUsers = async (message) => {
      try {
        const users = await User.find({ isPremium: true, notificationsEnabled: true }).lean().exec();
        for (const u of users) {
          try { await bot.telegram.sendMessage(u.tgId, message); } catch (e) {}
        }
      } catch (e) { console.warn('Notify Error:', e); }
    };

    bot.command('start', async (ctx) => {
      await ctx.reply('🌐 Choose language / Выберите язык', Markup.inlineKeyboard([
        Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
        Markup.button.callback('🇺🇸 English', 'lang_en')
      ]));
    });

    bot.command('admin', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return;
      const count = await User.countDocuments();
      const pros = await User.countDocuments({ isPremium: true });
      ctx.reply(`👑 **ADMIN**\nTotal: ${count}\nPRO: ${pros}\n\n/give <id>\n/del <id>`);
    });

    bot.command('give', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return;
      const id = ctx.message.text.split(' ')[1];
      if (id) {
        await activateUser(id);
        ctx.reply(`✅ Given PRO to ${id}`);
        try { await bot.telegram.sendMessage(id, '🎉 Admin granted you Premium! Restart app.'); } catch (e) {}
      }
    });

    bot.command('del', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return;
      const id = ctx.message.text.split(' ')[1];
      if (id) {
        await User.findOneAndUpdate({ tgId: String(id) }, { isPremium: false });
        ctx.reply(`❌ Removed PRO from ${id}`);
      }
    });

    bot.command('force', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return;
      const sym = (ctx.message.text.split(' ')[1] || 'DOGEUSDT').toUpperCase();
      
      const k = await fetchMexcKlines(sym, '1m', 50);
      if (!k.length) return ctx.reply('Symbol not found');
      const price = Number(k[k.length-1][4]);
      
      const signal = {
        symbol: sym, tag: 'AI', price,
        target_price: price * 1.005, stop_loss_price: price * 0.995, direction: 'LONG',
        forecastCandles: [], detectedAt: Date.now(), status: 'ACTIVE', addedAt: Date.now(),
        stdDev: 0, quoteVolume: 1000000, spreadPct: 0.01, source: 'manual'
      };
      
      activeSignals.set(sym, signal);
      ctx.reply(`✅ Forced ${sym}`);
    });

    bot.action(/^lang_(.+)$/, async (ctx) => {
      const lang = ctx.match[1];
      await User.findOneAndUpdate({ tgId: String(ctx.from.id) }, { language: lang }, { upsert: true });
      await ctx.answerCbQuery();
      try { await ctx.deleteMessage(); } catch (e) {}
      const T = TEXTS[lang] || TEXTS['ru'];
      await ctx.reply(T.welcome, getMenu(lang));
    });

    bot.action('check_sub', (ctx) => { ctx.deleteMessage(); ctx.reply('✅ OK!'); });

    bot.hears([/🚀 Vortex App/, /🚀 Открыть Терминал/, /App/, /Terminal/], async (ctx) => {
      const T = await getT(ctx);
      ctx.reply(T.app_desc, { parse_mode: 'HTML', ...Markup.inlineKeyboard([Markup.button.webApp(T.menu.app, WEBAPP_URL)]) });
    });

    bot.hears([/👤 Профиль/, /👤 Profile/], async (ctx) => {
      const T = await getT(ctx);
      const u = await User.findOne({ tgId: String(ctx.from.id) });
      const isPro = u && u.isPremium && u.expiresAt > Date.now();
      let statusText = T.no_sub;
      if (isPro) {
        const days = Math.ceil((u.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
        statusText = `PRO (${days} ${T.days_left})`;
      }
      ctx.reply(`${T.profile}\n\n🆔 ID: <code>${ctx.from.id}</code>\n👤 User: @${ctx.from.username}\n💎 Status: ${statusText}`, { parse_mode: 'HTML' });
    });

    bot.hears([/⚙️ Настройки/, /⚙️ Settings/], async (ctx) => {
      const T = await getT(ctx);
      const u = await User.findOne({ tgId: String(ctx.from.id) });
      const s = u?.notificationsEnabled ? '✅ ON' : '❌ OFF';
      ctx.reply(`${T.settings}\n\n${T.alerts} ${s}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(T.lang_btn, 'change_lang')],
          [Markup.button.callback('Toggle Alerts', 'toggle_alerts')]
        ])
      });
    });

    bot.action('change_lang', (ctx) => {
      ctx.reply('🌐 Choose language:', Markup.inlineKeyboard([
        Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
        Markup.button.callback('🇺🇸 English', 'lang_en')
      ]));
    });

    bot.action('toggle_alerts', async (ctx) => {
      const u = await User.findOne({ tgId: String(ctx.from.id) });
      if (!u?.isPremium) return ctx.answerCbQuery('PRO Only');
      u.notificationsEnabled = !u.notificationsEnabled;
      await u.save();
      ctx.answerCbQuery(u.notificationsEnabled ? 'On' : 'Off');
    });

    bot.hears([/💎 Premium/, /💎 Премиум/], async (ctx) => {
      const T = await getT(ctx);
      const u = await checkUser(ctx.from.id);
      if (u) return ctx.reply('✅ You are PRO.');
      await ctx.reply(T.disclaimer, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(T.agree_pay, 'show_pay')]]) });
    });

    bot.action('show_pay', async (ctx) => {
      const T = await getT(ctx);
      ctx.editMessageText(T.premium_buy, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(T.pay_methods.card, 'pay_manager')],
          [Markup.button.callback(T.pay_methods.crypto, 'pay_manager')],
          [Markup.button.callback(T.pay_methods.stars, 'pay_stars')]
        ])
      });
    });

    bot.action('pay_manager', async (ctx) => {
      const T = await getT(ctx);
      const msg = T.language === 'en' ? 'Hello, I want to buy Premium.' : 'Привет, нужны реквизиты для оплаты переводом на карту.';
      const link = `https://t.me/${MANAGER_USERNAME}?text=${encodeURIComponent(msg)}`;
      ctx.editMessageText(T.manual_pay, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url(T.btn_manager, link)],
          [Markup.button.callback(T.btn_paid, 'paid_manual')],
          [Markup.button.callback(T.btn_back, 'show_pay')]
        ])
      });
    });

    bot.action('paid_manual', async (ctx) => {
      const T = await getT(ctx);
      await ctx.answerCbQuery();
      await ctx.reply(T.language === 'en' ? '📸 Please send a screenshot.' : '📸 Пожалуйста, отправьте скриншот оплаты.');
      pendingVerifications.set(ctx.from.id, true);
    });

    bot.on('photo', async (ctx) => {
      if (pendingVerifications.get(ctx.from.id)) {
        pendingVerifications.delete(ctx.from.id);
        await ctx.reply('⏳ Verifying...');
        await bot.telegram.sendPhoto(ADMIN_ID, ctx.message.photo[ctx.message.photo.length - 1].file_id, {
          caption: `💰 Payment from ${ctx.from.first_name} (ID: ${ctx.from.id})`,
          ...Markup.inlineKeyboard([
            Markup.button.callback('✅ Approve', `approve_${ctx.from.id}`),
            Markup.button.callback('❌ Reject', `reject_${ctx.from.id}`)
          ])
        });
      }
    });

    bot.action(/^approve_(\d+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await activateUser(userId);
      await bot.telegram.sendMessage(userId, '🎉 Premium Activated!');
      ctx.editMessageCaption(ctx.callbackQuery.message.caption + '\n\n✅ APPROVED');
    });

    bot.action(/^reject_(\d+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await bot.telegram.sendMessage(userId, '❌ Payment Rejected.');
      ctx.editMessageCaption(ctx.callbackQuery.message.caption + '\n\n❌ REJECTED');
    });

    bot.action('pay_stars', (ctx) => ctx.replyWithInvoice({
      chat_id: ctx.from.id,
      title: 'Vortex PRO',
      description: '1 Month',
      payload: 'pro',
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: '1 Month', amount: 500 }]
    }));
    bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
    bot.on('successful_payment', async (ctx) => { await activateUser(ctx.from.id); ctx.reply('🎉 Paid!'); });

    bot.hears(/📊 Market|📊 Рынок/, async (ctx) => {
      const T = await getT(ctx);
      ctx.reply(T.market);
    });

    bot.hears(/❓ Help|❓ Помощь/, async (ctx) => {
      const T = await getT(ctx);
      ctx.reply(T.help, { parse_mode: 'HTML' });
    });

    bot.launch().then(() => console.log('🤖 Bot Started'));
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

  } catch (e) { console.error('Bot Error:', e); }
}

// ------------------- API ROUTES -------------------
app.get('/api/user/status', async (req, res) => {
  const id = req.query.tg_id;
  const hasAccess = await checkUser(id);
  res.json({ isPremium: hasAccess });
});

app.get('/api/scheduler/latest', (req, res) => {
  try {
    if (fs.existsSync(DATA_FILE)) res.json(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    else res.json({});
  } catch (e) { res.json({}); }
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
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/live/candles', async (req, res) => {
  const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
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
  const sym = String(req.query.symbol || 'BTCUSDT').toUpperCase();
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

// Front-end serve
app.use(express.static(path.join(__dirname, '../dist')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/events')) return;
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// ------------------- START -------------------
app.listen(PORT, () => {
  try { loadPersistedSignals(); } catch (e) {}
  console.log(`🚀 Server on ${PORT}`);
  runScannerJob();
});
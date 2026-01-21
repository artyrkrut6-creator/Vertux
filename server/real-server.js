require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const {
  BullishEngulfing,
  BearishEngulfing,
  Hammer,
  ShootingStar,
  BollingerBands,
} = require('technicalindicators');
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
  try {
    agent = new HttpsProxyAgent(PROXY_URL);
  } catch (_) {}
}

// --- CONSTANTS ---
const MIN_PRICE_FT = 0.02;
const MIN_PRICE_AI = 0.10;

const MIN_QUOTEVOL_FT = 700_000;
const MIN_QUOTEVOL_AI = 1_200_000; // чуть мягче, чтобы AI не было 0

const MAX_SPREAD_FT_PCT = 0.50;
const MAX_SPREAD_AI_PCT = 0.80; // мягче

const BACKTEST_KLINES = 50;

const CHUNK_SIZE = 20;
const UI_INTERVAL = 300_000;
const PRE_WORK_TIME = 45_000;

const SILICON_KEY = process.env.SILICON_KEY || null;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || null;

const WEBAPP_URL = process.env.WEBAPP_URL || 'https://vortex-ai-nffc.onrender.com';
const MONGO_URI = process.env.MONGO_URI || null;

const MANAGER_USERNAME = 'meanfive1';
const ADMIN_ID = 8270078362;
const CHANNEL_USERNAME = '@VortexAiOff';

// авто-удаление отработавшего сигнала через 3 секунды
const SIGNAL_AUTO_REMOVE_MS = 3000;

// --- STATE ---
let scanInFlight = false;
const activeSignals = new Map(); // persistent signals
const sseClients = new Set();
const pendingVerifications = new Map();

// --- HELPERS ---
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function directionUi(direction) {
  return direction === 'LONG' ? 'Long' : direction === 'SHORT' ? 'Short' : direction;
}

function normalizeAiSymbol(sym) {
  return String(sym || '').trim().toUpperCase();
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
  } catch (e) {
    clearTimeout(id);
    return null;
  }
}

async function fetch24hrTickers() {
  return mexcFetchJSON('https://api.mexc.com/api/v3/ticker/24hr');
}

async function fetchMexcKlines(symbol, interval = '1m', limit = 50) {
  const url = `https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(
    symbol
  )}&interval=${interval}&limit=${limit}`;
  const data = await mexcFetchJSON(url);
  return Array.isArray(data) ? data : [];
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

function relStdDevPct(closes) {
  if (!closes.length) return 999;
  const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
  if (!mean) return 999;
  const variance =
    closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / closes.length;
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

function detectPattern(klines) {
  if (klines.length < 20) return null;

  const input = {
    open: klines.map((k) => Number(k[1])),
    high: klines.map((k) => Number(k[2])),
    low: klines.map((k) => Number(k[3])),
    close: klines.map((k) => Number(k[4])),
  };

  if (BullishEngulfing.hasPattern(input)) return 'Bullish Engulfing';
  if (BearishEngulfing.hasPattern(input)) return 'Bearish Engulfing';
  if (Hammer.hasPattern(input)) return 'Hammer';
  if (ShootingStar.hasPattern(input)) return 'Shooting Star';

  const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: input.close });
  if (bb.length > 0) {
    const last = bb[bb.length - 1];
    const width = (last.upper - last.lower) / (last.middle || 1);
    if (width < 0.018) return 'Bollinger Squeeze';
  }

  return null;
}

// --- DEEPSEEK (WITH FALLBACK) ---
function stripJsonFences(s) {
  if (!s) return '';
  let out = String(s).trim();
  if (out.includes('```')) {
    // вытаскиваем между тройными кавычками если там json
    const parts = out.split('```');
    // ищем самый "похожий на json" кусок
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

  // sanity: tp/sl не должны быть абсолютно безумными
  const maxMove = 0.10; // 10% лимит на 1м вход
  const tpMove = Math.abs(tp / lastClose - 1);
  const slMove = Math.abs(sl / lastClose - 1);
  if (tpMove > maxMove || slMove > maxMove) return null;

  // SL должен быть с другой стороны относительно направления
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

async function deepseekForecast5(symbol, contextCandles, extra) {
  const last = contextCandles[contextCandles.length - 1];
  const lastClose = Number(last.close);

  // 1) DeepSeek
  if (SILICON_KEY) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 20_000);

      // даём модели контекст (чтобы не было 0 AI монет из-за мусорного JSON)
      const compact = contextCandles.slice(-50).map((c) => ({
        t: c.t,
        o: Number(c.open),
        h: Number(c.high),
        l: Number(c.low),
        c: Number(c.close),
      }));

      const system =
        'You are Vortex AI, a high-frequency crypto trading assistant. ' +
        'Return ONLY valid JSON object. No markdown. No explanations. ' +
        'Schema: {"target_price":number,"stop_loss_price":number,"direction":"LONG"|"SHORT","confidence":0-100,"forecast_1m":[{"close":number}]} ' +
        'Rules: Use last close as reference. LONG => target > lastClose and stop < lastClose. SHORT => target < lastClose and stop > lastClose. ' +
        'Keep tp/sl within 1%..3% from lastClose. forecast_1m must be 5 items, smooth toward target.';

      const user =
        `Symbol: ${symbol}\n` +
        `Last close: ${lastClose}\n` +
        (extra ? `Context hint: ${extra}\n` : '') +
        `Candles (1m, last 50): ${JSON.stringify(compact)}`;

      const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SILICON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-ai/DeepSeek-V3',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      clearTimeout(id);

      if (r.ok) {
        const j = await r.json();
        let content = j?.choices?.[0]?.message?.content || '{}';
        content = stripJsonFences(content);

        let parsed = null;
        try {
          parsed = JSON.parse(content);
        } catch (_) {
          parsed = null;
        }

        const v = validateAiOutput(parsed, lastClose);
        if (v) {
          const candles = [];
          const path = v.forecast_1m.slice(0, 5);
          for (let i = 0; i < 5; i++) {
            const close = safeNum(path?.[i]?.close);
            const fallbackClose = lastClose + (v.target_price - lastClose) * ((i + 1) / 5);
            candles.push({
              t: Date.now() + (i + 1) * 60_000,
              close: close ?? fallbackClose,
            });
          }

          return {
            candles,
            target_price: Number(v.target_price),
            stop_loss_price: Number(v.stop_loss_price),
            direction: v.direction,
            confidence: Number(v.confidence),
            source: 'deepseek',
          };
        }
      }
    } catch (_) {
      // ignore, fallback below
    }
  }

  // 2) FALLBACK: Bollinger Bands
  const closes = contextCandles.map((c) => Number(c.close));
  const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  const lastBB = bb[bb.length - 1];

  if (!lastBB) return null;

  const dir = lastClose < lastBB.middle ? 'LONG' : 'SHORT';
  const target = dir === 'LONG' ? lastBB.upper : lastBB.lower;
  const stop = dir === 'LONG' ? lastBB.lower : lastBB.upper;

  const candles = [];
  for (let i = 1; i <= 5; i++) {
    const p = lastClose + (target - lastClose) * (i / 5);
    candles.push({ t: Date.now() + i * 60_000, close: p });
  }

  return {
    candles,
    target_price: Number(Number(target).toFixed(8)),
    stop_loss_price: Number(Number(stop).toFixed(8)),
    direction: dir,
    confidence: 65,
    source: 'fallback',
  };
}

// --- ADAPTIVE PICKER (FIXED: less strict, more candidates) ---
async function pickAiWithAdaptiveGates(aiPool) {
  const blacklist = new Set([
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'USDCUSDT',
    'FDUSDUSDT',
  ]);

  // берём более широкий пул
  const pool = aiPool
    .slice()
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, 25);

  const accepted = [];
  const maxChecks = 10;

  const candidates = pool
    .filter((t) => !blacklist.has(t.symbol))
    .filter((t) => t.quoteVolume >= MIN_QUOTEVOL_AI && t.lastPrice >= MIN_PRICE_AI)
    .slice(0, maxChecks);

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const kl = await fetchMexcKlines(candidate.symbol, '1m', BACKTEST_KLINES);
        if (kl.length < 30) return null;

        const candles = kl.map((k) => ({
          t: Number(k[0]),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
        }));

        const closes = candles.map((c) => c.close);
        const stdDev = relStdDevPct(closes);
        const pattern = detectPattern(kl);

        // критерий вызова AI стал мягче: pattern OR volume OR volatility
        const shouldCallAi =
          Boolean(pattern) || candidate.quoteVolume > 3_000_000 || stdDev >= 0.35;

        if (!shouldCallAi) return null;

        const ds = await deepseekForecast5(candidate.symbol, candles, pattern || `stdDev=${stdDev.toFixed(2)}%`);
        if (!ds) return null;

        return {
          ...candidate,
          stdDev,
          target_price: ds.target_price,
          stop_loss_price: ds.stop_loss_price,
          direction: ds.direction,
          directionUi: directionUi(ds.direction),
          confidence: ds.confidence,
          forecastCandles: ds.candles,
          source: ds.source,
        };
      } catch (_) {
        return null;
      }
    })
  );

  results.filter(Boolean).forEach((v) => accepted.push(v));

  // максимум 2 сигнала за проход
  return accepted.slice(0, 2);
}

// --- DB & USER ---
if (MONGO_URI) {
  mongoose
    .connect(MONGO_URI)
    .then(() => console.log('[db] connected'))
    .catch((e) => console.error('[db] error', e));
}

const UserSchema = new mongoose.Schema({
  tgId: { type: String, unique: true },
  isPremium: Boolean,
  expiresAt: Number,
  language: { type: String, default: 'en' },
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

let notifyProUsers = async () => {};

// --- TEXTS (unchanged) ---
const TEXTS = {
  ru: {
    welcome:
      '👋 Добро пожаловать в Vortex AI!\n\nПожалуйста, подпишитесь на наш канал, чтобы продолжить.',
    sub_check: '🔄 Проверить подписку',
    sub_error:
      '❌ Вы не подписаны на канал. Подпишитесь, чтобы пользоваться ботом.',
    lang_select: '🌐 Выберите язык / Select Language:',
    menu: {
      app: '🚀 Vortex App',
      premium: '💎 Premium',
      market: '📊 Рынок',
      settings: '⚙️ Настройки',
      help: '❓ Помощь',
    },
    market: '🔄 Сканирую рынок...',
    premium_status: '✅ Ваш статус: PRO',
    premium_buy:
      '💎 **VORTEX PRO**\n\n• AI Снайпер Сигналы\n• Без задержек\n• Полный доступ\n\n**Цена:** 1000 RUB / 1 Месяц',
    pay_methods: { crypto: '💠 Крипта (USDT)', stars: '⭐️ Telegram Stars', card: '💳 Карта РФ' },
    disclaimer:
      '⚠️ **ЮРИДИЧЕСКИЙ ДИСКЛЕЙМЕР**\n\n1. **Риски:** Торговля криптовалютой сопряжена с высоким риском. Вы можете потерять вложения.\n2. **Гарантии:** Сигналы Vortex AI — это прогнозы, а не финансовые советы. Мы не гарантируем прибыль.\n3. **Возврат:** Средства за подписку не возвращаются.\n\nНажимая кнопку оплаты, вы соглашаетесь с этими условиями.',
    agree_pay: '✅ Согласен, Оплатить',
    manual_pay:
      '💳 **Способ оплаты: Перевод на карту** 🇷🇺\n💰 **К оплате:** 1000 RUB\n\n👋 Напиши менеджеру по кнопке ниже, он выдаст реквизиты.\n\n🍇 **ПОСЛЕ ПЕРЕВОДА** — возвращайся сюда и жми кнопку **"✅ Я Оплатил"**. Затем отправляй скриншот.\n\n_Доступ выдаётся в течение 5 минут._',
    btn_manager: '📩 Написать Менеджеру',
    btn_paid: '✅ Я Оплатил',
    btn_back: '🔙 Назад',
    settings: '⚙️ **Настройки**',
    alerts: '🔔 Уведомления AI:',
    lang_btn: '🌐 Сменить Язык',
    profile: '👤 **ПРОФИЛЬ**',
    no_sub: '❌ Нет подписки',
    days_left: 'дней',
    buy_btn: '💎 Купить Premium',
    help:
      '📚 **ПОМОЩЬ**\n\n• **AI Signals:** Снайперские входы от DeepSeek.\n• **FT:** Зоны перекупленности/перепроданности.\n\nSupport: @meanfive1',
    app_desc: '📱 **Vortex Web App**\n\nНажмите кнопку ниже, чтобы запустить:',
  },
  en: {
    welcome: '👋 Welcome to Vortex AI!\n\nPlease subscribe to our channel to continue.',
    sub_check: '🔄 Check Subscription',
    sub_error: '❌ You are not subscribed. Please join to use the bot.',
    lang_select: '🌐 Select Language:',
    menu: {
      app: '🚀 Vortex App',
      premium: '💎 Premium',
      market: '📊 Market',
      settings: '⚙️ Settings',
      help: '❓ Help',
    },
    app_desc: '📱 **Vortex Web App**\n\nClick below to launch:',
    market: '🔄 Scanning...',
    premium_status: '✅ Your Status: PRO',
    premium_buy:
      '💎 **VORTEX PRO**\n\n• AI Sniper Signals\n• Zero Latency\n• Full Access\n\n**Price:** $10 / 1 Month',
    pay_methods: { crypto: '💠 Crypto (USDT)', stars: '⭐️ Telegram Stars', card: '💳 Bank Card' },
    disclaimer:
      '⚠️ **LEGAL DISCLAIMER**\n\n1. **Risk:** Crypto trading involves high risk. You may lose your investment.\n2. **No Guarantees:** Vortex AI signals are forecasts, NOT financial advice.\n3. **No Refunds:** All sales are final.\n\nBy clicking pay, you agree to these terms.',
    agree_pay: '✅ I Agree & Pay',
    manual_pay:
      '💳 **Payment Method: Bank Card**\n💰 **Price:** $10\n\n👋 Contact manager below for details.\n\n🍇 **AFTER PAYMENT** — come back and click **"✅ I Paid"**. Then send a screenshot.\n\n_Access granted within 5 mins._',
    btn_manager: '📩 Contact Manager',
    btn_paid: '✅ I Paid',
    btn_back: '🔙 Back',
    settings: '⚙️ **Settings**',
    alerts: '🔔 AI Alerts:',
    lang_btn: '🌐 Change Language',
    profile: '👤 **PROFILE**',
    no_sub: '❌ No Subscription',
    days_left: 'days',
    buy_btn: '💎 Buy Premium',
    help:
      '📚 **HELP**\n\n• **AI Signals:** Sniper entries by DeepSeek.\n• **FT:** RSI Oversold/Overbought zones.\n\nSupport: @meanfive1',
  },
};

// --- TELEGRAM BOT (mostly unchanged) ---
if (TG_BOT_TOKEN) {
  try {
    const bot = new Telegraf(TG_BOT_TOKEN);

    const getMenu = (lang) => {
      const T = TEXTS[lang] || TEXTS.ru;
      return Markup.keyboard([[T.menu.app, T.menu.premium], [T.menu.market, T.menu.settings], [T.menu.help]]).resize();
    };

    const getT = async (ctx) => {
      const u = await User.findOne({ tgId: String(ctx.from.id) });
      return TEXTS[u?.language || 'ru'] || TEXTS.ru;
    };

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

      if (ctx.message && ctx.message.text && !ctx.message.text.startsWith('/')) {
        try {
          const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, ctx.from.id);
          if (['left', 'kicked'].includes(member.status)) {
            const T = await getT(ctx);
            return ctx.reply(
              T.sub_error,
              Markup.inlineKeyboard([
                Markup.button.url('📢 Channel', `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`),
                Markup.button.callback(T.sub_check, 'check_sub'),
              ])
            );
          }
        } catch (_) {}
      }

      return next();
    });

    notifyProUsers = async (message) => {
      try {
        const users = await User.find({ isPremium: true, notificationsEnabled: true }).lean().exec();
        for (const u of users) {
          try {
            await bot.telegram.sendMessage(u.tgId, message);
          } catch (_) {}
        }
      } catch (_) {}
    };

    bot.command('start', async (ctx) => {
      await ctx.reply(
        '🌐 Choose language / Выберите язык',
        Markup.inlineKeyboard([Markup.button.callback('🇷🇺 Русский', 'lang_ru'), Markup.button.callback('🇺🇸 English', 'lang_en')])
      );
    });

    bot.action(/^lang_(.+)$/, async (ctx) => {
      const lang = ctx.match[1];
      await User.findOneAndUpdate({ tgId: String(ctx.from.id) }, { language: lang }, { upsert: true });
      await ctx.answerCbQuery();
      try {
        await ctx.deleteMessage();
      } catch (_) {}
      const T = TEXTS[lang] || TEXTS.ru;
      await ctx.reply(T.welcome, getMenu(lang));
    });

    bot.action('check_sub', async (ctx) => {
      try {
        await ctx.deleteMessage();
      } catch (_) {}
      await ctx.reply('✅ OK!');
    });

    bot.hears([/🚀 Vortex App/, /App/, /Terminal/], async (ctx) => {
      const T = await getT(ctx);
      ctx.reply(T.app_desc, Markup.inlineKeyboard([Markup.button.webApp(T.menu.app, WEBAPP_URL)]));
    });

    bot.hears([/💎 Premium/, /💎 Премиум/], async (ctx) => {
      const T = await getT(ctx);
      const u = await checkUser(ctx.from.id);
      if (u) return ctx.reply('✅ You are PRO.');
      await ctx.reply(T.disclaimer, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback(T.agree_pay, 'show_pay')]]),
      });
    });

    bot.action('show_pay', async (ctx) => {
      const T = await getT(ctx);
      ctx.editMessageText(T.premium_buy, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(T.pay_methods.card, 'pay_manager')],
          [Markup.button.callback(T.pay_methods.crypto, 'pay_manager')],
          [Markup.button.callback(T.pay_methods.stars, 'pay_stars')],
        ]),
      });
    });

    bot.action('pay_manager', async (ctx) => {
      const T = await getT(ctx);
      const msg =
        T.language === 'en'
          ? 'Hello, I want to buy Premium.'
          : 'Привет, нужны реквизиты для оплаты переводом на карту.';
      const link = `https://t.me/${MANAGER_USERNAME}?text=${encodeURIComponent(msg)}`;
      ctx.editMessageText(T.manual_pay, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url(T.btn_manager, link)],
          [Markup.button.callback(T.btn_paid, 'paid_manual')],
          [Markup.button.callback(T.btn_back, 'show_pay')],
        ]),
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
          caption: `Payment from ${ctx.from.first_name} (ID: ${ctx.from.id})`,
          ...Markup.inlineKeyboard([
            Markup.button.callback('Approve', `approve_${ctx.from.id}`),
            Markup.button.callback('Reject', `reject_${ctx.from.id}`),
          ]),
        });
      }
    });

    bot.action(/^approve_(\d+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await activateUser(userId);
      await bot.telegram.sendMessage(userId, 'Premium activated.');
      ctx.editMessageCaption((ctx.callbackQuery.message.caption || '') + '\n\nApproved');
    });

    bot.action(/^reject_(\d+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await bot.telegram.sendMessage(userId, 'Payment rejected.');
      ctx.editMessageCaption((ctx.callbackQuery.message.caption || '') + '\n\nRejected');
    });

    // Stars (оставил как было)
    bot.action('pay_stars', (ctx) =>
      ctx.replyWithInvoice({
        chat_id: ctx.from.id,
        title: 'Vortex PRO',
        description: '1 Month',
        payload: 'pro',
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: '1 Month', amount: 500 }],
      })
    );
    bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
    bot.on('successful_payment', async (ctx) => {
      await activateUser(ctx.from.id);
      ctx.reply('Paid.');
    });

    // Admin force
    bot.command('admin', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return;
      const count = await User.countDocuments();
      const pros = await User.countDocuments({ isPremium: true });
      ctx.reply(
        `ADMIN\nTotal: ${count}\nPRO: ${pros}\n\n/give <id>\n/force <symbol>`,
        Markup.inlineKeyboard([Markup.button.callback('Force random ai', 'force_random')])
      );
    });

    bot.command('give', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return;
      const id = ctx.message.text.split(' ')[1];
      if (id) {
        await activateUser(id);
        ctx.reply(`Given to ${id}`);
      }
    });

    bot.action('force_random', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.answerCbQuery('Unauthorized');

      const all = await fetch24hrTickers();
      const liquid = (all || [])
        .filter((t) => Number(t.quoteVolume) > 1_000_000 && String(t.symbol || '').endsWith('USDT'))
        .sort(() => Math.random() - 0.5);

      const sym = normalizeAiSymbol(liquid[0]?.symbol || 'BTCUSDT');

      const k = await fetchMexcKlines(sym, '1m', 50);
      if (k.length < 30) return ctx.answerCbQuery('No data');

      const lastClose = Number(k[k.length - 1][4]);
      const target = lastClose * 1.005;
      const stop = lastClose * 0.995;

      const signal = {
        symbol: sym,
        tag: 'AI',
        price: lastClose,
        target_price: target,
        stop_loss_price: stop,
        direction: 'LONG',
        directionUi: 'Long',
        confidence: 50,
        forecastCandles: [],
        detectedAt: Date.now(),
        status: 'ACTIVE',
        addedAt: Date.now(),
        stdDev: 0,
        quoteVolume: 10_000_000,
        spreadPct: 0.01,
        source: 'manual',
      };

      activeSignals.set(sym, signal);

      const payload = buildPayload();
      persistAndBroadcast(payload);

      ctx.answerCbQuery(`Forced ${sym}`);
      try {
        await ctx.editMessageText(`Forced ai: ${sym} Long`);
      } catch (_) {}
    });

    bot.command('force', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return;

      const sym = normalizeAiSymbol(ctx.message.text.split(' ')[1] || 'BTCUSDT');

      const k = await fetchMexcKlines(sym, '1m', 50);
      if (k.length < 30) return ctx.reply('No data for ' + sym);

      const candles = k.map((x) => ({
        t: Number(x[0]),
        open: Number(x[1]),
        high: Number(x[2]),
        low: Number(x[3]),
        close: Number(x[4]),
      }));

      const lastClose = candles[candles.length - 1].close;
      const ds = await deepseekForecast5(sym, candles, detectPattern(k) || 'Admin request');

      const target = ds?.target_price ?? lastClose * 1.005;
      const stop = ds?.stop_loss_price ?? lastClose * 0.995;
      const direction = ds?.direction ?? 'LONG';

      const signal = {
        symbol: sym,
        tag: 'AI',
        price: lastClose,
        target_price: target,
        stop_loss_price: stop,
        direction,
        directionUi: directionUi(direction),
        confidence: ds?.confidence ?? 50,
        forecastCandles: ds?.candles || [],
        detectedAt: Date.now(),
        status: 'ACTIVE',
        addedAt: Date.now(),
        stdDev: relStdDevPct(candles.map((c) => c.close)),
        quoteVolume: 10_000_000,
        spreadPct: 0.01,
        source: ds?.source || 'manual',
      };

      activeSignals.set(sym, signal);

      const payload = buildPayload();
      persistAndBroadcast(payload);

      ctx.reply(`Signal forced: ${sym} ${directionUi(direction)}`);
    });

    bot.launch().then(() => console.log('[bot] started'));
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (e) {
    console.error('Bot Error:', e);
  }
}

// --- SCANNER CORE (persistent signals preserved) ---
function loadPersistedSignals() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const latest = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

    // restore only AI signals (persistent)
    (latest.parsed?.detected || []).forEach((d) => {
      if (d.tag === 'AI') {
        const f = latest.parsed?.forecastsBySymbol?.[d.symbol];
        const restored = {
          ...d,
          ...(f || {}),
          forecastCandles: f?.candles || d.forecastCandles || [],
        };
        // normalize ui field
        restored.directionUi = directionUi(restored.direction);
        activeSignals.set(d.symbol, restored);
      }
    });
  } catch (_) {}
}

function buildPayload(extraDetected = []) {
  const finalDetected = [...Array.from(activeSignals.values())];

  const forecastsBySymbol = {};
  activeSignals.forEach((s) => {
    forecastsBySymbol[s.symbol] = {
      generatedAt: s.addedAt,
      horizonMinutes: 5,
      candles: s.forecastCandles || [],
      target_price: s.target_price,
      stop_loss_price: s.stop_loss_price,
      direction: s.direction,
      directionUi: directionUi(s.direction),
      status: s.status,
      source: s.source || 'deepseek',
      confidence: s.confidence ?? 0,
      removeAt: s.removeAt || null,
    };
  });

  extraDetected.forEach((x) => finalDetected.push(x));

  return {
    ts: new Date().toISOString(),
    nextScanAt: Date.now() + UI_INTERVAL,
    parsed: {
      detected: finalDetected,
      forecastsBySymbol,
    },
  };
}

function persistAndBroadcast(payload) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload));
  } catch (_) {}
  sseBroadcast('scheduled_update', payload);
}

function updateSignalStatusAndScheduleRemoval(signal, price) {
  if (!signal || signal.status !== 'ACTIVE') return false;

  let done = false;

  if (signal.direction === 'LONG') {
    if (price >= signal.target_price) {
      signal.status = 'WON';
      done = true;
    } else if (price <= signal.stop_loss_price) {
      signal.status = 'LOST';
      done = true;
    }
  } else if (signal.direction === 'SHORT') {
    if (price <= signal.target_price) {
      signal.status = 'WON';
      done = true;
    } else if (price >= signal.stop_loss_price) {
      signal.status = 'LOST';
      done = true;
    }
  }

  if (done) {
    signal.removeAt = Date.now() + SIGNAL_AUTO_REMOVE_MS; // удалим через 3 сек
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

async function runScannerJob() {
  if (scanInFlight) return;
  scanInFlight = true;

  try {
    const all = await fetch24hrTickers();
    if (!all) throw new Error('MEXC API Fail');

    const base = all
      .map((x) => ({
        symbol: String(x.symbol),
        quoteVolume: Number(x.quoteVolume),
        lastPrice: Number(x.lastPrice),
        priceChangePercent: Number(x.priceChangePercent),
        bidPrice: safeNum(x.bidPrice),
        askPrice: safeNum(x.askPrice),
      }))
      .filter((x) => x.symbol.endsWith('USDT'))
      .filter((x) => isSaneUsdtSymbol(x.symbol))
      .filter((x) => !isStablecoinLike(x.symbol))
      .filter((x) => !isLeveraged(x.symbol))
      .filter((x) => !isTokenizedStock(x.symbol));

    const baseMap = new Map(base.map((b) => [b.symbol, b]));

    // 1) Update active signals (WON/LOST) + schedule removal
    for (const [sym, sig] of Array.from(activeSignals.entries())) {
      const tick = baseMap.get(sym);
      if (!tick) continue;

      const price = Number(tick.lastPrice);
      sig.price = price;

      if (sig.status === 'ACTIVE') {
        updateSignalStatusAndScheduleRemoval(sig, price);
      }
    }

    // 2) Remove signals after 3 seconds
    cleanupExpiredSignals();

    // 3) Add AI picks if few
    if (activeSignals.size < 5) {
      const aiPool = base.filter((x) => x.quoteVolume >= MIN_QUOTEVOL_AI && x.lastPrice >= MIN_PRICE_AI);
      const newPicks = await pickAiWithAdaptiveGates(aiPool);

      newPicks.forEach((p) => {
        if (!activeSignals.has(p.symbol)) {
          activeSignals.set(p.symbol, {
            symbol: p.symbol,
            tag: 'AI',
            price: p.lastPrice,
            quoteVolume: p.quoteVolume,
            change24hPct: p.priceChangePercent,
            stdDev: p.stdDev ?? 0,

            target_price: p.target_price,
            stop_loss_price: p.stop_loss_price,
            direction: p.direction,
            directionUi: directionUi(p.direction),
            confidence: p.confidence ?? 0,
            source: p.source || 'deepseek',
            forecastCandles: p.forecastCandles || [],

            detectedAt: Date.now(),
            status: 'ACTIVE',
            addedAt: Date.now(),
          });

          // уведомления только для бота (оставил)
          notifyProUsers(
            `🚨 New signal: ${p.symbol} ${directionUi(p.direction)}\nTarget: ${Number(p.target_price).toFixed(8)}\nStop: ${Number(p.stop_loss_price).toFixed(8)}`
          );
        }
      });
    }

    // 4) FT picks (RSI)
    const ftPicks = [];
    const ftCandidates = base
      .filter((x) => x.quoteVolume >= MIN_QUOTEVOL_FT && x.lastPrice >= MIN_PRICE_FT && !activeSignals.has(x.symbol))
      .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
      .slice(0, 60);

    for (let i = 0; i < ftCandidates.length; i += CHUNK_SIZE) {
      const chunk = ftCandidates.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (t) => {
          const k = await fetchMexcKlines(t.symbol, '1m', 20);
          if (k.length < 15) return;

          const closes = k.map((x) => Number(x[4]));
          const rsi = calculateRSI(closes, 14);

          let signal = 'NEUTRAL';
          if (rsi < 35) signal = 'LONG';
          if (rsi > 65) signal = 'SHORT';

          ftPicks.push({
            ...t,
            rsi,
            signal,
            tag: 'FT',
            stdDev: relStdDevPct(closes),
          });
        })
      );
    }

    const longs = ftPicks.filter((f) => f.signal === 'LONG').slice(0, 7);
    const shorts = ftPicks.filter((f) => f.signal === 'SHORT').slice(0, 7);
    const vols = ftPicks.filter((f) => f.signal === 'NEUTRAL').slice(0, 6);

    const extraDetected = [];
    [...longs, ...shorts, ...vols].forEach((ft) =>
      extraDetected.push({
        symbol: ft.symbol,
        tag: 'FT',
        price: ft.lastPrice,
        stdDev: ft.stdDev,
        quoteVolume: ft.quoteVolume,
        change24hPct: ft.priceChangePercent,
        detectedAt: Date.now(),
        expiresAt: Date.now() + 600_000,
        signal: ft.signal,
        rsi: ft.rsi,
      })
    );

    const payload = buildPayload(extraDetected);
    persistAndBroadcast(payload);

    setTimeout(runScannerJob, Math.max(0, UI_INTERVAL - PRE_WORK_TIME));
  } catch (e) {
    console.error(e);
    setTimeout(runScannerJob, 60_000);
  } finally {
    scanInFlight = false;
  }
}

// --- API ---
app.get('/api/user/status', async (req, res) => {
  const id = req.query.tg_id;
  const hasAccess = await checkUser(id);
  res.json({ isPremium: hasAccess });
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
  const sym = normalizeAiSymbol(req.query.symbol || 'BTCUSDT');
  const limit = Number(req.query.limit || 100);
  const kl = await fetchMexcKlines(sym, '1m', limit);

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

  const sym = normalizeAiSymbol(req.query.symbol || 'BTCUSDT');

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

app.get('/api/scheduler/latest', (req, res) => {
  if (fs.existsSync(DATA_FILE)) res.json(JSON.parse(fs.readFileSync(DATA_FILE)));
  else res.json({});
});

// Front-end serve
app.use(express.static(path.join(__dirname, '../dist')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/events')) return;
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// --- START ---
app.listen(PORT, () => {
  try {
    loadPersistedSignals();
  } catch (_) {}
  console.log(`[server] on ${PORT}`);
  runScannerJob();
});
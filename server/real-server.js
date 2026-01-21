require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { BullishEngulfing, BearishEngulfing, Hammer, ShootingStar, BollingerBands } = require('technicalindicators');
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

// constants
const MIN_PRICE_FT = 0.02;
const MIN_PRICE_AI = 0.10;

const MIN_QUOTEVOL_FT = 700_000;
const MIN_QUOTEVOL_AI = 500_000; // было 1_500_000

const BACKTEST_KLINES = 40;

const CHUNK_SIZE = 15;           // было 20
const FT_CANDIDATES = 35;        // было 60

const UI_INTERVAL = 300_000;
const PRE_WORK_TIME = 45_000;

const HIT_REMOVE_DELAY_MS = 3000;     // авто-удаление через 3 секунды
const ACTIVE_PRICE_POLL_MS = 2000;    // проверка пересечения tp/sl
const MAX_AI_SIGNALS = 2;             // держим ai сигналов (можно поднять)

const SILICON_KEY = process.env.SILICON_KEY || null;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || null;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://vortex-ai-nffc.onrender.com';
const MONGO_URI = process.env.MONGO_URI || null;

const MANAGER_USERNAME = 'meanfive1';
const ADMIN_ID = 8270078362;
const CHANNEL_USERNAME = '@VortexAiOff';

// state
let scanInFlight = false;
const activeSignals = new Map();     // ai signals only
const sseClients = new Set();
const pendingVerifications = new Map();

let lastFtDetected = [];            // сохраняем ft между апдейтами
let lastNextScanAt = Date.now() + UI_INTERVAL;

const removalTimers = new Map();    // symbol -> timeout

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function sseBroadcast(evt, data) {
  const payload = `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(payload); } catch (_) {}
  }
}

function isSaneUsdtSymbol(sym) { return /^[A-Z0-9]{2,}USDT$/.test(sym); }
function isStablecoinLike(sym) { return /USDC|USDP|TUSD|DAI|FDUSD|USD1|USDE|PAXG|EUR|GBP/.test(sym); }
function isLeveraged(sym) { return /(3L|3S|5L|5S|UP|DOWN|BULL|BEAR)USDT$/.test(sym); }

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
  if (klines.length < 5) return null;
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

function normDirection(d) {
  const x = String(d || '').toUpperCase();
  return x === 'SHORT' ? 'SHORT' : 'LONG';
}

function buildForecastPath(lastClose, target, steps = 5) {
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const p = lastClose + (target - lastClose) * (i / steps);
    out.push({ t: Date.now() + i * 60000, close: Number(p) });
  }
  return out;
}

// deepseek + fallback
async function deepseekForecast5(symbol, closes) {
  const lastClose = Number(closes[closes.length - 1] || 0);

  // 1) deepseek
  if (SILICON_KEY) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 20000);

      const system =
        'You are Vortex AI. Output JSON only: { "target_price": number, "stop_loss_price": number, "direction": "LONG"|"SHORT", "confidence": 0-100, "forecast_1m": [ { "close": number }, ...5 ] }';
      const user =
        `Symbol: ${symbol}. Last close: ${lastClose}. Predict 5 minutes ahead.`;

      const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SILICON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-ai/DeepSeek-V3',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        }),
        signal: controller.signal
      });

      clearTimeout(id);

      if (r.ok) {
        const j = await r.json();
        let content = j?.choices?.[0]?.message?.content || '{}';
        if (content.includes('```json')) content = content.split('```json')[1].split('```')[0].trim();

        const parsed = JSON.parse(content);

        if (parsed && parsed.target_price) {
          const target = Number(parsed.target_price);
          const stop = Number(parsed.stop_loss_price || (target > lastClose ? lastClose * 0.995 : lastClose * 1.005));
          const direction = normDirection(parsed.direction);
          const confidence = Number(parsed.confidence || 60);

          let forecastCandles = [];
          if (Array.isArray(parsed.forecast_1m) && parsed.forecast_1m.length) {
            forecastCandles = parsed.forecast_1m.slice(0, 5).map((c, i) => ({
              t: Date.now() + (i + 1) * 60000,
              close: Number(c.close)
            }));
          } else {
            forecastCandles = buildForecastPath(lastClose, target, 5);
          }

          return {
            forecastCandles,
            target_price: Number(target),
            stop_loss_price: Number(stop),
            direction,
            confidence,
            source: 'deepseek'
          };
        }
      }
    } catch (_) {
      // fallback ниже
    }
  }

  // 2) fallback: bollinger
  const bbInput = { period: 20, stdDev: 2, values: closes.map(Number) };
  const bb = BollingerBands.calculate(bbInput);

  let target = lastClose * 1.004;
  let stop = lastClose * 0.996;
  let direction = 'LONG';

  if (bb.length > 0) {
    const lastBB = bb[bb.length - 1];
    direction = lastClose < lastBB.middle ? 'LONG' : 'SHORT';
    target = direction === 'LONG' ? lastBB.upper : lastBB.lower;
    stop = direction === 'LONG' ? lastBB.lower : lastBB.upper;
  }

  return {
    forecastCandles: buildForecastPath(lastClose, target, 5),
    target_price: Number(target.toFixed(10)),
    stop_loss_price: Number(stop.toFixed(10)),
    direction,
    confidence: 55,
    source: 'fallback'
  };
}

// ai picker (упрощён и гарантирует выдачу)
async function pickAiSignals(base) {
  const blacklist = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'USDCUSDT', 'FDUSDUSDT']);

  const candidates = base
    .filter(x =>
      x.symbol.endsWith('USDT') &&
      isSaneUsdtSymbol(x.symbol) &&
      !isStablecoinLike(x.symbol) &&
      !isLeveraged(x.symbol) &&
      !blacklist.has(x.symbol) &&
      x.quoteVolume >= MIN_QUOTEVOL_AI &&
      x.lastPrice >= MIN_PRICE_AI
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, 25);

  const out = [];
  const toCheck = candidates.slice(0, 7);

  for (const c of toCheck) {
    try {
      const kl = await fetchMexcKlines(c.symbol, '1m', 30);
      if (kl.length < 25) continue;

      const closes = kl.map(k => Number(k[4]));
      const stdDev = relStdDevPct(closes);
      if (stdDev < 0.10) continue; // слишком плоско

      // необязательный паттерн, просто для доп инфы (не блокирует)
      const pattern = detectPattern(kl);

      const fc = await deepseekForecast5(c.symbol, closes);
      out.push({
        symbol: c.symbol,
        quoteVolume: c.quoteVolume,
        price: c.lastPrice,
        change24hPct: c.priceChangePercent,
        stdDev,
        pattern: pattern || null,
        ...fc
      });

      if (out.length >= 2) break;
      await sleep(200);
    } catch (_) {}
  }

  return out;
}

// payload builder (чтобы при быстрых апдейтах не терять ft)
function buildPayload(nextScanAt = lastNextScanAt) {
  const aiList = Array.from(activeSignals.values()).map(s => ({
    symbol: s.symbol,
    tag: 'AI',
    price: s.price,
    quoteVolume: s.quoteVolume,
    stdDev: s.stdDev,
    change24hPct: s.change24hPct,
    detectedAt: s.detectedAt,
    addedAt: s.addedAt,
    status: s.status,
    removeAt: s.removeAt || null,
    direction: s.direction,
    target_price: s.target_price,
    stop_loss_price: s.stop_loss_price,
    confidence: s.confidence,
    source: s.source
  }));

  const forecastsBySymbol = {};
  for (const s of activeSignals.values()) {
    forecastsBySymbol[s.symbol] = {
      generatedAt: s.addedAt,
      horizonMinutes: 5,
      candles: s.forecastCandles || [],
      target_price: s.target_price,
      stop_loss_price: s.stop_loss_price,
      direction: s.direction,
      status: s.status,
      source: s.source
    };
  }

  const detected = [...aiList, ...lastFtDetected];

  return {
    ts: new Date().toISOString(),
    nextScanAt,
    parsed: {
      detected,
      forecastsBySymbol
    }
  };
}

function persistAndBroadcast(payload) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(payload)); } catch (_) {}
  sseBroadcast('scheduled_update', payload);
}

function markDoneAndScheduleRemove(sym, status) {
  const sig = activeSignals.get(sym);
  if (!sig) return;
  if (sig.status !== 'ACTIVE') return;

  sig.status = status;
  sig.removeAt = Date.now() + HIT_REMOVE_DELAY_MS;

  // сразу отправляем апдейт, чтобы в ui статус сменился
  persistAndBroadcast(buildPayload(lastNextScanAt));

  if (removalTimers.has(sym)) return;

  const t = setTimeout(() => {
    removalTimers.delete(sym);
    const cur = activeSignals.get(sym);
    if (!cur) return;
    if (cur.removeAt && Date.now() >= cur.removeAt) {
      activeSignals.delete(sym);
      persistAndBroadcast(buildPayload(lastNextScanAt));
    }
  }, HIT_REMOVE_DELAY_MS + 50);

  removalTimers.set(sym, t);
}

// быстрый монитор пересечения tp/sl (каждые 2 сек)
async function monitorActiveSignalsLoop() {
  while (true) {
    try {
      if (activeSignals.size === 0) {
        await sleep(ACTIVE_PRICE_POLL_MS);
        continue;
      }

      // берём 24hr один раз (дешевле, чем дергать по одному символу)
      const all = await fetch24hrTickers();
      if (!all) {
        await sleep(ACTIVE_PRICE_POLL_MS);
        continue;
      }
      const map = new Map(all.map(x => [x.symbol, Number(x.lastPrice)]));

      for (const [sym, sig] of activeSignals.entries()) {
        if (sig.status !== 'ACTIVE') continue;

        const price = map.get(sym);
        if (!price) continue;

        sig.price = price;

        if (sig.direction === 'LONG') {
          if (price >= sig.target_price) markDoneAndScheduleRemove(sym, 'WON');
          else if (price <= sig.stop_loss_price) markDoneAndScheduleRemove(sym, 'LOST');
        } else {
          if (price <= sig.target_price) markDoneAndScheduleRemove(sym, 'WON');
          else if (price >= sig.stop_loss_price) markDoneAndScheduleRemove(sym, 'LOST');
        }
      }
    } catch (_) {
      // ignore
    }

    await sleep(ACTIVE_PRICE_POLL_MS);
  }
}

// db
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('[db] connected'))
    .catch(e => console.error('[db] error', e));
}

const UserSchema = new mongoose.Schema({
  tgId: { type: String, unique: true },
  isPremium: Boolean,
  expiresAt: Number,
  language: { type: String, default: 'ru' },
  notificationsEnabled: { type: Boolean, default: true },
  firstName: String,
  username: String
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

async function activateUser(id) {
  try {
    await User.findOneAndUpdate(
      { tgId: String(id) },
      { isPremium: true, expiresAt: Date.now() + 30 * 24 * 3600000 },
      { upsert: true }
    );
  } catch (_) {}
}

async function checkUser(id) {
  try {
    const u = await User.findOne({ tgId: String(id) });
    return !!(u && u.isPremium && u.expiresAt > Date.now());
  } catch (_) {
    return false;
  }
}

let notifyProUsers = async () => {};

// texts (без **markdown**)
const TEXTS = {
  ru: {
    welcome: "Добро пожаловать в Vortex AI.\n\nПодпишитесь на канал, чтобы продолжить.",
    sub_check: "Проверить подписку",
    sub_error: "Вы не подписаны на канал. Подпишитесь, чтобы пользоваться ботом.",
    lang_select: "Выберите язык / Select Language:",
    menu: { app: "Vortex App", premium: "Premium", market: "Рынок", settings: "Настройки", help: "Помощь" },
    market: "Сканирую рынок...",
    premium_status: "Ваш статус: PRO",
    premium_buy: "Vortex PRO\n\n- AI сигналы\n- без задержек\n- полный доступ\n\nЦена: 1000 RUB / 1 месяц",
    pay_methods: { crypto: "Крипта (USDT)", stars: "Telegram Stars", card: "Карта РФ" },
    disclaimer: "Дисклеймер\n\n1) Риски: торговля криптовалютой рискованна.\n2) Гарантий нет: сигналы — прогнозы, не финсовет.\n3) Возвратов нет.\n\nНажимая оплатить, вы соглашаетесь с условиями.",
    agree_pay: "Согласен, оплатить",
    manual_pay: "Способ оплаты: перевод на карту\nСумма: 1000 RUB\n\nНапишите менеджеру по кнопке ниже.\n\nПосле оплаты вернитесь и нажмите: Я оплатил. Затем отправьте скриншот.\n\nДоступ выдаётся в течение 5 минут.",
    btn_manager: "Написать менеджеру",
    btn_paid: "Я оплатил",
    btn_back: "Назад",
    settings: "Настройки",
    alerts: "Уведомления AI:",
    lang_btn: "Сменить язык",
    profile: "Профиль",
    no_sub: "нет подписки",
    days_left: "дней",
    buy_btn: "Купить Premium",
    help: "Помощь\n\n- AI signals: входы от модели\n- FT: зоны rsi\n\nSupport: @meanfive1",
    app_desc: "Vortex Web App\n\nНажмите кнопку ниже, чтобы запустить:"
  },
  en: {
    welcome: "Welcome to Vortex AI.\n\nPlease subscribe to our channel to continue.",
    sub_check: "Check subscription",
    sub_error: "You are not subscribed. Please join the channel to use the bot.",
    lang_select: "Select language:",
    menu: { app: "Vortex App", premium: "Premium", market: "Market", settings: "Settings", help: "Help" },
    app_desc: "Vortex Web App\n\nClick below to launch:",
    market: "Scanning...",
    premium_status: "Your status: PRO",
    premium_buy: "Vortex PRO\n\n- AI signals\n- zero latency\n- full access\n\nPrice: $10 / 1 month",
    pay_methods: { crypto: "Crypto (USDT)", stars: "Telegram Stars", card: "Bank card" },
    disclaimer: "Legal disclaimer\n\n1) Risk: crypto trading is risky.\n2) No guarantees: signals are forecasts, not financial advice.\n3) No refunds.\n\nBy clicking pay, you agree to these terms.",
    agree_pay: "I agree, pay",
    manual_pay: "Payment method: bank card\nPrice: $10\n\nContact manager below.\n\nAfter payment, come back and click: I paid. Then send a screenshot.\n\nAccess within 5 minutes.",
    btn_manager: "Contact manager",
    btn_paid: "I paid",
    btn_back: "Back",
    settings: "Settings",
    alerts: "AI alerts:",
    lang_btn: "Change language",
    profile: "Profile",
    no_sub: "no subscription",
    days_left: "days",
    buy_btn: "Buy Premium",
    help: "Help\n\n- AI signals: model entries\n- FT: rsi zones\n\nSupport: @meanfive1"
  }
};

// telegram bot
if (TG_BOT_TOKEN) {
  try {
    const bot = new Telegraf(TG_BOT_TOKEN);

    const getMenu = (lang) => {
      const T = TEXTS[lang] || TEXTS.ru;
      return Markup.keyboard([
        [T.menu.app, T.menu.premium],
        [T.menu.market, T.menu.settings],
        [T.menu.help]
      ]).resize();
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
            return ctx.reply(T.sub_error, Markup.inlineKeyboard([
              Markup.button.url('Channel', `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`),
              Markup.button.callback(T.sub_check, 'check_sub')
            ]));
          }
        } catch (_) {}
      }
      return next();
    });

    notifyProUsers = async (message) => {
      try {
        const users = await User.find({ isPremium: true, notificationsEnabled: true }).lean().exec();
        for (const u of users) {
          try { await bot.telegram.sendMessage(u.tgId, message); } catch (_) {}
        }
      } catch (_) {}
    };

    bot.command('start', async (ctx) => {
      await ctx.reply('Choose language / Выберите язык', Markup.inlineKeyboard([
        Markup.button.callback('Русский', 'lang_ru'),
        Markup.button.callback('English', 'lang_en')
      ]));
    });

    bot.action(/^lang_(.+)$/, async (ctx) => {
      const lang = ctx.match[1];
      await User.findOneAndUpdate({ tgId: String(ctx.from.id) }, { language: lang }, { upsert: true });
      await ctx.answerCbQuery();
      try { await ctx.deleteMessage(); } catch (_) {}
      const T = TEXTS[lang] || TEXTS.ru;
      await ctx.reply(T.welcome, getMenu(lang));
    });

    bot.action('check_sub', async (ctx) => {
      await ctx.answerCbQuery();
      try { await ctx.deleteMessage(); } catch (_) {}
      await ctx.reply('ok');
    });

    bot.hears([/Vortex App/i, /Открыть/i, /Terminal/i], async (ctx) => {
      const T = await getT(ctx);
      ctx.reply(T.app_desc, Markup.inlineKeyboard([Markup.button.webApp(T.menu.app, WEBAPP_URL)]));
    });

    bot.hears([/Профиль/i, /Profile/i], async (ctx) => {
      const T = await getT(ctx);
      const u = await User.findOne({ tgId: String(ctx.from.id) });
      const isPro = u && u.isPremium && u.expiresAt > Date.now();
      let statusText = T.no_sub;
      if (isPro) {
        const days = Math.ceil((u.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
        statusText = `pro (${days} ${T.days_left})`;
      }
      ctx.reply(`${T.profile}\n\nid: ${ctx.from.id}\nuser: @${ctx.from.username || 'unknown'}\nstatus: ${statusText}`);
    });

    bot.hears([/Настройки/i, /Settings/i], async (ctx) => {
      const T = await getT(ctx);
      const u = await User.findOne({ tgId: String(ctx.from.id) });
      const s = u?.notificationsEnabled ? 'on' : 'off';
      ctx.reply(`${T.settings}\n\n${T.alerts} ${s}`, Markup.inlineKeyboard([
        [Markup.button.callback(T.lang_btn, 'change_lang')],
        [Markup.button.callback('toggle alerts', 'toggle_alerts')]
      ]));
    });

    bot.action('change_lang', (ctx) => {
      ctx.reply('Choose language / Выберите язык', Markup.inlineKeyboard([
        Markup.button.callback('Русский', 'lang_ru'),
        Markup.button.callback('English', 'lang_en')
      ]));
    });

    bot.action('toggle_alerts', async (ctx) => {
      const u = await User.findOne({ tgId: String(ctx.from.id) });
      if (!u?.isPremium) return ctx.answerCbQuery('pro only');
      u.notificationsEnabled = !u.notificationsEnabled;
      await u.save();
      ctx.answerCbQuery(u.notificationsEnabled ? 'on' : 'off');
    });

    bot.hears([/Premium/i, /Премиум/i], async (ctx) => {
      const T = await getT(ctx);
      const ok = await checkUser(ctx.from.id);
      if (ok) return ctx.reply('status: pro');
      await ctx.reply(T.disclaimer, Markup.inlineKeyboard([
        [Markup.button.callback(T.agree_pay, 'show_pay')]
      ]));
    });

    bot.action('show_pay', async (ctx) => {
      const T = await getT(ctx);
      await ctx.editMessageText(T.premium_buy, Markup.inlineKeyboard([
        [Markup.button.callback(T.pay_methods.card, 'pay_manager')],
        [Markup.button.callback(T.pay_methods.crypto, 'pay_manager')],
        [Markup.button.callback(T.pay_methods.stars, 'pay_stars')]
      ]));
    });

    bot.action('pay_manager', async (ctx) => {
      const T = await getT(ctx);
      const msg = (T === TEXTS.en) ? 'Hello, I want to buy Premium.' : 'Привет, нужны реквизиты для оплаты переводом на карту.';
      const link = `https://t.me/${MANAGER_USERNAME}?text=${encodeURIComponent(msg)}`;
      await ctx.editMessageText(T.manual_pay, Markup.inlineKeyboard([
        [Markup.button.url(T.btn_manager, link)],
        [Markup.button.callback(T.btn_paid, 'paid_manual')],
        [Markup.button.callback(T.btn_back, 'show_pay')]
      ]));
    });

    bot.action('paid_manual', async (ctx) => {
      const T = await getT(ctx);
      await ctx.answerCbQuery();
      await ctx.reply((T === TEXTS.en) ? 'Send payment screenshot.' : 'Отправьте скриншот оплаты.');
      pendingVerifications.set(ctx.from.id, true);
    });

    bot.on('photo', async (ctx) => {
      if (!pendingVerifications.get(ctx.from.id)) return;
      pendingVerifications.delete(ctx.from.id);

      await ctx.reply('verifying...');
      await bot.telegram.sendPhoto(ADMIN_ID, ctx.message.photo[ctx.message.photo.length - 1].file_id, {
        caption: `payment from ${ctx.from.first_name || ''} (id: ${ctx.from.id})`,
        ...Markup.inlineKeyboard([
          Markup.button.callback('approve', `approve_${ctx.from.id}`),
          Markup.button.callback('reject', `reject_${ctx.from.id}`)
        ])
      });
    });

    bot.action(/^approve_(\d+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await activateUser(userId);
      await bot.telegram.sendMessage(userId, 'premium activated');
      await ctx.editMessageCaption((ctx.callbackQuery.message.caption || '') + '\napproved');
    });

    bot.action(/^reject_(\d+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await bot.telegram.sendMessage(userId, 'payment rejected');
      await ctx.editMessageCaption((ctx.callbackQuery.message.caption || '') + '\nrejected');
    });

    bot.hears(/Market|Рынок/i, async (ctx) => {
      const T = await getT(ctx);
      const msg = await ctx.reply(T.market);
      try {
        const all = await fetch24hrTickers();
        if (!all) throw new Error('api fail');

        const btc = all.find(x => x.symbol === 'BTCUSDT');
        const gainers = all
          .filter(x => x.symbol.endsWith('USDT') && Number(x.quoteVolume) > 1000000)
          .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent))
          .slice(0, 3);

        const losers = all
          .filter(x => x.symbol.endsWith('USDT') && Number(x.quoteVolume) > 1000000)
          .sort((a, b) => Number(a.priceChangePercent) - Number(b.priceChangePercent))
          .slice(0, 3);

        let text = `market overview\n\n`;
        if (btc) text += `btc: ${Number(btc.lastPrice).toFixed(0)} (${Number(btc.priceChangePercent).toFixed(2)}%)\n\n`;

        text += `top gainers:\n`;
        gainers.forEach(c => text += `- ${c.symbol.replace('USDT', '')}: +${Number(c.priceChangePercent).toFixed(1)}%\n`);

        text += `\ntop losers:\n`;
        losers.forEach(c => text += `- ${c.symbol.replace('USDT', '')}: ${Number(c.priceChangePercent).toFixed(1)}%\n`);

        ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, text);
      } catch (_) {
        try { ctx.deleteMessage(msg.message_id); } catch (_) {}
        ctx.reply('market data unavailable');
      }
    });

    bot.hears(/Help|Помощь/i, async (ctx) => {
      const T = await getT(ctx);
      ctx.reply(T.help);
    });

    // admin
    bot.command('admin', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return;
      const count = await User.countDocuments().catch(() => 0);
      const pros = await User.countDocuments({ isPremium: true }).catch(() => 0);
      ctx.reply(`admin\nusers: ${count}\npro: ${pros}\n\n/give <id>\n/force <symbol>`, Markup.inlineKeyboard([
        Markup.button.callback('force random ai', 'force_random')
      ]));
    });

    bot.command('give', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return;
      const id = ctx.message.text.split(' ')[1];
      if (id) { await activateUser(id); ctx.reply(`given: ${id}`); }
    });

    bot.action('force_random', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.answerCbQuery('unauthorized');

      const all = await fetch24hrTickers();
      const liquid = (all || [])
        .map(x => ({ symbol: x.symbol, quoteVolume: Number(x.quoteVolume), lastPrice: Number(x.lastPrice) }))
        .filter(t => t.symbol.endsWith('USDT') && t.quoteVolume > 1_000_000 && t.lastPrice > 0)
        .sort(() => Math.random() - 0.5);

      const sym = liquid[0]?.symbol || 'BTCUSDT';
      const k = await fetchMexcKlines(sym, '1m', 30);
      if (k.length < 25) return ctx.answerCbQuery('no data');

      const price = Number(k[k.length - 1][4]);
      const closes = k.map(x => Number(x[4]));
      const fc = await deepseekForecast5(sym, closes);

      const signal = {
        symbol: sym,
        tag: 'AI',
        price,
        target_price: fc.target_price,
        stop_loss_price: fc.stop_loss_price,
        direction: fc.direction,
        confidence: fc.confidence,
        forecastCandles: fc.forecastCandles,
        detectedAt: Date.now(),
        status: 'ACTIVE',
        addedAt: Date.now(),
        stdDev: relStdDevPct(closes),
        quoteVolume: liquid[0]?.quoteVolume || 0,
        source: fc.source,
        change24hPct: 0
      };

      activeSignals.set(sym, signal);

      persistAndBroadcast(buildPayload(lastNextScanAt));
      await ctx.answerCbQuery(`forced ${sym}`);
      await ctx.editMessageText(`forced ai: ${sym}`);
    });

    bot.command('force', async (ctx) => {
      if (String(ctx.from.id) !== String(ADMIN_ID)) return;

      const sym = (ctx.message.text.split(' ')[1] || 'BTCUSDT').toUpperCase();
      const k = await fetchMexcKlines(sym, '1m', 30);
      if (k.length < 25) return ctx.reply('no data for ' + sym);

      const price = Number(k[k.length - 1][4]);
      const closes = k.map(x => Number(x[4]));
      const fc = await deepseekForecast5(sym, closes);

      const signal = {
        symbol: sym,
        tag: 'AI',
        price,
        target_price: fc.target_price,
        stop_loss_price: fc.stop_loss_price,
        direction: fc.direction,
        confidence: fc.confidence,
        forecastCandles: fc.forecastCandles,
        detectedAt: Date.now(),
        status: 'ACTIVE',
        addedAt: Date.now(),
        stdDev: relStdDevPct(closes),
        quoteVolume: 0,
        source: fc.source,
        change24hPct: 0
      };

      activeSignals.set(sym, signal);
      persistAndBroadcast(buildPayload(lastNextScanAt));
      ctx.reply(`forced: ${sym} ${fc.direction}`);
    });

    bot.launch().then(() => console.log('[bot] started'));
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (e) {
    console.error('[bot] error', e);
  }
}

// persistence
function loadPersistedSignals() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const latest = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

    lastNextScanAt = latest.nextScanAt || (Date.now() + UI_INTERVAL);

    const detected = latest.parsed?.detected || [];
    const forecasts = latest.parsed?.forecastsBySymbol || {};

    // восстановим ft
    lastFtDetected = detected.filter(x => x.tag === 'FT');

    // восстановим ai
    for (const d of detected) {
      if (d.tag !== 'AI') continue;
      const f = forecasts[d.symbol];
      activeSignals.set(d.symbol, {
        symbol: d.symbol,
        tag: 'AI',
        price: Number(d.price),
        quoteVolume: Number(d.quoteVolume || 0),
        stdDev: Number(d.stdDev || 0),
        change24hPct: Number(d.change24hPct || 0),
        detectedAt: Number(d.detectedAt || Date.now()),
        addedAt: Number(d.addedAt || Date.now()),
        status: d.status || 'ACTIVE',
        removeAt: d.removeAt || null,
        direction: normDirection(d.direction),
        target_price: Number(d.target_price),
        stop_loss_price: Number(d.stop_loss_price),
        confidence: Number(d.confidence || 0),
        source: d.source || 'persist',
        forecastCandles: f?.candles || []
      });
    }
  } catch (_) {}
}

// scanner
async function runScannerJob() {
  if (scanInFlight) return;
  scanInFlight = true;

  try {
    const all = await fetch24hrTickers();
    if (!all) throw new Error('mexc api fail');

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
        !isLeveraged(x.symbol)
      );

    const baseMap = new Map(base.map(b => [b.symbol, b]));

    // обновим цены ai и если где-то уже статус не ACTIVE — подчистит монитор (через 3 сек)
    for (const [sym, sig] of activeSignals.entries()) {
      const tick = baseMap.get(sym);
      if (!tick) continue;
      sig.price = Number(tick.lastPrice);
      sig.quoteVolume = Number(tick.quoteVolume || sig.quoteVolume || 0);
      sig.change24hPct = Number(tick.priceChangePercent || sig.change24hPct || 0);
    }

    // добор ai (исправлено: теперь не будет "0 ai" постоянно)
    if (activeSignals.size < MAX_AI_SIGNALS) {
      const need = MAX_AI_SIGNALS - activeSignals.size;
      const picks = await pickAiSignals(base);

      for (const p of picks) {
        if (activeSignals.size >= MAX_AI_SIGNALS) break;
        if (activeSignals.has(p.symbol)) continue;

        activeSignals.set(p.symbol, {
          symbol: p.symbol,
          tag: 'AI',
          price: Number(p.price),
          quoteVolume: Number(p.quoteVolume),
          stdDev: Number(p.stdDev || 0),
          change24hPct: Number(p.change24hPct || 0),
          detectedAt: Date.now(),
          addedAt: Date.now(),
          status: 'ACTIVE',
          direction: normDirection(p.direction),
          target_price: Number(p.target_price),
          stop_loss_price: Number(p.stop_loss_price),
          confidence: Number(p.confidence || 0),
          source: p.source || 'unknown',
          forecastCandles: p.forecastCandles || [],
          pattern: p.pattern || null
        });

        // можно убрать вообще уведомления, но оставлю без эмодзи
        await notifyProUsers(`new ai signal: ${p.symbol} ${normDirection(p.direction)}\ntp: ${p.target_price}\nsl: ${p.stop_loss_price}`);
      }
    }

    // ft picks (облегчил)
    const ftPicks = [];
    const ftCandidates = base
      .filter(x => x.quoteVolume >= MIN_QUOTEVOL_FT && x.lastPrice >= MIN_PRICE_FT && !activeSignals.has(x.symbol))
      .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
      .slice(0, FT_CANDIDATES);

    for (let i = 0; i < ftCandidates.length; i += CHUNK_SIZE) {
      const chunk = ftCandidates.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map(async (t) => {
        const k = await fetchMexcKlines(t.symbol, '1m', 20);
        if (k.length < 15) return;

        const closes = k.map(x => Number(x[4]));
        const rsi = calculateRSI(closes, 14);

        let signal = 'NEUTRAL';
        if (rsi < 35) signal = 'LONG';
        if (rsi > 65) signal = 'SHORT';

        ftPicks.push({
          symbol: t.symbol,
          tag: 'FT',
          price: t.lastPrice,
          stdDev: relStdDevPct(closes),
          quoteVolume: t.quoteVolume,
          change24hPct: t.priceChangePercent,
          detectedAt: Date.now(),
          expiresAt: Date.now() + 600000,
          signal,
          rsi
        });
      }));
    }

    const longs = ftPicks.filter(f => f.signal === 'LONG').slice(0, 7);
    const shorts = ftPicks.filter(f => f.signal === 'SHORT').slice(0, 7);
    const vols = ftPicks.filter(f => f.signal === 'NEUTRAL').slice(0, 6);

    lastFtDetected = [...longs, ...shorts, ...vols];

    lastNextScanAt = Date.now() + UI_INTERVAL;

    const payload = buildPayload(lastNextScanAt);
    persistAndBroadcast(payload);

    setTimeout(runScannerJob, Math.max(0, UI_INTERVAL - PRE_WORK_TIME));
  } catch (e) {
    console.error('[scanner] error', e?.message || e);
    setTimeout(runScannerJob, 60000);
  } finally {
    scanInFlight = false;
  }
}

// api
app.get('/api/user/status', async (req, res) => {
  const id = req.query.tg_id;
  const hasAccess = await checkUser(id);
  res.json({ isPremium: hasAccess });
});

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  sseClients.add(res);

  // отправим последнее состояние
  try {
    if (fs.existsSync(DATA_FILE)) {
      res.write(`event: scheduled_update\ndata: ${fs.readFileSync(DATA_FILE, 'utf8')}\n\n`);
    } else {
      res.write(`event: scheduled_update\ndata: ${JSON.stringify(buildPayload(lastNextScanAt))}\n\n`);
    }
  } catch (_) {}

  req.on('close', () => {
    sseClients.delete(res);
    try { res.end(); } catch (_) {}
  });
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
    close: Number(k[4])
  })));
});

app.get('/api/live/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
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
        close: Number(kl[0][4])
      })}\n\n`);
    }
  }, 2000);

  req.on('close', () => clearInterval(iv));
});

app.get('/api/scheduler/latest', (req, res) => {
  try {
    if (fs.existsSync(DATA_FILE)) return res.json(JSON.parse(fs.readFileSync(DATA_FILE)));
  } catch (_) {}
  res.json(buildPayload(lastNextScanAt));
});

// front
app.use(express.static(path.join(__dirname, '../dist')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/events')) return;
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// start
app.listen(PORT, () => {
  loadPersistedSignals();
  console.log(`[server] on ${PORT}`);

  runScannerJob();
  monitorActiveSignalsLoop(); // важно: авто-удаление по tp/sl через 3 сек
});
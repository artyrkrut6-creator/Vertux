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

// --- CONSTANTS ---
const MIN_PRICE_FT = 0.02;
const MIN_PRICE_AI = 0.10;
const MIN_QUOTEVOL_FT = 700_000;
const MIN_QUOTEVOL_AI = 1_500_000;
const MAX_SPREAD_FT_PCT = 0.50;
const MAX_SPREAD_AI_PCT = 0.60;
const MIN_DEPTH_FT_USDT = 10_000;
const MIN_DEPTH_AI_USDT = 5_000;
const BACKTEST_MEAN_PCT = 0.60;
const BACKTEST_KLINES = 40;
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

// --- STATE ---
let scanInFlight = false;
const activeSignals = new Map();
const sseClients = new Set();
const pendingVerifications = new Map();
const lastDemoteReasonCounts = { lowPriceVol:0, spreadDepth:0, stddev:0, backtestError:0, backtestThreshold:0, directionalFail:0, insufficientKlines:0, sawtooth:0 };

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
  return (Math.sqrt(closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / closes.length) / mean) * 100;
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
  return 100 - (100 / (1 + avgGain / avgLoss));
}

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
        if ((last.upper - last.lower) / (last.middle || 1) < 0.015) return "Bollinger Squeeze";
    }
    return null;
}

// --- DEEPSEEK ---
async function deepseekForecast5(symbol, contextCandles, patternName) {
  if (!SILICON_KEY) return null;
  const system = `You are Vortex AI. Your goal: Find a sniper entry point on MEXC.
A technical pattern "${patternName || 'High Volatility'}" has been detected.
TASK: Analyze 50 candles. Determine direction (LONG/SHORT). Calculate TARGET PRICE and STOP LOSS.
JSON OUTPUT FORMAT: { "target_price": number, "stop_loss_price": number, "direction": "LONG"|"SHORT", "confidence": 0-100, "forecast_1m": [ ... ] }`;
  const user = `Symbol: ${symbol}. Last close: ${contextCandles[contextCandles.length-1].close}. Predict now.`;
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
    return {
        candles: parsed.forecast_1m.map((c, i) => ({ t: Date.now() + (i+1)*60000, close: Number(c.close) })),
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
    const adaptiveSteps = [
        { gates: { maxSpreadPct: MAX_SPREAD_AI_PCT, minDepth: MIN_DEPTH_AI_USDT, stddevMax: 0.35, backtestMean: BACKTEST_MEAN_PCT } },
        { gates: { maxSpreadPct: MAX_SPREAD_AI_PCT, minDepth: MIN_DEPTH_AI_USDT, stddevMax: 0.50, backtestMean: BACKTEST_MEAN_PCT } }
    ];
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
            const pattern = detectPattern(kl);
            if (!pattern) return null;
            const ds = await deepseekForecast5(candidate.symbol, kl.map(k=>({close:Number(k[4])})), pattern);
            if (!ds || ds.confidence < 60) return null;
            return { ...candidate, ...ds };
        } catch (e) { return null; }
    }));
    results.filter(r => r).forEach(v => accepted.push(v));
    if (accepted.length >= 1) break; 
  }
  return accepted.slice(0, 2);
}

// --- DB & USER ---
if (MONGO_URI) {
  mongoose.connect(MONGO_URI).then(()=>console.log('[DB] Connected')).catch(e=>console.error('[DB] Error', e));
}
const UserSchema = new mongoose.Schema({ 
    tgId: { type: String, unique: true }, 
    isPremium: Boolean, 
    expiresAt: Number, 
    language: { type: String, enum: ['ru','en'], default: 'ru' },
    notificationsEnabled: { type: Boolean, default: true },
    firstName: String, 
    username: String 
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

async function activateUser(id) {
  try { await User.findOneAndUpdate({ tgId: String(id) }, { isPremium: true, expiresAt: Date.now() + 30*24*3600000 }, { upsert: true }); } catch(e){}
}
async function checkUser(id) {
  try { const u = await User.findOne({ tgId: String(id) }); return u && u.isPremium && u.expiresAt > Date.now(); } catch(e){ return false; }
}

let notifyProUsers = async (message) => { console.log('[notifyProUsers] noop', message); };

// --- TEXTS ---
const TEXTS = {
    ru: {
        welcome: "👋 Добро пожаловать в Vortex AI!",
        sub_check: "🔄 Проверить подписку",
        sub_error: "❌ Вы не подписаны на канал. Подпишитесь, чтобы пользоваться ботом.",
        lang_select: "🌐 Выберите язык / Select Language:",
        menu: { app: "📱 Vortex App", premium: "💎 Premium", profile: "👤 Профиль", settings: "⚙️ Настройки" },
        market: "🔄 Сканирую рынок...",
        premium_status: "✅ Ваш статус: PRO",
        premium_buy: "💎 **VORTEX PRO**\n\n• AI Снайпер Сигналы\n• Без задержек\n• Полный доступ\n\n**Цена:** 1000 RUB / 1 Месяц",
        pay_methods: { crypto: "💠 Крипта (USDT)", stars: "⭐️ Telegram Stars", card: "💳 Карта РФ" },
        disclaimer: "⚠️ **ЮРИДИЧЕСКИЙ ДИСКЛЕЙМЕР**\n\n1. **Риски:** Торговля криптовалютой сопряжена с высоким риском. Вы можете потерять вложения.\n2. **Гарантии:** Сигналы Vortex AI — это прогнозы, а не финансовые советы. Мы не гарантируем прибыль.\n3. **Возврат:** Средства за подписку не возвращаются.\n\nНажимая кнопку оплаты, вы соглашаетесь с этими условиями.",
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
        help: "📚 **ПОМОЩЬ**\n\n• **AI Signals:** Снайперские входы от DeepSeek.\n• **FT:** Зоны перекупленности/перепроданности.\n\nSupport: @meanfive1"
    },
    en: {
        welcome: "👋 Welcome to Vortex AI!",
        sub_check: "🔄 Check Subscription",
        sub_error: "❌ You are not subscribed. Please join to use the bot.",
        lang_select: "🌐 Select Language:",
        menu: { app: "📱 Vortex App", premium: "💎 Premium", profile: "👤 Profile", settings: "⚙️ Settings" },
        market: "🔄 Scanning...",
        premium_status: "✅ Your Status: PRO",
        premium_buy: "💎 **VORTEX PRO**\n\n• AI Sniper Signals\n• Zero Latency\n• Full Access\n\n**Price:** $10 / 1 Month",
        pay_methods: { crypto: "💠 Crypto (USDT)", stars: "⭐️ Telegram Stars", card: "💳 Bank Card" },
        disclaimer: "⚠️ **LEGAL DISCLAIMER**\n\n1. **Risk:** Crypto trading involves high risk. You may lose your investment.\n2. **No Guarantees:** Vortex AI signals are forecasts, NOT financial advice.\n3. **No Refunds:** All sales are final.\n\nBy clicking pay, you agree to these terms.",
        agree_pay: "✅ I Agree & Pay",
        manual_pay: "💳 **Payment Method: Bank Card**\n💰 **Price:** $10\n\n👋 Contact manager below for details.\n\n🍇 **AFTER PAYMENT** — come back and click **\"✅ I Paid\"**. Then send a screenshot.\n\n_Access granted within 5 mins._",
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

// --- TELEGRAM BOT ---
if (TG_BOT_TOKEN) {
    try {
        const bot = new Telegraf(TG_BOT_TOKEN);

        // Helper to get text based on user lang
        const getT = async (ctx) => {
            const u = await User.findOne({ tgId: String(ctx.from.id) });
            return TEXTS[u?.language || 'ru'];
        };

        // KEYBOARDS
        const getMenu = (T) => Markup.keyboard([
            [T.menu.app],
            [T.menu.profile, T.menu.settings],
            [T.menu.premium] // Moved Premium to bottom row
        ]).resize();

        // MIDDLEWARE: SAVE USER
        bot.use(async (ctx, next) => {
            if (ctx.from) {
                try {
                    await User.findOneAndUpdate(
                        { tgId: String(ctx.from.id) },
                        { firstName: ctx.from.first_name, username: ctx.from.username },
                        { upsert: true }
                    );
                } catch(e){}
            }
            return next();
        });

        // NOTIFIER
        notifyProUsers = async (message) => {
          try {
            const users = await User.find({ isPremium: true, notificationsEnabled: true }).lean().exec();
            for (const u of users) { try { await bot.telegram.sendMessage(u.tgId, message); } catch (e) {} }
          } catch (e) { console.warn('Notify Error:', e); }
        };

        // START
        bot.command('start', async (ctx) => {
            const uid = String(ctx.from.id);
            let u = await User.findOne({ tgId: uid }).exec();
            if (!u || !u.language) {
                await ctx.reply('🌐 Choose language / Выберите язык', Markup.inlineKeyboard([
                    Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
                    Markup.button.callback('🇺🇸 English', 'lang_en')
                ]));
            } else {
                const T = TEXTS[u.language];
                await ctx.reply(T.welcome, getMenu(T));
            }
        });

        // LANGUAGE SELECTION
        bot.action('lang_ru', async (ctx) => {
            await User.findOneAndUpdate({ tgId: String(ctx.from.id) }, { language: 'ru' }, { upsert: true });
            await ctx.answerCbQuery();
            const T = TEXTS['ru'];
            await ctx.reply(T.welcome, getMenu(T));
        });
        bot.action('lang_en', async (ctx) => {
            await User.findOneAndUpdate({ tgId: String(ctx.from.id) }, { language: 'en' }, { upsert: true });
            await ctx.answerCbQuery();
            const T = TEXTS['en'];
            await ctx.reply(T.welcome, getMenu(T));
        });

        // APP BUTTON HANDLER (CHECK SUBSCRIPTION HERE)
        bot.hears(/📱 Vortex App|🚀 Open Terminal/, async (ctx) => {
            const T = await getT(ctx);
            // Check Channel Sub
            try {
                const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, ctx.from.id);
                if (['left', 'kicked'].includes(member.status)) {
                    return ctx.reply(T.sub_error, Markup.inlineKeyboard([
                        Markup.button.url('📢 Channel', `https://t.me/${CHANNEL_USERNAME.replace('@','')}`),
                        Markup.button.callback(T.sub_check, 'check_sub')
                    ]));
                }
            } catch (e) { /* admin rights issue or channel invalid - skip check */ }

            ctx.reply('🚀 Launch:', Markup.inlineKeyboard([Markup.button.webApp(T.menu.app, WEBAPP_URL)]));
        });

        bot.action('check_sub', (ctx) => ctx.deleteMessage());

        // PROFILE
        bot.hears(/👤 Профиль|👤 Profile/, async (ctx) => {
            const T = await getT(ctx);
            const u = await User.findOne({ tgId: String(ctx.from.id) });
            const isPro = u && u.isPremium && u.expiresAt > Date.now();
            let statusText = T.no_sub;
            if (isPro) {
                const days = Math.ceil((u.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
                statusText = `PRO (${days} ${T.days_left})`;
            }
            
            await ctx.reply(
                `${T.profile}\n\n🆔 ID: \`${ctx.from.id}\`\n👤 User: @${ctx.from.username}\n💎 Status: ${statusText}`,
                { parse_mode: 'Markdown', ...(!isPro ? Markup.inlineKeyboard([Markup.button.callback(T.buy_btn, 'show_payment_methods')]) : {}) }
            );
        });

        // SETTINGS
        bot.hears(/⚙️ Настройки|⚙️ Settings/, async (ctx) => {
            const T = await getT(ctx);
            const u = await User.findOne({ tgId: String(ctx.from.id) });
            const s = u?.notificationsEnabled ? '✅ ON' : '❌ OFF';
            
            // Allow settings for everyone, but toggle only for PRO
            await ctx.reply(
                `${T.settings}\n\n${T.alerts} ${s}`,
                Markup.inlineKeyboard([
                    [Markup.button.callback(T.lang_btn, 'change_lang')],
                    [Markup.button.callback(u?.notificationsEnabled ? '🔕 Disable Alerts' : '🔔 Enable Alerts', 'toggle_alerts')]
                ])
            );
        });

        bot.action('change_lang', (ctx) => {
            ctx.reply('🌐 Choose language / Выберите язык', Markup.inlineKeyboard([
                Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
                Markup.button.callback('🇺🇸 English', 'lang_en')
            ]));
        });

        bot.action('toggle_alerts', async (ctx) => {
            const u = await User.findOne({ tgId: String(ctx.from.id) });
            const T = TEXTS[u?.language || 'ru'];
            
            if (!u || !u.isPremium) return ctx.answerCbQuery('🔒 PRO Only');
            u.notificationsEnabled = !u.notificationsEnabled;
            await u.save();
            ctx.editMessageText(`${T.settings}\n\n${T.alerts} ${u.notificationsEnabled ? '✅ ON' : '❌ OFF'}`, 
                Markup.inlineKeyboard([
                    [Markup.button.callback(T.lang_btn, 'change_lang')],
                    [Markup.button.callback(u.notificationsEnabled ? '🔕 Disable Alerts' : '🔔 Enable Alerts', 'toggle_alerts')]
                ])
            );
        });

        // PREMIUM
        bot.hears(/💎 Premium|💎 Премиум/, async (ctx) => {
            const T = await getT(ctx);
            const u = await checkUser(ctx.from.id);
            if (u) return ctx.reply('✅ You are PRO.');
            await ctx.reply(T.disclaimer, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(T.agree_pay, 'show_payment_methods')]]) });
        });

        bot.action('show_payment_methods', async (ctx) => {
            const T = await getT(ctx);
            await ctx.editMessageText(T.premium_buy, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(T.pay_methods.card, 'pay_manager')],
                    [Markup.button.callback(T.pay_methods.crypto, 'pay_manager')],
                    [Markup.button.callback(T.pay_methods.stars, 'pay_stars')]
                ])
            });
        });

        bot.action('pay_manager', async (ctx) => {
            const T = await getT(ctx);
            const msg = `Привет.\n\nНужны реквизиты для оплаты переводом на карту.`;
            const encoded = encodeURIComponent(msg);
            const managerLink = `https://t.me/${MANAGER_USERNAME}?text=${encoded}`;

            ctx.editMessageText(T.manual_pay, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.url(T.btn_manager, managerLink)],
                    [Markup.button.callback(T.btn_paid, 'paid_manual')],
                    [Markup.button.callback(T.btn_back, 'show_payment_methods')]
                ])
            });
        });

        bot.action('pay_stars', async (ctx) => {
            return ctx.replyWithInvoice({
                chat_id: ctx.from.id, title: 'Vortex PRO', description: '1 Month Access', payload: 'vortex_pro',
                provider_token: '', currency: 'XTR', prices: [{ label: '1 Month', amount: 500 }]
            });
        });

        bot.action('paid_manual', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.reply('📸 Screenshot please / Скриншот пожалуйста');
            pendingVerifications.set(ctx.from.id, true);
        });

        // ADMIN APPROVAL
        bot.on('photo', async (ctx) => {
            if (pendingVerifications.get(ctx.from.id)) {
                pendingVerifications.delete(ctx.from.id);
                const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                await ctx.reply('⏳ Wait for admin...');
                await bot.telegram.sendPhoto(ADMIN_ID, photoId, {
                    caption: `💰 Payment: ${ctx.from.first_name} (ID: ${ctx.from.id})`,
                    ...Markup.inlineKeyboard([Markup.button.callback('✅ Approve', `approve_${ctx.from.id}`), Markup.button.callback('❌ Reject', `reject_${ctx.from.id}`)])
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
            await bot.telegram.sendMessage(userId, '❌ Rejected.');
            ctx.editMessageCaption(ctx.callbackQuery.message.caption + '\n\n❌ REJECTED');
        });

        bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
        bot.on('successful_payment', async (ctx) => { await activateUser(ctx.from.id); ctx.reply('🎉 Paid!'); });

        bot.launch().then(() => console.log('🤖 Bot Started'));
        
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));

    } catch(e) { console.error('Bot Error:', e); }
}

// --- SCANNER JOB (UNCHANGED) ---
function loadPersistedSignals() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const latest = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (latest.parsed?.detected || []).forEach(d => {
        if (d.tag === 'AI') {
             const f = latest.parsed?.forecastsBySymbol?.[d.symbol];
             if (f) activeSignals.set(d.symbol, { ...d, ...f, forecastCandles: f.candles });
        }
    });
  } catch (e) {}
}

async function runScannerJob() {
  if (scanInFlight) return;
  scanInFlight = true;
  console.log('\n🔍 Running Elite Scanner Job...');

  try {
    const all = await fetch24hrTickers();
    if (!all) throw new Error("MEXC API Fail");

    const base = all.map(x => ({ symbol: x.symbol, quoteVolume: Number(x.quoteVolume), lastPrice: Number(x.lastPrice), priceChangePercent: Number(x.priceChangePercent) }))
        .filter(x => x.symbol.endsWith('USDT') && isSaneUsdtSymbol(x.symbol) && !isStablecoinLike(x.symbol) && !isLeveraged(x.symbol));

    const baseMap = new Map(base.map(b => [b.symbol, b]));
    const symbolsToRemove = [];

    for (const [sym, sig] of Array.from(activeSignals.entries())) {
        const tick = baseMap.get(sym);
        if (!tick) continue;
        const price = Number(tick.lastPrice);
        
        let done = false;
        if (sig.direction === 'LONG') {
            if (price >= sig.target_price) { sig.status = 'WON'; sig.removeAt = Date.now()+60000; done = true; }
            else if (price <= sig.stop_loss_price) { sig.status = 'LOST'; sig.removeAt = Date.now()+60000; done = true; }
        } else {
            if (price <= sig.target_price) { sig.status = 'WON'; sig.removeAt = Date.now()+60000; done = true; }
            else if (price >= sig.stop_loss_price) { sig.status = 'LOST'; sig.removeAt = Date.now()+60000; done = true; }
        }
        if (done) symbolsToRemove.push(sym); else sig.price = price;
    }
    symbolsToRemove.forEach(sym => activeSignals.delete(sym));

    if (activeSignals.size < 5) {
        const aiPool = base.filter(x => x.quoteVolume > MIN_QUOTEVOL_AI);
        const newPicks = await pickAiWithAdaptiveGates(aiPool);
        newPicks.forEach(p => {
            if (!activeSignals.has(p.symbol)) {
                activeSignals.set(p.symbol, { ...p, tag: 'AI', detectedAt: Date.now(), status: 'ACTIVE', addedAt: Date.now() });
                notifyProUsers(`🚨 NEW SIGNAL: ${p.symbol} ${p.direction}!\nTarget: ${p.target_price}`);
            }
        });
    }

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
app.get('/api/user/status', async (req, res) => {
    const id = req.query.tg_id;
    const hasAccess = await checkUser(id);
    res.json({ isPremium: hasAccess });
});
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

// Front-end serve
app.use(express.static(path.join(__dirname, '../dist')));
app.get('*', (req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/events')) return;
    res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, () => { try { loadPersistedSignals(); } catch(e){} console.log(`🚀 Server on ${PORT}`); runScannerJob(); });
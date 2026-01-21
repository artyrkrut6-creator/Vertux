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

function normDirection(d) {
  const x = String(d || '').toUpperCase();
  return x === 'SHORT' ? 'SHORT' : 'LONG';
}

// --- STAGE 1: SELECTION (Find the Winner) ---
async function deepseekSelectWinner(candidates) {
  if (!SILICON_KEY) return null;
  
  const system = `You are a Senior Quant Trader.
Analyze 5 assets. Pick the SINGLE BEST opportunity for a 5-20 min scalp.
Criteria: Market Structure, Volume Anomalies, RSI Divergence.
OUTPUT: Just the Ticker Symbol of the winner.`;

  let userMsg = "Analyze these assets:\n";
  candidates.forEach((c, i) => {
      // ВОТ ТУТ МЫ ФОРМИРУЕМ ПОЛНУЮ СТРОКУ СВЕЧИ (OHLCV)
      const candlesStr = c.klines.slice(-10).map(k => 
          `[O:${k[1]} H:${k[2]} L:${k[3]} C:${k[4]} V:${k[5]}]`
      ).join(' ');
      
      userMsg += `Asset ${i+1}: ${c.symbol}. RSI: ${c.rsi.toFixed(1)}. Candles (Last 10): ${candlesStr}\n\n`;
  });
  userMsg += "Which one is the winner? Return ONLY the symbol.";

  try {
    const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${SILICON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-ai/DeepSeek-V3', messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }], temperature: 0.1 }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content || '';
    const winner = candidates.find(c => content.includes(c.symbol));
    return winner || null;
  } catch (e) { return null; }
}

// --- STAGE 2: EXECUTION (Sniper Levels) ---
async function deepseekExecution(winner) {
  if (!SILICON_KEY) return null;

  const klines = await fetchMexcKlines(winner.symbol, '1m', 30);
  const depth = await fetchMexcDepth(winner.symbol, 20);
  
  // ВОТ ТУТ МЫ ОТПРАВЛЯЕМ ПОЛНУЮ ИСТОРИЮ (20 СВЕЧЕЙ OHLCV)
  const candlesStr = klines.slice(-20).map(k => 
      `[T:${new Date(k[0]).toTimeString().slice(0,5)} O:${k[1]} H:${k[2]} L:${k[3]} C:${k[4]} V:${k[5]}]`
  ).join('\n');

  const system = `You are an Elite Scalping Bot.
Provide a high-precision entry for ${winner.symbol}.
Strategy: Pump Exhaustion or Breakout. Timeframe: 5-20 mins.
REQUIRED JSON OUTPUT:
{
  "direction": "LONG" | "SHORT",
  "target_price": <number>,
  "stop_loss_price": <number>,
  "confidence": <number 0-100>,
  "reasoning": "brief logic",
  "forecast_1m": [ { "close": number }, ... 5 candles ... ]
}`;

  const user = `Final Analysis for ${winner.symbol}.
Current Price: ${winner.price}. RSI: ${winner.rsi.toFixed(1)}.
OrderBook Bids: ${depth?.bids?.[0]?.[0] || 'N/A'}. Asks: ${depth?.asks?.[0]?.[0] || 'N/A'}.

Last 20 Candles (OHLCV):
${candlesStr}

Predict NOW.`;

  try {
    const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${SILICON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-ai/DeepSeek-V3', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.1, response_format: { type: 'json_object' } }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    let content = j?.choices?.[0]?.message?.content || '{}';
    if (content.includes('```json')) content = content.split('```json')[1].split('```')[0].trim();
    const parsed = JSON.parse(content);
    if (!parsed.target_price) return null;

    const now = Date.now();
    return {
        ...parsed,
        candles: parsed.forecast_1m.map((c, i) => ({ t: now + (i+1)*60000, close: Number(c.close) })),
        source: 'deepseek'
    };
  } catch (e) { return null; }
}

// --- DB & USER ---
if (MONGO_URI) {
  mongoose.connect(MONGO_URI).then(()=>console.log('[DB] Connected')).catch(e=>console.error('[DB] Error', e));
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
  try { await User.findOneAndUpdate({ tgId: String(id) }, { isPremium: true, expiresAt: Date.now() + 30*24*3600000 }, { upsert: true }); } catch(e){}
}
async function checkUser(id) {
  try { const u = await User.findOne({ tgId: String(id) }); return u && u.isPremium && u.expiresAt > Date.now(); } catch(e){ return false; }
}

let notifyProUsers = async (message) => { console.log('[notifyProUsers] noop', message); };

const TEXTS = {
    ru: {
        welcome: "👋 Добро пожаловать в Vortex AI!\n\nПожалуйста, подпишитесь на наш канал, чтобы продолжить.",
        sub_check: "🔄 Проверить подписку",
        sub_error: "❌ Вы не подписаны на канал. Подпишитесь, чтобы пользоваться ботом.",
        lang_select: "🌐 Выберите язык / Select Language:",
        menu: { app: "🚀 Vortex App", premium: "💎 Premium", market: "📊 Рынок", settings: "⚙️ Настройки", help: "❓ Помощь" },
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
        help: "📚 **ПОМОЩЬ**\n\n• **AI Signals:** Снайперские входы от DeepSeek.\n• **FT:** Зоны перекупленности/перепроданности.\n\nSupport: @meanfive1",
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
        manual_pay: "💳 **Payment Method: Bank Card**\n💰 **Price:** $10\n\n👋 Contact manager below.\n\n🍇 **AFTER PAYMENT** — come back and click **\"✅ I Paid\"**. Then send a screenshot.\n\n<i>Access granted within 5 mins.</i>",
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

        const getMenu = (lang) => {
            const T = TEXTS[lang] || TEXTS['ru'];
            return Markup.keyboard([
                [T.menu.app, T.menu.premium], 
                [T.menu.market, T.menu.settings], 
                [T.menu.help]
            ]).resize();
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
                } catch(e){}
            }
            if (ctx.message && ctx.message.text && !ctx.message.text.startsWith('/')) {
                try {
                    const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, ctx.from.id);
                    if (['left', 'kicked'].includes(member.status)) {
                        const T = await getT(ctx);
                        return ctx.reply(T.sub_error, Markup.inlineKeyboard([
                            Markup.button.url('📢 Channel', `https://t.me/${CHANNEL_USERNAME.replace('@','')}`),
                            Markup.button.callback(T.sub_check, 'check_sub')
                        ]));
                    }
                } catch (e) { /* ignore */ }
            }
            return next();
        });

        notifyProUsers = async (message) => {
          try {
            const users = await User.find({ isPremium: true, notificationsEnabled: true }).lean().exec();
            for (const u of users) { try { await bot.telegram.sendMessage(u.tgId, message); } catch (e) {} }
          } catch (e) { console.warn('Notify Error:', e); }
        };

        bot.command('start', async (ctx) => {
            await ctx.reply('🌐 Choose language / Выберите язык', Markup.inlineKeyboard([
                Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
                Markup.button.callback('🇺🇸 English', 'lang_en')
            ]));
        });

        bot.action(/^lang_(.+)$/, async (ctx) => {
            const lang = ctx.match[1];
            await User.findOneAndUpdate({ tgId: String(ctx.from.id) }, { language: lang }, { upsert: true });
            await ctx.answerCbQuery();
            try { await ctx.deleteMessage(); } catch(e){}
            const T = TEXTS[lang] || TEXTS['ru'];
            await ctx.reply(T.welcome, getMenu(lang));
        });

        bot.action('check_sub', (ctx) => { ctx.deleteMessage(); ctx.reply('✅ OK!'); });

        bot.hears([/🚀 Vortex App/, /🚀 Открыть Терминал/, /App/, /Terminal/], async (ctx) => {
            const T = await getT(ctx);
            ctx.reply(T.app_desc, Markup.inlineKeyboard([Markup.button.webApp(T.menu.app, WEBAPP_URL)]));
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
            ctx.reply(`${T.profile}\n\n🆔 ID: \`${ctx.from.id}\`\n👤 User: @${ctx.from.username}\n💎 Status: ${statusText}`, { parse_mode: 'Markdown' });
        });

        bot.hears([/⚙️ Настройки/, /⚙️ Settings/], async (ctx) => {
            const T = await getT(ctx);
            const u = await User.findOne({ tgId: String(ctx.from.id) });
            const s = u?.notificationsEnabled ? '✅ ON' : '❌ OFF';
            ctx.reply(`${T.settings}\n\n${T.alerts} ${s}`, Markup.inlineKeyboard([
                [Markup.button.callback(T.lang_btn, 'change_lang')],
                [Markup.button.callback('Toggle Alerts', 'toggle_alerts')]
            ]));
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
            await ctx.reply(T.disclaimer, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(T.agree_pay, 'show_pay')]]) });
        });

        bot.action('show_pay', async (ctx) => {
            const T = await getT(ctx);
            ctx.editMessageText(T.premium_buy, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
                [Markup.button.callback(T.pay_methods.card, 'pay_manager')],
                [Markup.button.callback(T.pay_methods.crypto, 'pay_manager')],
                [Markup.button.callback(T.pay_methods.stars, 'pay_stars')]
            ])});
        });

        bot.action('pay_manager', async (ctx) => {
            const T = await getT(ctx);
            const msg = T.language === 'en' ? 'Hello, I want to buy Premium.' : 'Привет, нужны реквизиты для оплаты переводом на карту.';
            const link = `https://t.me/${MANAGER_USERNAME}?text=${encodeURIComponent(msg)}`;
            ctx.editMessageText(T.manual_pay, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
                [Markup.button.url(T.btn_manager, link)],
                [Markup.button.callback(T.btn_paid, 'paid_manual')],
                [Markup.button.callback(T.btn_back, 'show_pay')]
            ])});
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
            await bot.telegram.sendMessage(userId, '❌ Payment Rejected.');
            ctx.editMessageCaption(ctx.callbackQuery.message.caption + '\n\n❌ REJECTED');
        });

        bot.action('pay_stars', (ctx) => ctx.replyWithInvoice({ chat_id: ctx.from.id, title: 'Vortex PRO', description: '1 Month', payload: 'pro', provider_token: '', currency: 'XTR', prices: [{ label: '1 Month', amount: 500 }] }));
        bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
        bot.on('successful_payment', async (ctx) => { await activateUser(ctx.from.id); ctx.reply('🎉 Paid!'); });

        bot.hears(/📊 Market|📊 Рынок/, async (ctx) => {
            const T = await getT(ctx);
            ctx.reply(T.market);
        });

        bot.hears(/❓ Help|❓ Помощь/, async (ctx) => {
            const T = await getT(ctx);
            ctx.reply(T.help, { parse_mode: 'Markdown' });
        });

        // Admin
        bot.command('admin', async (ctx) => {
            if (String(ctx.from.id) !== String(ADMIN_ID)) return;
            const count = await User.countDocuments();
            const pros = await User.countDocuments({ isPremium: true });
            ctx.reply(`👑 **ADMIN**\nTotal: ${count}\nPRO: ${pros}\n\n/give <id>\n/del <id>`);
        });

        bot.command('give', async (ctx) => {
            if (String(ctx.from.id) !== String(ADMIN_ID)) return;
            const id = ctx.message.text.split(' ')[1];
            if (id) { await activateUser(id); ctx.reply(`✅ Given to ${id}`); }
        });

        bot.command('del', async (ctx) => {
            if (String(ctx.from.id) !== String(ADMIN_ID)) return;
            const id = ctx.message.text.split(' ')[1];
            if (id) { await User.findOneAndUpdate({ tgId: String(id) }, { isPremium: false }); ctx.reply(`❌ Removed from ${id}`); }
        });

        bot.command('force', async (ctx) => {
            if (String(ctx.from.id) !== String(ADMIN_ID)) return;
            const sym = (ctx.message.text.split(' ')[1] || 'DOGEUSDT').toUpperCase();
            
            const k = await fetchMexcKlines(sym, '1m', 50);
            if (!k.length) return ctx.reply('Symbol not found');
            const price = Number(k[k.length-1][4]);
            
            // Mock Signal
            const signal = {
                symbol: sym, tag: 'AI', price,
                target_price: price * 1.002, stop_loss_price: price * 0.998, direction: 'LONG',
                forecastCandles: [], detectedAt: Date.now(), status: 'ACTIVE', addedAt: Date.now(),
                stdDev: 0, quoteVolume: 1000000, spreadPct: 0.01, source: 'deepseek'
            };
            
            activeSignals.set(sym, signal);
            ctx.reply(`✅ Forced ${sym}`);
        });

        bot.launch().then(() => console.log('🤖 Bot Started'));
        
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));

    } catch(e) { console.error('Bot Error:', e); }
}

// --- SCANNER JOB ---
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
  console.log('\n🔍 Running 2-Stage Elite Scanner...');

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

    // STAGE 1: SELECTION
    if (activeSignals.size < 5) {
        const candidates = base
            .filter(x => x.symbol.endsWith('USDT') && !['USDCUSDT','FDUSDUSDT'].includes(x.symbol) && Number(x.quoteVolume) > 1000000)
            .sort((a,b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent)) // Most Volatile
            .slice(0, 5);

        const enriched = [];
        for (const c of candidates) {
            const kl = await fetchMexcKlines(c.symbol, '1m', 15);
            if (kl.length < 15) continue;
            const closes = kl.map(k=>Number(k[4]));
            enriched.push({ symbol: c.symbol, price: Number(c.lastPrice), quoteVolume: Number(c.quoteVolume), rsi: calculateRSI(closes), klines: kl });
        }

        if (enriched.length > 0) {
            console.log('🤖 Selecting from:', enriched.map(e=>e.symbol));
            const winner = await deepseekSelectWinner(enriched);
            
            if (winner) {
                console.log('🏆 Winner:', winner.symbol);
                const signal = await deepseekExecution(winner);
                if (signal) {
                    activeSignals.set(winner.symbol, {
                        symbol: winner.symbol, tag: 'AI', price: winner.price,
                        target_price: signal.target_price, stop_loss_price: signal.stop_loss_price, direction: signal.direction,
                        forecastCandles: signal.candles, detectedAt: Date.now(), status: 'ACTIVE',
                        addedAt: Date.now(), stdDev: 0, quoteVolume: winner.quoteVolume, change24hPct: 0
                    });
                    notifyProUsers(`🚨 NEW SIGNAL: ${winner.symbol} ${signal.direction}!\nTarget: ${signal.target_price}`);
                }
            }
        }
    }

    // FT Signals
    const ftPicks = [];
    // ... (Keep FT logic as simple placeholder or implement full)
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
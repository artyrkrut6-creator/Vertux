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
const MIN_QUOTEVOL_AI = 2_500_000;
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
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@VortexAiOff';

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
  const adaptiveSteps = [{ gates: { maxSpreadPct: 0.40, minDepth: 10_000, stddevMax: 0.25, backtestMean: 0.35 } }];
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
            if (!ds || ds.confidence < 75) return null;
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
    tgId: String,
    isPremium: Boolean,
    expiresAt: Number,
    notificationsEnabled: { type: Boolean, default: true },
    firstName: String,
    username: String,
    language: { type: String, enum: ['ru','en'], default: 'ru' }
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

async function activateUser(id) {
  try { await User.findOneAndUpdate({ tgId: String(id) }, { isPremium: true, expiresAt: Date.now() + 30*24*3600000 }, { upsert: true }); } catch(e){}
}
async function checkUser(id) {
  try { const u = await User.findOne({ tgId: String(id) }); return u && u.isPremium && u.expiresAt > Date.now(); } catch(e){ return false; }
}

let notifyProUsers = async (message) => { console.log('[notifyProUsers] noop', message); };

// --- TELEGRAM BOT (FULL V5) ---
if (TG_BOT_TOKEN) {
    try {
        const bot = new Telegraf(TG_BOT_TOKEN);

        const mainMenu = Markup.keyboard([['🚀 Open App', '💎 Premium'], ['📊 Market', '⚙️ Settings']]).resize();

        // helper: show main menu localized
        const showMainMenu = async (ctx, lang='ru') => {
            const html = (lang === 'en') ?
                `<b>🚀 Open App</b> — Launch the Neural Terminal. Access real-time AI signals and charts.<br/><b>💎 Premium</b> — 1 Month Access, AI Sniper, Zero Latency.<br/><b>⚙️ Settings</b> — AI Alerts (push notifications).` :
                `<b>🚀 Открыть приложение</b> — Запустить терминал. Доступ к AI сигналам в реальном времени.<br/><b>💎 Премиум</b> — 1 месяц, AI снайпер, минимальная задержка.<br/><b>⚙️ Настройки</b> — Оповещения AI (push).`;
            try { await ctx.reply(html, { parse_mode: 'HTML', ...mainMenu }); } catch(e){}
        };

        // middleware: force subscribe to CHANNEL_USERNAME for non-exempt actions
        bot.use(async (ctx, next) => {
            try {
                const fromId = ctx.from?.id;
                const isExempt = (() => {
                    if (!ctx.updateType) return false;
                    if (ctx.updateType === 'message' && ctx.message && ctx.message.text === '/start') return true;
                    if (ctx.updateType === 'callback_query' && ctx.callbackQuery && typeof ctx.callbackQuery.data === 'string') {
                        const d = ctx.callbackQuery.data;
                        if (d.startsWith('lang_') || d === 'check_sub' || d === 'agree_payment' || d.startsWith('lang_') ) return true;
                    }
                    if (ctx.updateType === 'message' && ctx.message && ctx.message.text && ctx.message.text.startsWith('/menu')) return true;
                    return false;
                })();

                if (fromId && !isExempt) {
                    try {
                        const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, fromId);
                        const ok = member && ['creator','administrator','member'].includes(member.status);
                        if (!ok) {
                            const text = `<b>Please subscribe to continue / Подпишитесь для продолжения</b>`;
                            await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([
                                Markup.button.url('➡️ Channel', `https://t.me/${CHANNEL_USERNAME.replace('@','')}`),
                                Markup.button.callback('🔁 Check Subscription', 'check_sub')
                            ])});
                            return; // stop processing
                        }
                    } catch (e) {
                        // if we cannot check, ask to subscribe as fallback
                        const text = `<b>Please subscribe to continue / Подпишитесь для продолжения</b>`;
                        try { await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([Markup.button.url('➡️ Channel', `https://t.me/${CHANNEL_USERNAME.replace('@','')}`), Markup.button.callback('🔁 Check Subscription', 'check_sub')])}); } catch(_){}
                        return;
                    }
                }
            } catch (e) { console.warn('subscribe middleware error', e); }
            // upsert basic profile (name/username)
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

        notifyProUsers = async (message) => {
          try {
            const users = await User.find({ isPremium: true, notificationsEnabled: true }).lean().exec();
            for (const u of users) { try { await bot.telegram.sendMessage(u.tgId, message); } catch (e) {} }
          } catch (e) { console.warn('Notify Error:', e); }
        };

        bot.command('start', async (ctx) => {
            try {
                const uid = String(ctx.from.id);
                let u = await User.findOne({ tgId: uid }).exec();
                if (!u || !u.language) {
                    // Ask language
                    await ctx.reply('<b>Choose language / Выберите язык</b>', {
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([
                            Markup.button.callback('🇷🇺 Русский', 'lang_ru'),
                            Markup.button.callback('🇺🇸 English', 'lang_en')
                        ])
                    });
                    return;
                }
                await showMainMenu(ctx, u.language || 'ru');
            } catch (e) { console.error('start handler error', e); try{ await ctx.reply('Error'); }catch(_){} }
        });

        bot.action('lang_ru', async (ctx) => {
            try {
                const uid = String(ctx.from.id);
                await User.findOneAndUpdate({ tgId: uid }, { language: 'ru' }, { upsert: true });
                await ctx.answerCbQuery();
                await showMainMenu(ctx, 'ru');
            } catch (e) { console.warn('lang_ru error', e); }
        });

        bot.action('lang_en', async (ctx) => {
            try {
                const uid = String(ctx.from.id);
                await User.findOneAndUpdate({ tgId: uid }, { language: 'en' }, { upsert: true });
                await ctx.answerCbQuery();
                await showMainMenu(ctx, 'en');
            } catch (e) { console.warn('lang_en error', e); }
        });

        bot.action('check_sub', async (ctx) => {
            try {
                const uid = ctx.from?.id;
                if (!uid) return await ctx.answerCbQuery();
                try {
                    const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, uid);
                    const ok = member && ['creator','administrator','member'].includes(member.status);
                    if (ok) {
                        const u = await User.findOne({ tgId: String(uid) }).lean().exec();
                        await ctx.reply('<b>Thanks — you are subscribed.</b>', { parse_mode: 'HTML' });
                        await showMainMenu(ctx, (u && u.language) ? u.language : 'ru');
                    } else {
                        await ctx.reply('<b>Please subscribe to continue / Подпишитесь для продолжения</b>', { parse_mode: 'HTML' });
                    }
                } catch (e) { await ctx.reply('<b>Unable to verify subscription. Please try again.</b>', { parse_mode: 'HTML' }); }
                await ctx.answerCbQuery();
            } catch(e){}
        });

        bot.command('admin', async (ctx) => {
            if (ctx.from.id !== ADMIN_ID) return;
            const count = await User.countDocuments();
            const pros = await User.countDocuments({ isPremium: true });
            ctx.reply(`👑 **ADMIN PANEL**\n\n👥 Total Users: ${count}\n💎 PRO Users: ${pros}\n\nCommands:\n/give <id>\n/del <id>`);
        });

        bot.command('give', async (ctx) => {
            if (ctx.from.id !== ADMIN_ID) return;
            const id = ctx.message.text.split(' ')[1];
            if (id) { await activateUser(id); ctx.reply(`✅ Given PRO to ${id}`); }
        });

        bot.hears('🚀 Open App', (ctx) => ctx.reply('Launch Terminal:', Markup.inlineKeyboard([Markup.button.webApp('📱 Open Vortex AI', WEBAPP_URL)])));

        bot.hears('📊 Market', async (ctx) => {
            const isPro = await checkUser(ctx.from.id);
            if (!isPro) return ctx.reply('🔒 **Premium Feature.**');
            const msg = await ctx.reply('Scanning...');
            try {
                const all = await fetch24hrTickers();
                const btc = all?.find(x => x.symbol === 'BTCUSDT');
                const top = all?.filter(x => x.symbol.endsWith('USDT') && Number(x.quoteVolume) > 5000000).sort((a,b) => Number(b.priceChangePercent) - Number(a.priceChangePercent)).slice(0, 3);
                let text = `📉 **MARKET**\nBTC: $${Number(btc.lastPrice).toFixed(0)} (${Number(btc.priceChangePercent).toFixed(2)}%)\n\n🚀 **Top Movers:**\n`;
                top.forEach(c => text += `• ${c.symbol.replace('USDT','')}: +${Number(c.priceChangePercent).toFixed(1)}%\n`);
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, text, { parse_mode: 'Markdown' });
            } catch (e) { ctx.deleteMessage(msg.message_id); }
        });

        bot.hears('⚙️ Settings', async (ctx) => {
            const u = await User.findOne({ tgId: String(ctx.from.id) });
            const s = u?.notificationsEnabled ? '✅ ON' : '❌ OFF';
            if (!u?.isPremium) return ctx.reply('🔒 **Settings** are available for PRO users only.');
            ctx.reply(`🔔 AI Alerts: ${s}`, Markup.inlineKeyboard([Markup.button.callback('Toggle Alerts', 'toggle_alerts')]));
        });

        bot.action('toggle_alerts', async (ctx) => {
            const u = await User.findOne({ tgId: String(ctx.from.id) });
            if (!u || !u.isPremium) return ctx.answerCbQuery('Only for PRO users');
            u.notificationsEnabled = !u.notificationsEnabled;
            await u.save();
            ctx.editMessageText(`🔔 AI Alerts: ${u.notificationsEnabled ? '✅ ON' : '❌ OFF'}`, Markup.inlineKeyboard([Markup.button.callback('Toggle', 'toggle_alerts')]));
        });

        bot.hears('💎 Premium', async (ctx) => {
            try {
                const urec = await User.findOne({ tgId: String(ctx.from.id) }).lean().exec();
                const lang = (urec && urec.language) ? urec.language : 'ru';
                const isPro = await checkUser(ctx.from.id);
                if (isPro) return ctx.reply('<b>✅ You are PRO.</b>', { parse_mode: 'HTML' });

                const disclaimerRU = `<b>Юридический отказ от ответственности</b>\nЯ не несу ответственности за финансовые потери. Торговля криптовалютой рискована. Вы соглашаетесь, что используете сигналы на свой страх и риск.`;
                const disclaimerEN = `<b>Legal Disclaimer</b>\nI am not responsible for financial losses. Trading cryptocurrencies involves risk. You agree to use signals at your own risk.`;
                const longDisclaimer = (lang === 'en') ? disclaimerEN : disclaimerRU;

                await ctx.reply(longDisclaimer, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ I Agree & Continue', 'agree_payment')]]) });
            } catch (e) { console.warn('premium error', e); }
        });

        bot.action('agree_payment', async (ctx) => {
            try {
                const uid = String(ctx.from.id);
                const u = await User.findOne({ tgId: uid }).lean().exec();
                const lang = (u && u.language) ? u.language : 'ru';
                const managerText = encodeURIComponent(lang === 'en' ? 'Hello, I want to buy Premium.' : 'Привет, хочу купить Премиум.');
                const managerLink = `https://t.me/${MANAGER_USERNAME}?text=${managerText}`;

                const payHtml = (lang === 'en') ?
                    `<b>VORTEX PRO</b>\n1 Month Access — AI Sniper — Zero Latency. Choose payment:` :
                    `<b>VORTEX PRO</b>\n1 месяц — AI снайпер — Минимальная задержка. Выберите способ оплаты:`;

                await ctx.editMessageText(payHtml, { parse_mode: 'HTML', ...Markup.inlineKeyboard([
                    [Markup.button.url(lang === 'en' ? 'Contact Manager' : '📩 Написать Менеджеру', managerLink)],
                    [Markup.button.callback(lang === 'en' ? '✅ I Paid' : '✅ Я Оплатил', 'paid_manual')],
                    [Markup.button.callback(lang === 'en' ? 'Back' : '🔙 Назад', 'back_premium')]
                ])});
                await ctx.answerCbQuery();
            } catch (e) { console.warn('agree_payment error', e); }
        });

        // 2. MANAGER PAYMENT (FIXED)
        bot.action('pay_manager', (ctx) => {
            const userId = ctx.from.id;
            const messageText = encodeURIComponent("Привет.\n\nНужны реквизиты для оплаты переводом на карту.");
            const managerLink = `https://t.me/${MANAGER_USERNAME}?text=${messageText}`;

            ctx.editMessageText(
                `💳 **Способ оплаты: Перевод на карту** 🇷🇺\n` +
                `💰 **К оплате:** 1000 RUB\n` +
                `🆔 **Ваш ID:** \`${userId}\`\n\n` +
                `👋 Напиши менеджеру по кнопке ниже, он выдаст реквизиты.\n\n` +
                `⚡️ **ПОСЛЕ ПЕРЕВОДА** — возвращайся сюда и жми кнопку **"✅ Я Оплатил"**. Затем отправляй скриншот.\n\n` +
                `_Доступ выдаётся в течение 5 минут._`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.url('📩 Написать Менеджеру', managerLink)],
                        [Markup.button.callback('✅ Я Оплатил', 'paid_manual')],
                        [Markup.button.callback('🔙 Назад', 'back_premium')]
                    ])
                }
            );
        });

        bot.action('back_premium', (ctx) => ctx.deleteMessage());

        bot.action('paid_manual', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.reply('📸 **Пожалуйста, отправьте скриншот оплаты сюда.**');
            pendingVerifications.set(ctx.from.id, true);
        });

        bot.on('photo', async (ctx) => {
            if (pendingVerifications.get(ctx.from.id)) {
                pendingVerifications.delete(ctx.from.id);
                const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                await ctx.reply('⏳ **Проверка...** Админ проверит платеж.');
                await bot.telegram.sendPhoto(ADMIN_ID, photoId, {
                    caption: `💰 **Payment**\nUser: ${ctx.from.first_name} (ID: ${ctx.from.id})\n@${ctx.from.username}`,
                    ...Markup.inlineKeyboard([Markup.button.callback('✅ Approve', `approve_${ctx.from.id}`), Markup.button.callback('❌ Reject', `reject_${ctx.from.id}`)])
                });
            }
        });

        bot.action(/^approve_(\d+)$/, async (ctx) => {
            const userId = ctx.match[1];
            await activateUser(userId);
            await bot.telegram.sendMessage(userId, '🎉 **Оплата принята!** PRO доступ активирован.\nПерезапустите приложение.');
            ctx.editMessageCaption(ctx.callbackQuery.message.caption + '\n\n✅ ОДОБРЕНО');
        });

        bot.action(/^reject_(\d+)$/, async (ctx) => {
            const userId = ctx.match[1];
            await bot.telegram.sendMessage(userId, '❌ **Оплата отклонена.** Свяжитесь с поддержкой.');
            ctx.editMessageCaption(ctx.callbackQuery.message.caption + '\n\n❌ ОТКЛОНЕНО');
        });

        bot.action('pay_stars', (ctx) => ctx.replyWithInvoice({ chat_id: ctx.from.id, title: 'PRO', description: '1 Month', payload: 'pro', provider_token: '', currency: 'XTR', prices: [{ label: '1 Month', amount: 500 }] }));
        bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
        bot.on('successful_payment', async (ctx) => { await activateUser(ctx.from.id); ctx.reply('🎉 Paid!'); });

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
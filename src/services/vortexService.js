// Vortex service (LLM-only)
// Calls server `/api/deepsik` endpoints — no local-model fallbacks.

// In dev, prefer direct backend to avoid Vite proxy issues. In production keep relative path.
const API_BASE = (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) ? 'http://localhost:5176' : ''
import { intervalSecondsFor } from './marketService'

function nowTs(){ return Date.now() }

// Cached Vortex (SiliconFlow) forecast: front-end helper
const VORTEX_CACHE_KEY = 'vortex_ai_cache'
const VORTEX_CACHE_DURATION = 10 * 60 * 1000 // 10 minutes

export async function getVortexForecast(currentPrices = [], timeframe = '1m'){
  try{
    const cached = localStorage.getItem(VORTEX_CACHE_KEY)
    if (cached){
      const parsed = JSON.parse(cached)
      const expired = Date.now() - parsed.timestamp > VORTEX_CACHE_DURATION
      if (!expired && parsed.savedTimeframe === timeframe){
        console.log('[vortexService] using cached Vortex AI data')
        return parsed.data
      }
    }

    const historyData = (Array.isArray(currentPrices) && currentPrices.length) ? currentPrices.slice(-20).map(c=> (c.close || c[4] || c)) : []

    const resp = await fetch(`${API_BASE}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ historyData, timeframe }) })
    if (!resp.ok) throw new Error('Vortex analyze failed: ' + resp.status)
    const data = await resp.json()
    const cacheData = { timestamp: Date.now(), savedTimeframe: timeframe, data }
    try{ localStorage.setItem(VORTEX_CACHE_KEY, JSON.stringify(cacheData)) }catch(e){ /* ignore storage errors */ }
    return data
  }catch(e){ console.error('getVortexForecast error', e); return { sentiment: 'neutral', analysis: 'Связь с Нейросетью потеряна. Работают локальные алгоритмы.', forecast: [] } }
}

export async function getLatestForecast(timeframe='1m', context = {}){
  // Send recent OHLC and optional news to server for best remote-model prediction.
  const body = { timeframe }
  if (context.ohlcv) body.ohlcv = context.ohlcv
  if (context.latestPrice) body.latestPrice = context.latestPrice
  if (context.news) body.news = context.news
  let resp = await fetch(`${API_BASE}/api/deepsik/sample`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!resp.ok){
    let firstBody = ''
    try{ firstBody = await resp.text() }catch(e){ firstBody = `<body read error: ${e}>` }
    // dev convenience: if Vite proxy responded 404 (Cannot POST), retry directly to backend port 5176
    if (typeof window !== 'undefined' && resp.status === 404 && firstBody && firstBody.includes('Cannot POST')){
      try{
        console.warn('[vortexService] proxy 404 detected, retrying direct backend http://localhost:5176')
        resp = await fetch(`http://localhost:5176/api/deepsik/sample`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (!resp.ok){
          let retryBody = ''
          try{ retryBody = await resp.text() }catch(e){ retryBody = `<body read error: ${e}>` }
          throw new Error(`deepsik sample failed: ${resp.status} - ${retryBody}`)
        }
      }catch(e){
        // If the retry failed at fetch time, include the original body for context
        throw new Error(`deepsik sample failed: ${resp.status} - ${firstBody}`)
      }
    } else {
      throw new Error(`deepsik sample failed: ${resp.status} - ${firstBody}`)
    }
  }
  // try parse JSON but include raw text on failure
  let data
  try{ data = await resp.json() }catch(e){ const raw = await resp.text().catch(()=>'<no body>'); throw new Error(`deepsik sample invalid JSON: ${raw}`) }
  if (!data || !Array.isArray(data.prediction_candles)) throw new Error('invalid deepsik response')
  const interval = (intervalSecondsFor && typeof intervalSecondsFor === 'function') ? intervalSecondsFor(timeframe) : 60
  const startTs = Date.now()
    // Heuristic: if model returned small normalized values (e.g. 0.95, 1.01) and caller provided latestPrice,
    // convert them to absolute prices by scaling with latestPrice.
    const latestPrice = context.latestPrice || (context.ohlcv && context.ohlcv.length ? context.ohlcv[context.ohlcv.length-1].close : undefined)
    const closesRaw = data.prediction_candles.map(c => Number(c.close || c.open || c.high || c.low || 0))
    const maxClose = Math.max(...closesRaw.map(Math.abs))
    const shouldScale = latestPrice && maxClose > 0 && maxClose < 10
    const forecast = data.prediction_candles.map((c, i) => {
      // derive base values
      const rawOpen = Number(c.open || c.close || 0)
      const rawHigh = Number(c.high || c.close || 0)
      const rawLow = Number(c.low || c.close || 0)
      const rawClose = Number(c.close || c.open || 0)
      // scale if model returned normalized values
      const scale = shouldScale ? latestPrice : 1
      const open = rawOpen * scale
      const high = rawHigh * scale
      const low = rawLow * scale
      const close = rawClose * scale
      return {
        t: startTs + i * interval * 1000,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        vol: 0
      }
    })
  const meta = { timeframe, source: data.model || 'remote_llm', fetchedAt: nowTs(), model_available: !!data.model_available }
  return { forecast, meta }
}

// New: call simplified /api/predict which expects { historyData: [close1,...] }
export async function getVortexPrediction(currentCandles = [], opts = {}){
  const API = (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) ? 'http://localhost:5176' : ''
  try{
    const closes = (Array.isArray(currentCandles) ? currentCandles.map(c=>c.close || c[4] || c[3]).filter(x=>x!==undefined) : [])
    if (!closes.length) return { forecast: [], meta: { error: 'no_closes' } }
    const body = { historyData: closes.slice(-20) }
    let resp = await fetch(`${API}/api/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!resp.ok) throw new Error(`predict request failed: ${resp.status}`)
    const j = await resp.json()
    if (!j || !Array.isArray(j.prediction)) throw new Error('invalid predict response')
    const preds = j.prediction.map(x => Number(x))
    console.log('[vortexService] raw preds:', preds.slice(0,20))
    const interval = (intervalSecondsFor && typeof intervalSecondsFor === 'function') ? intervalSecondsFor(opts.timeframe || '1m') : 60
    const startTs = Date.now()
    // Determine last known price to convert relative/multiplier outputs into absolute prices
    const lastClose = (Array.isArray(currentCandles) && currentCandles.length) ? (currentCandles[currentCandles.length-1].close || currentCandles[currentCandles.length-1][4]) : (opts.latestPrice || closes[closes.length-1])
    console.log('[vortexService] lastClose:', lastClose, 'preds max:', Math.max(...preds.map(Math.abs)))
    const maxPred = Math.max(...preds.map(Math.abs))
    // Heuristics:
    // - if preds are around 0.5..2.0, treat as multipliers (price = prevPrice * pred)
    // - if preds are very small (<0.2), treat as percent changes (price = prevPrice * (1 + pred))
    // - otherwise, if preds look like absolute prices (>100), use as-is
    const asMultiplier = preds.every(p => p > 0 && p < 2)
    const asPercent = maxPred > 0 && maxPred < 0.2
    const asAbsolute = maxPred > 100
    let forecast = []
    let prevPrice = lastClose || (closes.length ? closes[closes.length-1] : undefined)
    for (let i=0;i<preds.length;i++){
      const p = preds[i]
      let price
      if (asMultiplier && prevPrice) price = prevPrice * p
      else if (asPercent && prevPrice) price = prevPrice * (1 + p)
      else if (asAbsolute) price = p
      else if (prevPrice) price = prevPrice + p
      else price = p
      // create a small candle: open = prevPrice || price, close = price, high/low = min/max
      const open = prevPrice || price
      const close = price
      const high = Math.max(open, close)
      const low = Math.min(open, close)
      forecast.push({ t: startTs + i * interval * 1000, open: Number(open), high: Number(high), low: Number(low), close: Number(close), vol: 0 })
      prevPrice = close
    }
    console.log('[vortexService] constructed forecast first point:', forecast[0])
    return { forecast, meta: { source: 'predict_api', fetchedAt: nowTs() } }
  }catch(e){ console.error('getVortexPrediction error', e); return { forecast: [], meta: { error: String(e) } } }
}

export async function getForecast(){ throw new Error('getForecast deprecated; use getLatestForecast') }

export async function getInsights(){
  const resp = await fetch(`${API_BASE}/api/deepsik/qa`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
  if (!resp.ok) throw new Error('insights request failed')
  const j = await resp.json()
  return j
}

export function analyzeForecast(forecast = [], lastClose, history = []){
  try{
    if (!forecast || !forecast.length) return { verdict: 'no_data', text: 'Нет прогноза для анализа.' }
    const closes = forecast.map(f => Number(f.close)).filter(x => isFinite(x))
    if (!closes.length) return { verdict: 'no_data', text: 'Прогноз не содержит корректных закрытий.' }
    const n = closes.length
    const minC = Math.min(...closes)
    const maxC = Math.max(...closes)
    const range = maxC - minC
    const last = Number(lastClose) || closes[0]
    const relRange = range / (last || 1)
    // tiny variance -> degenerate
    if (relRange < 0.0007){
      return { verdict: 'no_trade', text: `Прогноз выровнен (почти константа, относительный разброс ${(relRange*100).toFixed(4)}%). Рекомендуется не торговать; запросить другой прогноз или использовать базовый алгоритм.` }
    }
    // compute step-wise pct changes and basic stats
    const steps = []
    for (let i=0;i<closes.length;i++){
      const prev = i===0 ? last : closes[i-1]
      const pct = prev ? (closes[i]-prev)/prev : 0
      steps.push(pct)
    }
    const absSteps = steps.map(Math.abs)
    const avgAbsStep = absSteps.reduce((s,a)=>s+a,0)/absSteps.length
    const meanStep = steps.reduce((s,a)=>s+a,0)/steps.length
    const std = Math.sqrt(steps.reduce((s,a)=>s + Math.pow(a-meanStep,2),0)/steps.length)
    const monotonicUp = steps.every(p => p >= 0)
    const monotonicDown = steps.every(p => p <= 0)
    const confidence = Math.min(0.99, Math.abs(meanStep)*100)

    // Determine confirmations from recent history when available (prefer history-based indicators)
    const histCloses = Array.isArray(history) && history.length ? history.map(h => Number(h.close || h)) : []
    const smaShortHist = simpleSMA(histCloses.length ? histCloses : closes, Math.min(3, Math.max(1, (histCloses.length || closes.length))))
    const smaLongHist = simpleSMA(histCloses.length ? histCloses : closes, Math.min(8, Math.max(2, (histCloses.length || closes.length))))
    const rsiHist = computeRSI(histCloses.length ? histCloses : closes, Math.min(14, Math.max(3, (histCloses.length || closes.length))))

    // If RSI indicates overbought/oversold opposite to trend, downgrade
    if ((monotonicUp && rsiHist > 75) || (monotonicDown && rsiHist < 25)){
      return { verdict: 'hold', text: `Прогноз монотонный, но RSI=${rsiHist.toFixed(1)} противоречит тренду — ждать подтверждения.` }
    }

    if ((monotonicUp || monotonicDown) && Math.abs(meanStep) > 0.0006){
      const side = monotonicUp ? 'LONG' : 'SHORT'
      const pctMove = (Math.abs(meanStep)*n*100).toFixed(2)
      const rr = 1.8
      const tp = (last * (1 + Math.sign(meanStep) * Math.abs(meanStep) * n * 1.15)).toFixed(2)
      const sl = (last * (1 - Math.sign(meanStep) * Math.abs(meanStep) * 0.6)).toFixed(2)
      return { verdict: monotonicUp ? 'buy' : 'sell', text: `Тренд: ${side}. Ожидаемое движение ≈ ${pctMove}%. Рекомендация: ${side==='LONG' ? 'buy' : 'sell'} при подтверждении (SMA short ${smaShortHist.toFixed(2)}, long ${smaLongHist.toFixed(2)}, RSI=${rsiHist.toFixed(1)}), TP≈${tp}, SL≈${sl} (RR≈${rr}).` }
    }

    // otherwise provide neutral analytics
    const volPct = (avgAbsStep*100).toFixed(3)
    const msg = `Анализ: средний шаг ${volPct}%, std ${ (std*100).toFixed(3) }%. Нет явного монотонного тренда. Рекомендуется ждать подтверждения (SMA=${smaShort.toFixed(2)}/${smaLong.toFixed(2)}, RSI=${rsi.toFixed(1)}).`
    return { verdict: 'hold', text: msg }
  }catch(e){ return { verdict: 'error', text: 'Не удалось проанализировать прогноз.' } }
}

export function baselineLocalForecast(lastClose, steps = 10, intervalSec = 60){
  // Deterministic baseline: seeded LCG pseudo-random sequence derived from lastClose
  const start = Number(lastClose) || 0
  const now = Date.now()
  const out = []
  if (!start || !isFinite(start)) return out
  let prev = start
  // seed from lastClose to keep baseline repeatable for same price
  let seed = Math.floor((start % 1000) * 1000) & 0xffffffff
  function nextRand(){ seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 4294967296) } // [0,1)
  for (let i=0;i<steps;i++){
    // deterministic small walk + small oscillation
    const noise = (nextRand() - 0.5) * 0.004 // ±0.2%
    const trend = Math.sin(i * 0.7 + (start % 10)) * 0.0006
    const close = prev * (1 + noise + trend)
    const open = prev
    const high = Math.max(open, close) * (1 + 0.0005)
    const low = Math.min(open, close) * (1 - 0.0005)
    out.push({ t: now + i * intervalSec * 1000, open: Number(open), high: Number(high), low: Number(low), close: Number(close), vol: 0 })
    prev = close
  }
  return out
}

// simple SMA over last n closes (n <= length)
export function simpleSMA(arr, n){
  const a = arr.slice(Math.max(0, arr.length - n))
  if (!a.length) return 0
  return a.reduce((s,x)=>s+Number(x),0)/a.length
}

// compute simple RSI (period up to n)
export function computeRSI(arr, period=14){
  const closes = arr.slice()
  if (!closes.length) return 50
  const deltas = []
  for (let i=1;i<closes.length;i++) deltas.push(closes[i] - closes[i-1])
  if (!deltas.length) return 50
  const gains = deltas.map(d=> d>0?d:0)
  const losses = deltas.map(d=> d<0?Math.abs(d):0)
  const avgGain = gains.slice(-period).reduce((s,x)=>s+x,0) / Math.max(1, Math.min(period, gains.length))
  const avgLoss = losses.slice(-period).reduce((s,x)=>s+x,0) / Math.max(1, Math.min(period, losses.length))
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  const rsi = 100 - (100 / (1 + rs))
  return rsi
}

export default { getLatestForecast, getInsights, getVortexPrediction, analyzeForecast, baselineLocalForecast }

// Simple local AI analysis service (no external API calls)
// Produces a JSON forecast following the required strict format.

function nowTs(){ return Date.now() }

function getCache(key){
  try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null } catch(e){ return null }
}

function setCache(key, data){
  try{ localStorage.setItem(key, JSON.stringify({ ts: nowTs(), data })) } catch(e){}
}

function computeRSI(closes, period = 14){
  if (!closes || closes.length <= period) return null
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++){
    const change = closes[i] - closes[i-1]
    if (change >= 0) gains += change; else losses += -change
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return Math.round(100 - (100 / (1 + rs)))
}

function simpleTrendSlope(closes){
  // linear regression slope approximation
  const n = closes.length
  if (n < 2) return 0
  const xs = Array.from({length:n}, (_,i)=>i)
  const meanX = (n-1)/2
  const meanY = closes.reduce((a,b)=>a+b,0)/n
  let num=0, den=0
  for (let i=0;i<n;i++){ num += (xs[i]-meanX)*(closes[i]-meanY); den += (xs[i]-meanX)*(xs[i]-meanX) }
  return den === 0 ? 0 : num/den
}

function detectLevels(closes){
  // naive: pick local minima/maxima as support/resistance candidates
  const supports = []
  const resistances = []
  for (let i=2;i<closes.length-2;i++){
    if (closes[i] < closes[i-1] && closes[i] < closes[i+1]) supports.push(closes[i])
    if (closes[i] > closes[i-1] && closes[i] > closes[i+1]) resistances.push(closes[i])
  }
  const topSupports = supports.sort((a,b)=>a-b).slice(0,2)
  const topRes = resistances.sort((a,b)=>b-a).slice(0,2)
  return [ topSupports[0]||null, topRes[0]||null ].filter(Boolean)
}

export async function analyzeMarket(ohlcv = [], rsi = null, news = []){
  // ohlcv: array of {time,open,high,low,close,volume}
  const key = 'vortex_ai_' + (ohlcv.length? Math.round(ohlcv[ohlcv.length-1].close):'')
  const cached = getCache(key)
  if (cached && (nowTs() - cached.ts) < 10*60*1000) return cached.data

  const closes = ohlcv.map(c=>c.close)
  const lastClose = closes.length? closes[closes.length-1] : null
  const usedRSI = rsi === null ? computeRSI(closes, 14) : rsi

  const slope = simpleTrendSlope(closes.slice(-30))
  const levels = detectLevels(closes.slice(-50))

  let direction = slope >= 0 ? 'LONG' : 'SHORT'
  if (usedRSI !== null){ if (usedRSI > 70) direction = 'SHORT'; if (usedRSI < 30) direction = 'LONG' }

  // confidence heuristic
  let confidence = 70 + Math.min(25, Math.abs(slope)*100)
  if (usedRSI !== null){ if ((usedRSI>70 && direction==='SHORT') || (usedRSI<30 && direction==='LONG')) confidence += 5 }
  confidence = Math.max(50, Math.min(98, Math.round(confidence)))

  // build 10 point prediction
  const prediction = []
  const vol = closes.length ? closes.slice(-30).reduce((a,b)=>a+b,0)/30 : 1
  for (let i=1;i<=10;i++){
    let delta = (slope || 0) * (i) * (closes.length? Math.abs(closes[closes.length-1])*0.001 : 1)
    // if RSI indicates correction
    if (usedRSI > 70) delta -= Math.abs((usedRSI-70)/70) * Math.random() * lastClose * 0.01 * i
    if (usedRSI < 30) delta += Math.abs((30-usedRSI)/30) * Math.random() * lastClose * 0.01 * i
    const noise = (Math.random()-0.5) * lastClose * 0.003
    const val = Math.max(0.0001, +(lastClose + delta + noise).toFixed(4))
    prediction.push(val)
  }

  const out = {
    status: 'Vortex_Confirmed',
    direction,
    confidence: `${confidence}%`,
    target_levels: levels,
    prediction_array: prediction,
    logic_short: usedRSI ? `RSI=${usedRSI}; slope=${slope.toFixed(6)}; levels=${JSON.stringify(levels)}` : `slope=${slope.toFixed(6)}; levels=${JSON.stringify(levels)}`
  }

  setCache(key, out)
  return out
}

export { computeRSI }

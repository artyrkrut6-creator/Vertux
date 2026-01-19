const fs = require('fs')
const fetch = global.fetch || require('node-fetch')
const path = require('path')
const Model = require('./models/online_model')

function readKeys(){
  try{
    const raw = fs.readFileSync(path.join(__dirname,'mexc'),'utf8').trim().split(/\r?\n/)
    return { apiKey: raw[0]||'', secret: raw[1]||'' }
  }catch(e){ return { apiKey:'', secret:'' } }
}

async function listSymbols(){
  // Try several known public endpoints for MEXC; return fallback list if none succeed
  const endpoints = [
    'https://www.mexc.com/open/api/v2/market/symbols',
    'https://api.mexc.com/api/v3/symbols',
    'https://api.mexc.com/api/v3/exchangeInfo'
  ]
  for (const url of endpoints){
    try{
      const r = await fetch(url)
      if (!r.ok) continue
      const j = await r.json()
      // handle shapes: { data: [...] } or { symbols: [...] } or { symbols: { symbol, baseAsset } }
      if (Array.isArray(j.data)){
        const arr = j.data.map(s=> s.symbol || s.symbolName || (s.baseCurrency && s.quoteCurrency ? `${s.baseCurrency}_${s.quoteCurrency}` : null)).filter(Boolean)
        if (arr.length) return arr
      }
      if (Array.isArray(j.symbols)){
        const arr = j.symbols.map(s=> s.symbol || (s.baseAsset && s.quoteAsset ? `${s.baseAsset}_${s.quoteAsset}` : null)).filter(Boolean)
        if (arr.length) return arr
      }
    }catch(e){ /* ignore and try next */ }
  }
  // fallback: return a reasonable small set so UI remains usable
  return ['BTC_USDT','ETH_USDT','COA_USDT','XRP_USDT','LTC_USDT']
}

async function fetchKlines(symbol='BTC_USDT', interval='1m', limit=100){
  try{
    const url = `https://www.mexc.com/open/api/v2/market/kline?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`
    const r = await fetch(url)
    if (!r.ok) return []
    const json = await r.json()
    if (json && Array.isArray(json.data)){
      return json.data.map(d=>({ t: d[0], open: Number(d[1]), high: Number(d[2]), low: Number(d[3]), close: Number(d[4]) }))
    }
  }catch(e){}
  return []
}

function simpleSignalFromHistory(closes){
  if (!closes || closes.length<5) return { signal: 'neutral', timeframe: '1m', reason: 'insufficient_data' }
  // compute short EMA and long EMA
  const ema = (data,p)=>{ const k=2/(p+1); let s=data[0]; for(let i=1;i<data.length;i++) s=(data[i]*k)+(s*(1-k)); return s }
  const ema5 = ema(closes.slice(-10),5)
  const ema20 = ema(closes.slice(-30),13)
  const last = closes[closes.length-1]
  const rel = (ema5 - ema20) / Math.max(1, last)
  if (rel > 0.0006) return { signal: 'long', timeframe: '1m', confidence: Math.min(0.99, Math.abs(rel)*1000) }
  if (rel < -0.0006) return { signal: 'short', timeframe: '1m', confidence: Math.min(0.99, Math.abs(rel)*1000) }
  return { signal: 'neutral', timeframe: '1m', confidence: 0.5 }
}

async function modelSignalForPair(symbol='COA_USDT', timeframe='1m', steps=5){
  // fetch recent klines from MEXC (or fallback to Binance if MEXC fails)
  let klines = await fetchKlines(symbol, timeframe, 200)
  if (!klines.length){
    // try Binance format symbol conversion
    const b = symbol.replace('_','')
    try{
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${b}&interval=${timeframe}&limit=200`)
      if (r.ok){ const data = await r.json(); klines = data.map(i=>({ t: i[0], open: Number(i[1]), high: Number(i[2]), low: Number(i[3]), close: Number(i[4]) })) }
    }catch(e){}
  }
  const closes = klines.map(k=>k.close)
  // simple heuristic first
  const heuristic = simpleSignalFromHistory(closes)
  // then model-based short prediction: predict next N closes and see direction
  const modelPred = Model.predict(closes, steps)
  const avgPred = modelPred.reduce((s,v)=>s+v,0)/modelPred.length
  const last = closes[closes.length-1] || avgPred
  // avoid labeling tiny numerical differences as a directional signal
  const relDiff = Math.abs(avgPred - last) / Math.max(1, last)
  const minRelForSignal = 0.0005 // 0.05% change required to consider direction
  let dir = 'neutral'
  if (relDiff >= minRelForSignal) dir = avgPred > last ? 'long' : 'short'
  const confidence = Math.min(0.99, relDiff * 100)
  // combine heuristic and model: require agreement for stronger signal
  const final = { symbol, timeframe, model_dir: dir, model_confidence: confidence, heuristic: heuristic.signal, heuristic_confidence: heuristic.confidence }
  if (heuristic.signal === dir) final.signal = dir
  else final.signal = heuristic.signal === 'neutral' ? dir : 'neutral'
  return final
}

module.exports = { readKeys, listSymbols, fetchKlines, modelSignalForPair }

async function debugForPair(symbol='COA_USDT', timeframe='1m', steps=5){
  let klines = await fetchKlines(symbol, timeframe, 200)
  if (!klines.length){
    const b = symbol.replace('_','')
    try{ const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${b}&interval=${timeframe}&limit=200`); if (r.ok){ const data = await r.json(); klines = data.map(i=>({ t: i[0], open: Number(i[1]), high: Number(i[2]), low: Number(i[3]), close: Number(i[4]) })) }}catch(e){}
  }
  const closes = klines.map(k=>k.close)
  const heuristic = simpleSignalFromHistory(closes)
  const feats = Model.featuresFromHistory(closes)
  const modelPred = Model.predict(closes, steps)
  const avgPred = modelPred.reduce((s,v)=>s+v,0)/modelPred.length
  const last = closes[closes.length-1] || avgPred
  const relDiff = Math.abs(avgPred - last) / Math.max(1, last)
  const minRelForSignal = 0.0005
  let dir = 'neutral'
  if (relDiff >= minRelForSignal) dir = avgPred > last ? 'long' : 'short'
  const confidence = Math.min(0.99, relDiff * 100)
  const modelScore = { avgPred, relDiff, dir, confidence }
  const final = { symbol, timeframe, heuristic, features: feats, model: modelScore }
  if (heuristic.signal === dir && dir !== 'neutral') final.signal = dir
  else final.signal = heuristic.signal === 'neutral' ? dir : 'neutral'
  final.reason = heuristic.signal === final.signal ? 'heuristic_agrees' : (dir===final.signal ? 'model_overrides' : 'disagreement_or_small_move')
  return final
}

module.exports.debugForPair = debugForPair

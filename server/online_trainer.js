const express = require('express')
const fs = require('fs')
const path = require('path')
const fetch = global.fetch || require('node-fetch')
const Model = require('./models/online_model')

const router = express.Router()

const PRED_PATH = path.join(__dirname, 'data', 'predictions.jsonl')
const CHECKPOINT_DIR = path.join(__dirname, 'models', 'checkpoints')
function ensureDir(p){ try{ fs.mkdirSync(path.dirname(p), { recursive: true }) }catch(e){} }
ensureDir(PRED_PATH)

let trainer = { running: false, intervalMs: 10*60*1000, timer: null }

async function fetchKlines1m(limit=60){
  try{
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`
    const r = await fetch(url)
    if (!r.ok) return []
    const data = await r.json()
    return data.map(item=>({ time: item[0], open: parseFloat(item[1]), high: parseFloat(item[2]), low: parseFloat(item[3]), close: parseFloat(item[4]) }))
  }catch(e){ return [] }
}

function buildCandlesFromCloses(closeArr, startTimestamp, intervalMs=60000){
  const out = []
  for(let i=0;i<closeArr.length;i++){
    const close = Number(closeArr[i])
    const t = Number(startTimestamp) + i*intervalMs
    const open = i===0 ? Number((closeArr[i] - (closeArr[1] ? (closeArr[1]-closeArr[0]) : 0)).toFixed(2)) : Number(closeArr[i-1].toFixed(2))
    const spread = Math.max(1, Math.abs(close - open)*0.25)
    const high = Number((Math.max(open, close) + spread).toFixed(2))
    const low = Number((Math.min(open, close) - spread).toFixed(2))
    out.push({ t, open: Number(open.toFixed(2)), high, low, close: Number(close.toFixed(2)) })
  }
  return out
}

async function fetchActualClosesForTimestamps(timestamps){
  const results = []
  for(const t of timestamps){
    try{
      const start = Number(t)
      const end = start + 60000
      const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${start}&endTime=${end}&limit=1`
      const r = await fetch(url)
      if (!r.ok){ results.push(null); continue }
      const data = await r.json()
      if (!Array.isArray(data) || !data.length){ results.push(null); continue }
      results.push(parseFloat(data[0][4]))
    }catch(e){ results.push(null) }
  }
  return results
}

function computeMetrics(forecastArray, actualCloses){
  const paired = []
  for(let i=0;i<forecastArray.length && i<actualCloses.length;i++){
    const a = actualCloses[i]
    const f = Number(forecastArray[i] && forecastArray[i].close)
    if (a==null || !isFinite(a) || !isFinite(f)) continue
    paired.push({ f, a })
  }
  if (!paired.length) return { mae: null, rmse: null, count: 0 }
  let se=0, ae=0
  for(const p of paired){ const e = Math.abs(p.f - p.a); ae += e; se += (p.f - p.a)*(p.f - p.a) }
  const mae = ae/paired.length
  const rmse = Math.sqrt(se/paired.length)
  return { mae, rmse, count: paired.length }
}

async function doCycle(steps=10){
  try{
    const klines = await fetchKlines1m(60)
    if (!klines.length) return
    const closes = klines.map(c=>c.close)
    const lastTs = klines[klines.length-1].time
    const preds = Model.predict(closes, steps)
    const forecast = buildCandlesFromCloses(preds, Math.floor((lastTs + 60000)/60000)*60000)
    const entry = { ts: new Date().toISOString(), model: 'online_model', model_version: (Model.load && Model.load().version)||1, steps, prediction: forecast }
    try{ fs.appendFileSync(PRED_PATH, JSON.stringify(entry) + '\n') }catch(e){ console.warn('write pred error', e) }

    // Schedule evaluation after horizon
    setTimeout(async ()=>{
      try{
        const timestamps = forecast.map(f=>f.t)
        const actuals = await fetchActualClosesForTimestamps(timestamps)
        const metrics = computeMetrics(forecast, actuals)
        // prepare training batch: for each step, extract features from history + previously predicted steps
        const batchFeatures = []
        const batchTargets = []
        // form per-step training samples using the original closes + previously predicted points up to that step
        for(let i=0;i<forecast.length;i++){
          const seed = closes.slice() // start with historical closes
          const toPush = preds.slice(0,i) // predicted earlier steps
          for(const p of toPush) seed.push(p)
          const last = seed[seed.length-1] || 0
          // use shared feature extractor from Model to ensure consistency and normalization
          const feats = Model.featuresFromHistory(seed)
          const actual = actuals[i]
          if (actual != null && isFinite(actual)){
            batchFeatures.push({ feats, last })
            batchTargets.push(actual)
          }
        }
        if (batchFeatures.length){
          const upd = Model.update(batchFeatures, batchTargets)
          // persist metrics and training info
          const path = './pred_metrics.json'
          let arr = []
          try{ arr = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path,'utf8'))||[] : [] }catch(e){ arr = [] }
          arr.push({ ts: new Date().toISOString(), entry, metrics, trained: !!upd.ok })
          try{ fs.writeFileSync(path, JSON.stringify(arr, null, 2)) }catch(e){ console.warn('persist metrics fail', e) }
        }
      }catch(e){ console.warn('evaluation error', e) }
    }, steps*60*1000 + 5000)
  }catch(e){ console.warn('doCycle error', e) }
}

router.get('/status', (req, res)=>{ res.json({ running: trainer.running, intervalMs: trainer.intervalMs }) })

router.post('/start', (req, res)=>{
  if (trainer.running) return res.json({ status: 'already_running' })
  const body = req.body || {}
  trainer.intervalMs = Number(body.intervalMs) || trainer.intervalMs
  trainer.running = true
  trainer.timer = setInterval(()=>{ doCycle(body.steps || 10).catch(e=>console.warn('cycle failed', e)) }, trainer.intervalMs)
  // run immediately once
  doCycle(body.steps || 10).catch(e=>console.warn('initial cycle failed', e))
  res.json({ status: 'started', intervalMs: trainer.intervalMs })
})

router.post('/stop', (req, res)=>{
  if (!trainer.running) return res.json({ status: 'not_running' })
  clearInterval(trainer.timer)
  trainer.running = false
  trainer.timer = null
  res.json({ status: 'stopped' })
})

// Force a single prediction cycle (useful for manual testing)
router.post('/predict-now', async (req, res)=>{
  try{
    const steps = (req.body && Number(req.body.steps)) || 10
    await doCycle(steps)
    return res.json({ status: 'ok', triggered: true })
  }catch(e){ return res.status(500).json({ error: String(e) }) }
})

module.exports = router

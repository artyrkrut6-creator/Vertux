const fs = require('fs')
const path = require('path')

const MODEL_PATH = path.join(__dirname, 'checkpoints', 'model.json')

function ensureDir(p){ try{ fs.mkdirSync(path.dirname(p), { recursive: true }) }catch(e){} }

function defaultModel(nFeatures=6){
  // initialize weights to zero to avoid random noisy outputs before any training
  return { version: 1, nFeatures, weights: Array(nFeatures).fill(0), bias: 0, lr: 1e-6 }
}

function load(){
  try{
    if (!fs.existsSync(MODEL_PATH)) { ensureDir(MODEL_PATH); const m = defaultModel(); fs.writeFileSync(MODEL_PATH, JSON.stringify(m, null, 2)); return m }
    const raw = fs.readFileSync(MODEL_PATH,'utf8')
    const parsed = JSON.parse(raw)
    // sanity checks: avoid numeric explosions from previous runs
    if (!parsed || !Array.isArray(parsed.weights)) return defaultModel()
    for (const w of parsed.weights) if (!isFinite(w) || Math.abs(w) > 1e50) return defaultModel()
    if (!isFinite(parsed.bias) || Math.abs(parsed.bias) > 1e50) return defaultModel()
    return parsed
  }catch(e){ console.warn('online_model load error', e); return defaultModel() }
}

function save(model){ try{ ensureDir(MODEL_PATH); fs.writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2)) }catch(e){ console.warn('online_model save error', e) } }

function dot(a,b){ let s=0; for(let i=0;i<a.length;i++) s+=a[i]*b[i]; return s }

function featuresFromHistory(history){
  // history: array of closes (numbers)
  const arr = Array.isArray(history)?history.slice(-300).map(Number).filter(n=>isFinite(n)):[]
  const last = arr[arr.length-1]||0
  const ema = (data, p)=>{ if(!data.length) return last; const k=2/(p+1); let s=data[0]; for(let i=1;i<data.length;i++) s=(data[i]*k)+(s*(1-k)); return s }
  const ema5 = ema(arr, Math.min(5, arr.length))
  const ema13 = ema(arr, Math.min(13, arr.length))
  const slope = (arr.length>1) ? ((arr[arr.length-1]-arr[0])/(arr.length-1)) : 0
  const atr = (()=>{ if(arr.length<2) return 0; let trs=[]; for(let i=1;i<arr.length;i++) trs.push(Math.abs(arr[i]-arr[i-1])); const p=Math.min(14, trs.length); const a=trs.slice(-p); return a.reduce((s,v)=>s+v,0)/Math.max(1,a.length) })()
  const rsi = (()=>{ if(arr.length<2) return 50; let gains=0,losses=0; for(let i=1;i<arr.length;i++){ const d=arr[i]-arr[i-1]; if(d>0) gains+=d; else losses+=Math.abs(d) } const avgG=gains/Math.max(1,arr.length-1); const avgL=losses/Math.max(1,arr.length-1); if(avgL===0) return 100; const rs=avgG/avgL; return 100-(100/(1+rs)) })()
  // Normalize features relative to last price to keep outputs on-price-scale
  const eps = Math.max(1e-8, Math.abs(last))
  const f1 = ema5 / eps
  const f2 = ema13 / eps
  const f3 = slope / eps
  const f4 = atr / eps
  const f5 = rsi / 100
  const f6 = 1 // constant feature
  return [ f1, f2, f3, f4, f5, f6 ]
}

const Model = {
  load,
  save,
  featuresFromHistory,
  predict(history, steps=10){
    const m = load()
    const out = []
    let sim = Array.isArray(history)?history.slice() : []
    for(let i=0;i<steps;i++){
      const last = sim[sim.length-1] || 0
      const feats = featuresFromHistory(sim)
      // relative prediction around last price: pred = last * (1 + dot(weights, feats)) + bias
      const rel = dot(feats, m.weights)
      const pred = last * (1 + rel) + m.bias
      // do NOT round intermediate simulated prices to avoid amplification of tiny random noise
      out.push(Number(pred.toFixed(2)))
      sim.push(pred)
    }
    return out
  },
  update(batchFeatures, batchTargets){
    // batchFeatures: [ { history, feats }, ... ] ; batchTargets: [y1, y2,...]
    try{
      const m = load()
      const lr = m.lr || 1e-8
      const maxGrad = 1e3
      for(let i=0;i<Math.min(batchFeatures.length, batchTargets.length); i++){
        const item = batchFeatures[i]
        const x = Array.isArray(item.feats) ? item.feats : item // support old format
        const last = item.last || (x[0] || 1)
        const y = batchTargets[i]
        const pred = last * (1 + dot(x, m.weights)) + m.bias
        const err = pred - y
        // SGD update with gradient clipping (chain rule for last scaling)
        for(let j=0;j<m.weights.length;j++){
          const grad = err * last * x[j]
          const cgrad = Math.max(-maxGrad, Math.min(maxGrad, grad))
          m.weights[j] = m.weights[j] - lr * cgrad
        }
        const cb = Math.max(-maxGrad, Math.min(maxGrad, err))
        m.bias = m.bias - lr * cb
      }
      save(m)
      return { ok: true }
    }catch(e){ return { ok: false, error: String(e) } }
  }
}

module.exports = Model

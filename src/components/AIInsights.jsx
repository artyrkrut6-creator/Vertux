import React, { useState } from 'react'
import { fetchOHLC } from '../services/marketService'
import { getVortexForecast } from '../services/vortexService'

export default function AIInsights(){
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)

  async function runSample(){
    setLoading(true)
    try{
      // fetch recent 50 1m candles and request Vortex (SiliconFlow) forecast via server proxy
      const ohlc = await fetchOHLC('BTCUSDT', '1m', 50)
      const vortex = await getVortexForecast(ohlc, '1m')
      // keep a compact result for display
      const compact = {
        sentiment: vortex.sentiment || (vortex.verdict ? vortex.verdict : 'neutral'),
        analysis: vortex.analysis || vortex.text || (vortex.verdict || ''),
        forecastLength: Array.isArray(vortex.forecast) ? vortex.forecast.length : (vortex.forecast ? vortex.forecast.length : 0),
        raw: vortex
      }
      setResult(compact)
    }catch(e){ setResult({ error: String(e) }) }
    setLoading(false)
  }

  return (
    <div className="mt-4 glass-card p-3 rounded">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-gray-200">AI Insights</div>
          <div className="text-xs text-gray-400">Детерминированный локальный прогноз Deepsik</div>
        </div>
        <div>
          <button onClick={runSample} className="px-3 py-2 bg-primary rounded text-black text-sm">Run</button>
        </div>
      </div>
      <div className="mt-3 text-xs text-gray-300">
        {loading && <div>Loading…</div>}
        {result && (
          <div className="space-y-2">
            <div className={`text-sm font-medium ${result.sentiment==='bullish'? 'text-emerald-400' : result.sentiment==='bearish' ? 'text-red-400' : 'text-gray-300'}`}>Sentiment: {result.sentiment}</div>
            <div className="text-xs text-gray-300">{result.analysis}</div>
            <div className="text-xs text-gray-400">Forecast points: {result.forecastLength}</div>
            <details className="text-xs text-left max-h-60 overflow-auto bg-black/40 p-2 rounded"><summary>Raw response</summary><pre className="mt-2">{JSON.stringify(result.raw, null, 2)}</pre></details>
          </div>
        )}
      </div>
    </div>
  )
}

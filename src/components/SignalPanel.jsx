import React, { useEffect, useMemo, useState } from 'react'

export default function SignalPanel({ defaultSymbol = 'COA_USDT' }){
  const [symbol, setSymbol] = useState(defaultSymbol)
  const [timeframe, setTimeframe] = useState('1m')
  const [steps, setSteps] = useState(5)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [symbols, setSymbols] = useState([defaultSymbol])
  const [filter, setFilter] = useState('')

  useEffect(()=>{
    let mounted = true
    fetch('/api/signals/symbols')
      .then(r=>r.json())
      .then(j=>{ if (!mounted) return; if (j && j.symbols) setSymbols(j.symbols) })
      .catch(()=>{})
    return ()=>{ mounted = false }
  },[])

  const filtered = useMemo(()=>{
    const q = (filter||'').trim().toLowerCase()
    if (!q) return symbols
    return symbols.filter(s => s.toLowerCase().includes(q))
  },[symbols, filter])

  async function getSignal(){
    setLoading(true)
    setResult(null)
    try{
      const res = await fetch('/api/signals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, timeframe, steps })
      })
      const text = await res.text()
      let j = null
      try{ j = text ? JSON.parse(text) : { error: 'empty_response' } }catch(e){ j = { error: 'invalid_json', raw: text } }
      setResult(j)
    }catch(e){ setResult({ error: String(e) }) }
    setLoading(false)
  }

  return (
    <div className="mt-4 p-4 bg-white/5 rounded-lg border border-gray-800">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="text-sm font-semibold text-white">Сигналы</h4>
          <div className="text-xs text-gray-400">Быстрый запрос локальной модели</div>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-300 mb-1">Поиск монеты</label>
          <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="COA_USDT или часть названия" className="w-full p-2 bg-black/60 text-white rounded" />
        </div>

        <div>
          <label className="block text-xs text-gray-300 mb-1">Выберите символ</label>
          <select value={symbol} onChange={e=>setSymbol(e.target.value)} className="w-full p-2 bg-black/60 text-white rounded">
            {filtered.length === 0 && <option value="">-- нет совпадений --</option>}
            {filtered.map(s=> <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-xs text-gray-300 mb-1">TF</label>
            <select value={timeframe} onChange={e=>setTimeframe(e.target.value)} className="w-full p-2 bg-black/60 text-white rounded">
              <option value="1m">1m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-gray-300 mb-1">Шаги</label>
            <input type="number" value={steps} min={1} max={240} onChange={e=>setSteps(Number(e.target.value||1))} className="w-full p-2 bg-black/60 text-white rounded" />
          </div>
        </div>

        <div>
          <button onClick={getSignal} disabled={loading} className="w-full py-2 bg-emerald-400 text-black rounded hover:brightness-95">
            {loading? 'Запрос...' : 'Получить сигнал'}
          </button>
        </div>

        <div>
          <div className="text-xs text-gray-400 mb-1">Результат</div>
          <pre className="text-xs bg-black/60 p-2 rounded text-white overflow-auto" style={{maxHeight:220}}>{result ? JSON.stringify(result, null, 2) : 'Нет результатов'}</pre>
        </div>
      </div>
    </div>
  )
}

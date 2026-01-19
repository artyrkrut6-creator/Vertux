// marketService: fetch OHLC candlesticks from Binance public API

const INTERVAL_MAP = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
  '1d': '1d'
}

export async function fetchOHLC(symbol = 'BTCUSDT', timeframe = '1m', limit = 200){
  try{
    const interval = INTERVAL_MAP[timeframe] || '1m'
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) throw new Error('Klines fetch failed')
    const data = await res.json()
    // data: [ [ openTime, open, high, low, close, ... ], ... ]
    return data.map(item => ({
      time: Math.floor(item[0] / 1000),
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4])
    }))
  }catch(e){
    console.error('fetchOHLC error', e)
    return []
  }
}

export function intervalSecondsFor(tf){
  const map = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1D': 86400, '1d': 86400 }
  return map[tf] || 60
}

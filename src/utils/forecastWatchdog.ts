import { DeepSeekPredictionMock } from '../types';

export function checkForecastAccuracy(currentPrice: number, forecastPrice: number): boolean {
  const deviationPct = (Math.abs(forecastPrice - currentPrice) / (currentPrice || 1)) * 100;
  return deviationPct > 0.15;
}

// Try to retrieve latest scheduled forecast from the server and synthesize a compact 5-point
// DeepSeek-like prediction. Falls back to a local mock when the server is unavailable.
export async function fetchDeepSeekPrediction(symbol: string): Promise<DeepSeekPredictionMock> {
  try {
    const resp = await fetch('/api/scheduler/latest');
    if (!resp.ok) throw new Error('no_latest')
    const data = await resp.json()
    const arr = (data && data.parsed && Array.isArray(data.parsed.forecast_1m)) ? data.parsed.forecast_1m : []
    if (arr.length) {
      const first5 = arr.slice(0, 5)
      const points = first5.map((c: any) => Number(c.close))
      const upper = first5.map((c: any) => Number(c.high) || Number(c.close) * 1.0025)
      const lower = first5.map((c: any) => Number(c.low) || Number(c.close) * 0.9975)

      // Derive a simple confidence score from relative range (higher range -> lower confidence)
      const closes = points.filter(Number.isFinite)
      const mean = closes.length ? closes.reduce((s, v) => s + v, 0) / closes.length : 0
      const range = closes.length ? (Math.max(...closes) - Math.min(...closes)) : 0
      const rel = mean ? range / mean : 0
      let confidence = Math.max(30, Math.min(95, Math.floor(100 - rel * 10000)))
      if (!Number.isFinite(confidence)) confidence = 75

      return { points, upper, lower, confidence } as DeepSeekPredictionMock
    }
  } catch (e) {
    // swallow and fall back to mock below
  }

  // Fallback mock (keeps previous behavior but async)
  const base = 100
  const points: number[] = []
  const upper: number[] = []
  const lower: number[] = []
  let last = base
  for (let i = 0; i < 5; i++) {
    const delta = (Math.random() - 0.5) * 0.002 * base
    last = Math.max(0.0001, last + delta)
    points.push(Number(last.toFixed(6)))
    const conf = 0.01 * base
    upper.push(Number((last + conf).toFixed(6)))
    lower.push(Number(Math.max(0, last - conf).toFixed(6)))
  }
  const confidence = Math.floor(75 + Math.random() * 25)
  return { points, upper, lower, confidence } as DeepSeekPredictionMock
}

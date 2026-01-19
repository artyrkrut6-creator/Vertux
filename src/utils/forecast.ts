export function checkForecastAccuracy(currentPrice: number, forecastPrice: number, thresholdPct = 0.15): boolean {
  if (!currentPrice || !forecastPrice) return true;
  const deviationPct = (Math.abs(currentPrice - forecastPrice) / currentPrice) * 100;
  return deviationPct > thresholdPct;
}

export interface ForecastPoint {
  time: number;
  price: number;
  upper: number;
  lower: number;
}

export function fetchDeepSeekPrediction(symbol: string, currentPrice = 0): Promise<ForecastPoint[]> {
  // Mock: generate 5 future points with small noise and a confidence band
  const now = Date.now();
  const base = currentPrice || 1;
  const points: ForecastPoint[] = [];
  for (let i = 1; i <= 5; i++) {
    const drift = (Math.sin(i) * 0.002 + Math.random() * 0.001) * base;
    const price = base + drift;
    const spread = Math.max(0.001 * base, Math.abs(drift) * 1.5);
    points.push({ time: now + i * 60_000, price, upper: price + spread, lower: price - spread });
  }
  return Promise.resolve(points);
}

export default { checkForecastAccuracy, fetchDeepSeekPrediction };

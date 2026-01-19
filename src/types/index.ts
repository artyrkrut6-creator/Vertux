export interface DetectedCoin {
  symbol: string;
  detectedAt: number; // ms
  expiresAt: number; // ms
  stdDev: number;
  price: number;
}

export interface ForecastPrediction {
  symbol: string;
  prediction: number[]; // 5 points
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: number; // 0-100
  logic: string;
}

export interface DeepSeekPredictionMock {
  points: number[]; // 5 points
  upper: number[];
  lower: number[];
  confidence: number; // 0-100
}

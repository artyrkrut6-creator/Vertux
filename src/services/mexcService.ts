import axios from 'axios';

// Single clean mexcService implementation that hits the backend proxy server
const API_BASE = '';

const api = axios.create({
  baseURL: API_BASE,
  timeout: 30_000,
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

export type Kline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchKlines(symbol: string, interval = '1m', limit = 15): Promise<Kline[]> {
  const url = `/api/exchange/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const res = await api.get(url);
  return Array.isArray(res.data) ? (res.data as Kline[]) : [];
}

export async function fetchTickerPrice(symbol: string): Promise<number> {
  const url = `/api/exchange/price?symbol=${encodeURIComponent(symbol)}`;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await api.get(url);
      const data = res.data;
      return Number(data?.price ?? data?.lastPrice ?? 0);
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await sleep(500);
    }
  }
  return 0;
}

export interface FetchTickersOpts {
  quote?: string;
  minVolume?: number;
  minChangePct?: number;
  limit?: number;
}

export async function fetch24hrTickers(opts: FetchTickersOpts = {}): Promise<any[]> {
  const params: string[] = [];
  if (opts.quote) params.push(`quote=${encodeURIComponent(opts.quote)}`);
  if (opts.minVolume) params.push(`minVolume=${encodeURIComponent(String(opts.minVolume))}`);
  if (opts.minChangePct) params.push(`minChangePct=${encodeURIComponent(String(opts.minChangePct))}`);
  if (opts.limit) params.push(`limit=${encodeURIComponent(String(opts.limit))}`);
  const q = params.length ? `?${params.join('&')}` : '';
  const url = `/api/exchange/tickers${q}`;
  const res = await api.get(url);
  return Array.isArray(res.data) ? res.data : [];
}

export default {
  fetchKlines,
  fetchTickerPrice,
  fetch24hrTickers,
};

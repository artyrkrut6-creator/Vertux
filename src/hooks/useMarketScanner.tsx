import { useEffect, useRef } from 'react';
import mexcService from '../services/mexcService';
import { useScannerStore } from '../store/scannerStore';

function stdDev(values: number[]): number {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function chunk<T>(arr: T[], size = 5): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function useMarketScanner({
  enabled = true,
  batchSize = 5,
  limitPairs = 50,
  minVolume = 200_000
} = {}) {
  const running = useRef(false);
  const addDetectedCoin = useScannerStore((s) => s.addDetectedCoin);

  async function scanOnce() {
    try {
      console.log('[MarketScanner] run start')
      // Ask server for a filtered list (reduces noise and API usage)
      const tickers = await (mexcService as any).fetch24hrTickers({ quote: 'USDT', minVolume, minChangePct: 0.25, limit: 100 });
      console.log('[MarketScanner] tickers fetched', Array.isArray(tickers) ? tickers.length : typeof tickers)

      // normalize
      const usdt = (tickers || [])
        .filter((t: any) => typeof t.symbol === 'string')
        .map((t: any) => ({
          symbol: t.symbol,
          price: Number(t.lastPrice ?? t.price ?? t.close ?? 0),
          quoteVolume: Number(t.quoteVolume ?? t.quoteQty ?? t.volume ?? 0),
          priceChangePercent: Math.abs(Number(t.priceChangePercent ?? t.priceChange ?? 0))
        }))
        .filter((t: any) => t.quoteVolume >= minVolume);

      // top volatile by price change percent
      const top = usdt.sort((a: any, b: any) => b.priceChangePercent - a.priceChangePercent).slice(0, limitPairs);

      const groups = chunk(top, batchSize);
      console.log('[MarketScanner] scanning groups', groups.length)

      for (const g of groups) {
        await Promise.all(
          g.map(async (pair) => {
            try {
              const klines = await mexcService.fetchKlines(pair.symbol, '1m', 15);
              const closes = (klines || []).map((k: any) => Number(k.close ?? k[4] ?? 0)).filter(Boolean);
              if (closes.length === 0) return;
              const sd = stdDev(closes);
              const currentPrice = pair.price || closes[closes.length - 1] || 0;
              const rel = (sd / (currentPrice || 1)) * 100;

              if (rel < 0.12) {
                try {
                  // validate symbol exists / has price before adding to store
                  const validatedPrice = await mexcService.fetchTickerPrice(pair.symbol);
                  if (validatedPrice && Number.isFinite(Number(validatedPrice))) {
                    const now = Date.now();
                    addDetectedCoin({
                      symbol: pair.symbol,
                      detectedAt: now,
                      expiresAt: now + 45 * 1000,
                      stdDev: sd,
                      price: validatedPrice
                    });
                    console.log('[MarketScanner] added', pair.symbol, 'price', validatedPrice.toFixed ? validatedPrice.toFixed(6) : validatedPrice)
                  }
                } catch (ve) {
                  console.warn('[MarketScanner] validate price failed for', pair.symbol, ve && ve.message ? ve.message : ve)
                }
              }
            } catch (e) {
              console.warn('[MarketScanner] per-pair error', pair.symbol, e && e.message ? e.message : e)
            }
          })
        );
        // be polite to API
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (e) {
      // overall scan failure
      console.warn('Market scanner error', e);
    }
  }

  useEffect(() => {
    if (!enabled) return;
    if (running.current) return;
    running.current = true;

    // initial run
    scanOnce();

    // run every 30s for live scanning
    const id = setInterval(() => scanOnce(), 30_000);
    return () => {
      clearInterval(id);
      running.current = false;
    };
  }, [enabled, batchSize, limitPairs, minVolume]);
}

export default useMarketScanner;

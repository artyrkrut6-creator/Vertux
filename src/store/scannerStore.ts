import { create } from 'zustand';

export type CoinTag = 'AI' | 'FT';

export interface DetectedCoin {
  symbol: string;
  tag: CoinTag;
  detectedAt: number;
  expiresAt: number;

  // Volatility proxy used by scanner: relative StdDev% of last 1m closes
  stdDev: number;

  // Exchange style metrics
  price: number;
  quoteVolume?: number;     // 24h quote volume (USDT)
  change24hPct?: number;    // 24h price change percent from MEXC ticker
  // FT signals
  rsi?: number;
  signal?: 'LONG' | 'SHORT' | 'NEUTRAL' | string;
}

interface ScannerState {
  coins: DetectedCoin[];
  nextScanAt?: number;
  nextFtScan?: number;
  nextAiScan?: number;
  isPremium: boolean;
  addDetectedCoin: (coin: DetectedCoin) => void;
  removeExpiredCoins: () => void;
  removeCoin: (symbol: string) => void;
  setPremium: (status: boolean) => void;
  clear: () => void;
  setNextScanAt: (ts?: number) => void;
  setNextFtScan: (ts?: number) => void;
  setNextAiScan: (ts?: number) => void;
}

export const useScannerStore = create<ScannerState>((set) => ({
  coins: [],
  nextScanAt: undefined,
  nextFtScan: undefined,
  nextAiScan: undefined,
  isPremium: false,

  addDetectedCoin: (coin) => {
    set((state) => {
      const idx = state.coins.findIndex((c) => c.symbol === coin.symbol);
      if (idx >= 0) {
        const next = state.coins.slice();
        next[idx] = { ...next[idx], ...coin };
        return { coins: next };
      }
      return { coins: [coin, ...state.coins] };
    });
  },

  removeExpiredCoins: () => {
    const now = Date.now();
    set((state) => ({ coins: state.coins.filter((c) => c.expiresAt > now) }));
  },

  removeCoin: (symbol: string) => {
    set((state) => ({ coins: state.coins.filter((c) => String(c.symbol).toUpperCase() !== String(symbol).toUpperCase()) }));
  },

  setPremium: (status: boolean) => set(() => ({ isPremium: !!status })),

  clear: () => set({ coins: [] }),
  setNextScanAt: (ts) => set(() => ({ nextScanAt: ts })),
  setNextFtScan: (ts) => set(() => ({ nextFtScan: ts })),
  setNextAiScan: (ts) => set(() => ({ nextAiScan: ts })),
}));

setInterval(() => {
  try { useScannerStore.getState().removeExpiredCoins(); } catch (_) {}
}, 1000);

export default useScannerStore;
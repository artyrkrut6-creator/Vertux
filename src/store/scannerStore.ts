import { create } from 'zustand';

export type CoinTag = 'AI' | 'FT';

export interface DetectedCoin {
  symbol: string;
  tag: CoinTag;

  detectedAt: number;
  expiresAt: number;

  stdDev: number;

  price: number;
  quoteVolume?: number;
  change24hPct?: number;

  rsi?: number;
  signal?: 'LONG' | 'SHORT' | 'NEUTRAL' | string;

  status?: 'ACTIVE' | 'WON' | 'LOST' | string;
  removeAt?: number;

  spreadPct?: number;
  depthUSDT?: number;
  confidence?: number;
}

interface ScannerState {
  coins: DetectedCoin[];

  nextScanAt?: number;
  nextFtScan?: number;
  nextAiScan?: number;

  isPremium: boolean;

  // old API (still can be used)
  addDetectedCoin: (coin: DetectedCoin) => void;

  // NEW: snapshot ingest (идеальный вариант)
  replaceCoinsSnapshot: (list: DetectedCoin[]) => void;

  removeExpiredCoins: () => void;
  removeCoin: (symbol: string) => void;

  setPremium: (status: boolean) => void;
  clear: () => void;

  setNextScanAt: (ts?: number) => void;
  setNextFtScan: (ts?: number) => void;
  setNextAiScan: (ts?: number) => void;
}

// ---- local rules ----
const FT_FALLBACK_TTL_MS = 60_000;
const FT_MAX_TTL_MS = 2 * 60_000; // никогда не будет "1000 часов" для FT
const AI_PERSIST_TTL_MS = 365 * 24 * 60 * 60_000; // 1 год (условно бесконечно)
const AI_DONE_TTL_MS = 3000; // WON/LOST держим 3 секунды
const LOCAL_COOLDOWN_MS = 15 * 60_000; // чтобы FT не возрождал монету после AI

const normalizeSymbol = (s: string) => String(s || '').trim().toUpperCase();

const localCooldowns = new Map<string, number>();

function inCooldown(symbol: string) {
  const sym = normalizeSymbol(symbol);
  const until = localCooldowns.get(sym);
  if (!until) return false;
  if (Date.now() >= until) {
    localCooldowns.delete(sym);
    return false;
  }
  return true;
}

function setCooldown(symbol: string, ms: number) {
  localCooldowns.set(normalizeSymbol(symbol), Date.now() + ms);
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function safeNumber(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function computeExpiresAt(state: ScannerState, coin: DetectedCoin) {
  const now = Date.now();

  if (coin.tag === 'AI') {
    const st = String(coin.status || '').toUpperCase();
    if (st === 'WON' || st === 'LOST') {
      const ra = Number(coin.removeAt || 0);
      return ra && Number.isFinite(ra) ? ra : now + AI_DONE_TTL_MS;
    }
    return now + AI_PERSIST_TTL_MS;
  }

  // FT
  const nextFt = Number(state.nextFtScan || 0);
  const fallback = now + FT_FALLBACK_TTL_MS;

  let exp = Number(coin.expiresAt || 0);
  if (!Number.isFinite(exp) || exp <= 0) exp = fallback;

  const maxExp = now + FT_MAX_TTL_MS;
  const target = nextFt && nextFt > now ? nextFt : fallback;

  // expire не позже следующего FT, и не позже maxExp
  exp = Math.min(exp, target, maxExp);

  // не раньше чем через 1с (чтобы не мигало)
  exp = Math.max(exp, now + 1000);

  return exp;
}

function dedupePreferAI(list: DetectedCoin[]) {
  const map = new Map<string, DetectedCoin>();
  for (const c of list) {
    const sym = normalizeSymbol(c.symbol);
    if (!sym) continue;

    const prev = map.get(sym);
    if (!prev) {
      map.set(sym, { ...c, symbol: sym });
      continue;
    }

    // AI всегда сильнее FT
    if (prev.tag === 'AI' && c.tag === 'FT') continue;
    if (prev.tag === 'FT' && c.tag === 'AI') {
      map.set(sym, { ...prev, ...c, symbol: sym, tag: 'AI' });
      continue;
    }

    // одинаковый tag — merge
    map.set(sym, { ...prev, ...c, symbol: sym });
  }

  return Array.from(map.values());
}

export const useScannerStore = create<ScannerState>((set, get) => ({
  coins: [],
  nextScanAt: undefined,
  nextFtScan: undefined,
  nextAiScan: undefined,
  isPremium: false,

  addDetectedCoin: (coin) => {
    set((state) => {
      const now = Date.now();
      const sym = normalizeSymbol(coin.symbol);
      if (!sym) return state;

      if (coin.tag === 'FT' && inCooldown(sym)) return state;

      const incoming: DetectedCoin = {
        ...coin,
        symbol: sym,
        detectedAt: Number(coin.detectedAt || now),
        stdDev: Number(coin.stdDev || 0),
        price: Number(coin.price || 0),
        expiresAt: Number(coin.expiresAt || 0),
      };

      incoming.expiresAt = computeExpiresAt(state, incoming);

      const incomingStatus = String(incoming.status || '').toUpperCase();
      if (incoming.tag === 'AI' && (incomingStatus === 'WON' || incomingStatus === 'LOST')) {
        setCooldown(sym, LOCAL_COOLDOWN_MS);
        incoming.expiresAt = computeExpiresAt(state, incoming);
      }

      const idx = state.coins.findIndex((c) => normalizeSymbol(c.symbol) === sym);

      if (idx >= 0) {
        const prev = state.coins[idx];

        // AI приоритет: FT не переписывает AI
        if (prev.tag === 'AI' && incoming.tag === 'FT') {
          const merged: DetectedCoin = {
            ...prev,
            price: incoming.price || prev.price,
            quoteVolume: incoming.quoteVolume ?? prev.quoteVolume,
            change24hPct: incoming.change24hPct ?? prev.change24hPct,
            rsi: incoming.rsi ?? prev.rsi,
            stdDev: incoming.stdDev ?? prev.stdDev,
            expiresAt: prev.expiresAt,
          };
          const next = state.coins.slice();
          next[idx] = merged;
          return { coins: next };
        }

        // AI поверх FT
        if (prev.tag === 'FT' && incoming.tag === 'AI') {
          const next = state.coins.slice();
          next[idx] = { ...prev, ...incoming, tag: 'AI' };
          return { coins: next };
        }

        const next = state.coins.slice();
        next[idx] = { ...prev, ...incoming };
        return { coins: next };
      }

      return { coins: [incoming, ...state.coins] };
    });
  },

  replaceCoinsSnapshot: (list) => {
    set((state) => {
      const now = Date.now();

      // 1) если AI исчез из snapshot (сервер удалил быстро) — ставим cooldown,
      // чтобы он не вернулся FT на следующем же апдейте
      const prevAI = state.coins.filter((c) => c.tag === 'AI');
      const nextSymbolsAI = new Set(
        list
          .filter((c) => c.tag === 'AI')
          .map((c) => normalizeSymbol(c.symbol))
      );

      for (const ai of prevAI) {
        const sym = normalizeSymbol(ai.symbol);
        if (sym && !nextSymbolsAI.has(sym)) {
          setCooldown(sym, LOCAL_COOLDOWN_MS);
        }
      }

      // 2) нормализуем список + дедуп (AI > FT)
      const normalized = list
        .map((c) => {
          const sym = normalizeSymbol(c.symbol);
          const detectedAt = safeNumber(c.detectedAt) ?? now;
          return {
            ...c,
            symbol: sym,
            detectedAt,
            stdDev: Number(c.stdDev || 0),
            price: Number(c.price || 0),
            expiresAt: Number(c.expiresAt || 0),
          } as DetectedCoin;
        })
        .filter((c) => !!c.symbol);

      const deduped = dedupePreferAI(normalized);

      // 3) применяем TTL-правила и local cooldown фильтр для FT
      const finalList: DetectedCoin[] = [];
      for (const c of deduped) {
        if (c.tag === 'FT' && inCooldown(c.symbol)) continue;

        const cc: DetectedCoin = { ...c };
        cc.expiresAt = computeExpiresAt(state, cc);

        const st = String(cc.status || '').toUpperCase();
        if (cc.tag === 'AI' && (st === 'WON' || st === 'LOST')) {
          setCooldown(cc.symbol, LOCAL_COOLDOWN_MS);
          cc.expiresAt = computeExpiresAt(state, cc);
        }

        finalList.push(cc);
      }

      return { coins: finalList };
    });
  },

  removeExpiredCoins: () => {
    const now = Date.now();
    set((state) => {
      for (const [sym, until] of localCooldowns.entries()) {
        if (now >= until) localCooldowns.delete(sym);
      }

      const filtered = state.coins.filter((c) => {
        const exp = Number(c.expiresAt || 0);
        if (!Number.isFinite(exp) || exp <= 0) return false;

        // жёсткий анти-баг: FT не может жить 12 часов
        if (c.tag === 'FT' && exp - now > 12 * 60 * 60_000) return false;

        return exp > now;
      });

      return { coins: filtered };
    });
  },

  removeCoin: (symbol: string) => {
    const sym = normalizeSymbol(symbol);
    set((state) => ({ coins: state.coins.filter((c) => normalizeSymbol(c.symbol) !== sym) }));
  },

  setPremium: (status: boolean) => set(() => ({ isPremium: !!status })),

  clear: () => set({ coins: [] }),

  setNextScanAt: (ts) => set(() => ({ nextScanAt: ts })),
  setNextFtScan: (ts) => set(() => ({ nextFtScan: ts })),
  setNextAiScan: (ts) => set(() => ({ nextAiScan: ts })),
}));

// IMPORTANT: avoid multiple intervals on HMR
const g: any = globalThis as any;
if (!g.__vortexScannerStoreCleanupInterval) {
  g.__vortexScannerStoreCleanupInterval = setInterval(() => {
    try {
      useScannerStore.getState().removeExpiredCoins();
    } catch (_) {}
  }, 1000);
}

export default useScannerStore;
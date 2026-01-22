import React, { useEffect, useMemo, useState } from 'react';
import useScannerStore from '../store/scannerStore';
import logoSrc from '/nonfon.png';
import {
  Flame,
  Clock,
  Filter,
  X,
  Check,
  BarChart3,
  ScanLine,
  Search,
  CheckCircle,
  XCircle,
  Lock
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface Props {
  onSelect: (symbol: string) => void;
  selected?: string;
}

function fmtMMSS(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function fmtVol(n?: number) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '--';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return `${v.toFixed(0)}`;
}

function fmtPrice(p: number) {
  const v = Number(p);
  if (!Number.isFinite(v)) return '--';
  let d = 2;
  if (v < 1000) d = 3;
  if (v < 1) d = 5;
  if (v < 0.01) d = 7;
  return v.toFixed(d).replace(/\.?0+$/, '');
}

const FT_INTERVAL_MS = 60_000;

const Sidebar: React.FC<Props> = ({ onSelect, selected }) => {
  const { coins, nextFtScan, nextScanAt, isPremium } = useScannerStore((state) => ({
    coins: state.coins,
    nextFtScan: state.nextFtScan,
    nextScanAt: state.nextScanAt, // fallback
    isPremium: state.isPremium
  }));

  const [now, setNow] = useState(Date.now());
  const [isMobile, setIsMobile] = useState(false);
  const [logoBroken, setLogoBroken] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<'ALL' | 'AI' | 'LONG' | 'SHORT'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const containerClass = isMobile ? 'w-full h-full flex flex-col p-0' : 'w-[360px] h-full flex flex-col p-2';
  const panelClass = isMobile
    ? 'flex-1 bg-black/90 overflow-hidden flex flex-col relative'
    : 'flex-1 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl overflow-hidden flex flex-col shadow-2xl relative';

  const sorted = useMemo(() => {
    const q = String(searchQuery || '').trim().toUpperCase();

    return coins
      .filter((c) => {
        if (activeFilter === 'AI' && c.tag !== 'AI') return false;
        if (activeFilter === 'LONG' && c.signal !== 'LONG') return false;
        if (activeFilter === 'SHORT' && c.signal !== 'SHORT') return false;
        if (q && !String(c.symbol || '').toUpperCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.tag === 'AI' && b.tag !== 'AI') return -1;
        if (a.tag !== 'AI' && b.tag === 'AI') return 1;
        return (b.quoteVolume || 0) - (a.quoteVolume || 0);
      });
  }, [coins, activeFilter, searchQuery]);

  // FT Timer: 60 sec countdown from nextFtScan
  const effectiveNext = Number(nextFtScan || nextScanAt || 0);
  const hasTimer = effectiveNext > 0;

  const timeToNextScan = hasTimer ? Math.max(0, effectiveNext - now) : 0;
  const isScanning = !hasTimer || effectiveNext - now <= 0;

  const scanProgress = hasTimer
    ? Math.min(100, Math.max(0, ((FT_INTERVAL_MS - timeToNextScan) / FT_INTERVAL_MS) * 100))
    : 0;

  return (
    <aside className={containerClass}>
      <div className={panelClass}>
        {/* HEADER */}
        <div className="p-4 border-b border-white/10 bg-black/40 flex justify-between items-center z-20">
          <div className="flex items-center gap-3">
            <div className="relative w-10 h-10">
              <div className="absolute inset-0 bg-violet-500 blur-xl opacity-40 rounded-full"></div>
              {!logoBroken ? (
                <img
                  src={logoSrc}
                  alt="Vortex Logo"
                  onError={() => setLogoBroken(true)}
                  className="relative w-full h-full object-contain drop-shadow-[0_0_5px_rgba(139,92,246,0.5)]"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-white font-bold">V</div>
              )}
            </div>

            <div className="flex flex-col justify-center">
              <h1 className="text-xl font-black tracking-widest text-white leading-none font-[Eurostile,sans-serif]">
                VORTEX <span className="text-violet-500">AI</span>
              </h1>
              <span className="text-[9px] font-bold text-gray-500 tracking-[0.2em] uppercase mt-0.5">
                Quantum Market Scanner
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isScanning ? 'bg-yellow-400 animate-ping' : 'bg-green-500'}`} />
            <button
              onClick={() => setFilterOpen(!filterOpen)}
              className={`p-2 rounded-full transition-all ${
                filterOpen ? 'bg-white/20 text-white' : 'bg-white/5 text-gray-400 hover:text-white'
              }`}
            >
              {filterOpen ? <X size={18} /> : <Filter size={18} />}
            </button>
          </div>
        </div>

        {/* FILTER */}
        <AnimatePresence>
          {filterOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="bg-black/60 backdrop-blur-md border-b border-white/10 z-10 overflow-hidden"
            >
              <div className="p-3 grid grid-cols-2 gap-2">
                {[
                  { id: 'ALL', label: 'All Assets', color: 'bg-gray-700' },
                  { id: 'AI', label: 'AI Sniper', color: 'bg-violet-600' },
                  { id: 'LONG', label: 'Long Zone', color: 'bg-green-600' },
                  { id: 'SHORT', label: 'Short Zone', color: 'bg-red-600' }
                ].map((f) => (
                  <button
                    key={f.id}
                    onClick={() => {
                      setActiveFilter(f.id as any);
                      setFilterOpen(false);
                    }}
                    className={`p-3 rounded-xl flex items-center justify-between text-sm font-bold transition-all ${
                      activeFilter === f.id ? f.color + ' text-white shadow-lg' : 'bg-white/5 text-gray-400 hover:bg-white/10'
                    }`}
                  >
                    <span>{f.label}</span>
                    {activeFilter === f.id && <Check size={14} />}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* SEARCH */}
        <div className="px-3 py-2 border-b border-white/5">
          <div className="relative group">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within:text-violet-400 transition-colors" size={14} />
            <input
              type="text"
              placeholder="Search symbol..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-black/20 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder:text-gray-600 focus:outline-none focus:border-violet-500/50 transition-all uppercase font-mono"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* LIST */}
        <div className={`flex-1 overflow-y-auto ${isMobile ? 'p-3' : 'p-2'} space-y-2 custom-scrollbar relative`}>
          <AnimatePresence mode="popLayout" initial={false}>
            {sorted.map((c, index) => {
              const isAI = c.tag === 'AI';
              const detectedAt = c.detectedAt || Date.now();
              const activeMs = Math.max(0, now - detectedAt);

              let badge: React.ReactNode = null;

              if (String(c.status).toUpperCase() === 'WON') {
                badge = (
                  <span className="bg-green-600 text-white text-[10px] px-2 py-0.5 rounded shadow-[0_0_10px_#16a34a] font-bold flex items-center gap-1">
                    <CheckCircle size={10} /> WIN
                  </span>
                );
              } else if (String(c.status).toUpperCase() === 'LOST') {
                badge = (
                  <span className="bg-red-600 text-white text-[10px] px-2 py-0.5 rounded shadow-[0_0_10px_#dc2626] font-bold flex items-center gap-1">
                    <XCircle size={10} /> LOSS
                  </span>
                );
              } else if (isAI) {
                badge = (
                  <span className="bg-violet-600 text-white text-[10px] px-2 py-0.5 rounded shadow-[0_0_10px_#7c3aed] font-bold">
                    AI SNIPER
                  </span>
                );
              } else if (c.signal === 'LONG') {
                badge = (
                  <span className="bg-green-600 text-white text-[10px] px-2 py-0.5 rounded shadow-[0_0_10px_#16a34a] font-bold">
                    LONG ZONE
                  </span>
                );
              } else if (c.signal === 'SHORT') {
                badge = (
                  <span className="bg-red-600 text-white text-[10px] px-2 py-0.5 rounded shadow-[0_0_10px_#dc2626] font-bold">
                    SHORT ZONE
                  </span>
                );
              } else {
                badge = <span className="bg-orange-500/20 text-orange-300 text-[10px] px-2 py-0.5 rounded font-bold">VOLATILE</span>;
              }

              const isSelected = selected === c.symbol;
              const isFreeSlot = index < 2;
              const isLocked = !isPremium && !isFreeSlot;

              return (
                <motion.div
                  layout="position"
                  key={c.symbol}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.2 }}
                  onClick={() => !isLocked && onSelect(c.symbol)}
                  className={`
                    relative transition-colors cursor-pointer overflow-hidden group 
                    ${isMobile ? 'py-4 px-3' : 'p-3 rounded-xl border'} 
                    ${
                      isSelected
                        ? 'bg-white/10 border-violet-500/50 shadow-[0_0_15px_rgba(139,92,246,0.2)]'
                        : 'bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/20'
                    } 
                    ${isLocked ? 'blur-md opacity-50 pointer-events-none select-none grayscale' : ''}
                  `}
                >
                  <div className="flex justify-between items-start z-10 relative">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-md text-gray-100 group-hover:text-white transition-colors">{c.symbol}</span>
                        {badge}
                      </div>
                      <div className="flex items-center gap-3 text-xs font-mono text-gray-400">
                        <span className="text-white">${fmtPrice(c.price)}</span>
                        <span className="flex items-center gap-1 opacity-70">
                          <BarChart3 className="w-3 h-3" />
                          {fmtVol(c.quoteVolume)}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col items-end">
                      {isAI ? (
                        <>
                          <Flame className="w-4 h-4 text-violet-400 fill-violet-400/20 animate-pulse mb-1" />
                          <div className="text-xs font-mono text-cyan-300 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            Active: {fmtMMSS(activeMs)}
                          </div>
                        </>
                      ) : (
                        <span className={`${(c.change24hPct || 0) >= 0 ? 'text-green-400' : 'text-red-400'} text-xs font-bold`}>
                          {(c.change24hPct || 0) > 0 ? '+' : ''}{(c.change24hPct || 0).toFixed(2)}%
                        </span>
                      )}
                    </div>
                  </div>

                  {isAI && !c.status && (
                    <div className="absolute bottom-0 left-0 w-full h-[3px] bg-gray-700/20">
                      <div className="h-full bg-gradient-to-r from-violet-600 to-cyan-500 animate-pulse" style={{ width: '100%' }} />
                    </div>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>

          {!isPremium && sorted.length > 2 && (
            <div className="absolute bottom-0 left-0 w-full h-2/3 bg-gradient-to-t from-black via-black/80 to-transparent flex flex-col items-center justify-end pb-10 z-50 pointer-events-auto">
              <div className="bg-white/10 backdrop-blur-xl border border-white/20 p-4 rounded-2xl shadow-2xl flex flex-col items-center gap-3 w-3/4">
                <div className="w-10 h-10 bg-violet-600 rounded-full flex items-center justify-center shadow-[0_0_15px_#7c3aed] animate-pulse">
                  <Lock size={20} className="text-white" />
                </div>
                <div className="text-center">
                  <h3 className="text-white font-bold text-sm">PRO ACCESS LOCKED</h3>
                  <p className="text-gray-400 text-[10px] mt-1">Unlock AI Signals & Full List</p>
                </div>
                <button
                  onClick={() => {
                    const tg = (window as any).Telegram?.WebApp;
                    if (tg) {
                      try { tg.sendData('buy_pro'); tg.close(); } catch (_) { try { tg.close(); } catch {} }
                    } else {
                      window.open('https://t.me/VortexAIScannerBot', '_blank');
                    }
                  }}
                  className="w-full py-2 bg-gradient-to-r from-violet-600 to-indigo-600 rounded-lg text-xs font-bold text-white shadow-lg hover:scale-105 transition-transform"
                >
                  UNLOCK FOR 1000₽
                </button>
              </div>
            </div>
          )}

          {sorted.length === 0 && (
            <div className="flex flex-col items-center justify-center h-40 text-gray-500 text-sm opacity-50">
              <ScanLine className="w-8 h-8 mb-2 animate-spin-slow" />
              <span>Scanning Market...</span>
            </div>
          )}
        </div>

        {/* FOOTER TIMER */}
        <div className="p-3 bg-black/60 border-t border-white/10 text-center relative overflow-hidden">
          {isScanning ? (
            <div className="text-yellow-400 text-xs font-bold animate-pulse flex justify-center items-center gap-2 relative z-10">
              SCANNING...
            </div>
          ) : (
            <div className="text-xs font-mono text-gray-400 flex justify-between items-center px-2 relative z-10">
              <span>Next FT update:</span>
              <span className="text-cyan-400 font-bold text-sm">{fmtMMSS(timeToNextScan)}</span>
            </div>
          )}

          {!isScanning && (
            <div className="absolute bottom-0 left-0 h-1 bg-cyan-600/30 w-full">
              <div
                className="h-full bg-cyan-400 shadow-[0_0_10px_#22d3ee]"
                style={{ width: `${scanProgress}%`, transition: 'width 1s linear' }}
              />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
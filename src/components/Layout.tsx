import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Maximize2, Minimize2, ExternalLink, ChevronLeft, LayoutPanelLeft, ChevronUp, ChevronDown, Activity, X, ArrowLeft } from 'lucide-react';
import Sidebar from './Sidebar';
import ChartContainer from './ChartContainer';
import ChartBottomPanel from './ChartBottomPanel';
import SmartSearchButton from './SmartSearchButton';
import useScannerStore, { DetectedCoin } from '../store/scannerStore';

const EASE = [0.4, 0, 0.2, 1];

const Layout: React.FC = () => {
  const [selected, setSelected] = useState<string | undefined>('BTCUSDT');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  
  // View State for Mobile (List vs Chart)
  const [viewState, setViewState] = useState<'LIST' | 'CHART'>('LIST');
  
  // Panel State for Desktop (Normal / Full / Hidden)
  const [panelState, setPanelState] = useState<'NORMAL' | 'FULL' | 'HIDDEN'>('NORMAL');

  const coins = useScannerStore((s) => s.coins || []);
  const addDetectedCoin = useScannerStore((s) => s.addDetectedCoin);
  const setNextScanAt = useScannerStore((s) => s.setNextScanAt);
  const setPremium = useScannerStore((s) => s.setPremium);

  // Auth Check (Telegram)
  useEffect(() => {
    // @ts-ignore
    const tg = window.Telegram?.WebApp;
    if (tg) {
        tg.ready();
        const user = tg.initDataUnsafe?.user;
        if (user) {
            fetch(`/api/user/status?tg_id=${user.id}`).then(r => r.json()).then(d => setPremium(!!d.isPremium)).catch(() => setPremium(false));
        }
    }
  }, [setPremium]);

  const preferred = useMemo(() => {
    const ai = coins.find((c) => c.tag === 'AI');
    return ai?.symbol || coins[0]?.symbol;
  }, [coins]);

  useEffect(() => {
    if (preferred && !selected) setSelected(preferred);
  }, [preferred, selected]);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Sync mobile view state
  useEffect(() => {
    if (!isMobile) setViewState('LIST');
  }, [isMobile]);

  // SSE
  useEffect(() => {
    let es: EventSource | null = null;
    let alive = true;
    const ingest = (payload: any) => {
      try { if (payload && payload.nextScanAt) setNextScanAt(Number(payload.nextScanAt)); } catch (_) {}
      const parsed = payload?.parsed || payload;
      const list = parsed?.detected;
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!item?.symbol || !item?.tag) continue;
        const coin: DetectedCoin = {
          symbol: String(item.symbol).toUpperCase(),
          tag: item.tag === 'AI' ? 'AI' : 'FT',
          detectedAt: Number(item.detectedAt) || Date.now(),
          expiresAt: Number(item.expiresAt) || (Date.now() + 5 * 60_000),
          stdDev: Number(item.stdDev ?? item.score ?? 0) || 0,
          price: Number(item.price ?? 0) || 0,
          quoteVolume: Number(item.quoteVolume ?? 0),
          change24hPct: Number(item.change24hPct ?? item.priceChangePercent ?? 0),
          rsi: Number(item.rsi),
          signal: item.signal,
          spreadPct: item.spreadPct,
          depthUSDT: item.depthUSDT,
          status: item.status
        };
        addDetectedCoin(coin);
      }
    };
    (async () => {
      try {
        const r = await fetch('/api/scheduler/latest');
        if (r.ok) { const j = await r.json(); if (alive) ingest(j); }
      } catch (_) {}
      try {
        es = new EventSource('/events');
        es.addEventListener('open', () => console.log('[Layout] SSE open'));
        es.addEventListener('scheduled_update', (ev: MessageEvent) => { try { const j = JSON.parse(ev.data); ingest(j); } catch (_) {} });
      } catch (_) {}
    })();
    return () => { alive = false; try { es?.close(); } catch (_) {} };
  }, [addDetectedCoin, setNextScanAt]);

  const handleSelect = (s: string) => { 
      setSelected(s); 
      if (isMobile) setViewState('CHART'); 
  };

  const tradeLink = `https://www.mexc.com/exchange/${(selected || 'BTCUSDT').replace('USDT', '_USDT')}`;
  const currentCoin = coins.find(c => String(c.symbol).toUpperCase() === String(selected || '').toUpperCase());

  return (
    <div className="h-screen bg-[#050505] text-white overflow-hidden flex flex-col font-sans selection:bg-violet-500/30">
      <div className="fixed inset-0 pointer-events-none z-0">
         <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-violet-900/10 blur-[120px] rounded-full" />
         <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900/10 blur-[120px] rounded-full" />
      </div>

      <div className="flex-1 flex w-full h-full relative z-10 gap-2 overflow-hidden p-2">
        {isMobile ? (
          // MOBILE LAYOUT
          <div className="w-full h-full relative">
            <AnimatePresence initial={false} mode="popLayout">
              {viewState === 'LIST' && (
                <motion.div 
                    key="list" 
                    initial={{ x: -300, opacity: 0 }} 
                    animate={{ x: 0, opacity: 1 }} 
                    exit={{ x: -300, opacity: 0 }} 
                    transition={{ duration: 0.3, ease: EASE }} 
                    className="absolute inset-0 z-40 bg-[#050505]"
                >
                  <Sidebar onSelect={handleSelect} selected={selected} />
                </motion.div>
              )}

              {viewState === 'CHART' && (
                <motion.div 
                    key="chart" 
                    initial={{ x: 300, opacity: 0 }} 
                    animate={{ x: 0, opacity: 1 }} 
                    exit={{ x: 300, opacity: 0 }} 
                    transition={{ duration: 0.3, ease: EASE }} 
                    className="absolute inset-0 z-50 bg-[#050505] flex flex-col"
                >
                  {/* Mobile Header */}
                  <div className="h-14 flex items-center justify-between px-4 bg-black/40 border-b border-white/10 shrink-0">
                     <div className="flex items-center gap-3">
                        <button onClick={() => setViewState('LIST')} className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white">
                            <ArrowLeft size={20} />
                        </button>
                        <span className="font-bold text-lg">{selected || 'BTCUSDT'}</span>
                     </div>
                     <a href={tradeLink} target="_blank" rel="noopener noreferrer" className="p-2 bg-violet-600 rounded-lg shadow-lg shadow-violet-500/30">
                        <ExternalLink size={18} className="text-white" />
                     </a>
                  </div>

                  {/* Mobile Chart Area */}
                  <div className="flex-1 min-h-0 relative w-full">
                    <ChartContainer symbol={selected ?? 'BTCUSDT'} />
                  </div>

                  {/* Mobile Bottom Panel (Fixed Height) */}
                  <div className="h-[35%] shrink-0 border-t border-white/10 bg-black/20 overflow-y-auto">
                     <div className="p-2">
                        <ChartBottomPanel coin={currentCoin} />
                     </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : (
          // DESKTOP LAYOUT
          <>
            <AnimatePresence mode="popLayout">
              {!isFullscreen && (
                <motion.aside
                  initial={{ width: 0, opacity: 0, x: -20 }}
                  animate={{ width: 360, opacity: 1, x: 0 }}
                  exit={{ width: 0, opacity: 0, x: -20 }}
                  transition={{ duration: 0.4, ease: EASE }}
                  className="h-full relative"
                >
                   <Sidebar onSelect={handleSelect} selected={selected} />
                </motion.aside>
              )}
            </AnimatePresence>

            <motion.div 
              layout
              className="flex-1 flex flex-col h-full min-w-0 bg-white/5 border border-white/10 rounded-2xl backdrop-blur-xl shadow-2xl relative overflow-hidden"
            >
              {/* Desktop Header */}
              <div className="h-14 flex-shrink-0 border-b border-white/5 flex items-center justify-between px-4 bg-black/20 z-30 relative">
                 <div className="flex items-center gap-2">
                    <button onClick={() => setIsFullscreen(!isFullscreen)} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 transition-all group">
                      {isFullscreen ? <LayoutPanelLeft size={16} className="text-violet-400 group-hover:scale-110"/> : <Maximize2 size={16} className="text-gray-400"/>}
                      <span className="text-xs font-bold text-gray-300">{isFullscreen ? 'SHOW LIST' : 'EXPAND'}</span>
                    </button>
                    {/* Show Panel Button if hidden */}
                    {panelState === 'HIDDEN' && (
                        <button onClick={() => setPanelState('NORMAL')} className="p-2 rounded-lg bg-white/5 hover:bg-violet-500/20 text-gray-400 hover:text-violet-400 transition-colors" title="Show Analysis">
                            <Activity size={18} />
                        </button>
                    )}
                    <div className="h-6 w-[1px] bg-white/10 mx-2" />
                    <span className="font-bold text-lg tracking-tight text-white/90">{selected || 'BTCUSDT'}</span>
                 </div>
                 <a href={tradeLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-4 py-1.5 bg-gradient-to-r from-violet-600 to-indigo-600 rounded-lg shadow-lg shadow-violet-500/20 hover:shadow-violet-500/40 hover:scale-105 active:scale-95 transition-all group">
                   <span className="text-xs font-bold tracking-wide">TRADE</span>
                   <ExternalLink size={14} className="group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                 </a>
              </div>

              {/* Chart (Resizable) */}
              <div className={`w-full relative z-10 transition-all duration-300 ${panelState === 'FULL' ? 'h-0 overflow-hidden' : panelState === 'NORMAL' ? 'flex-[1.5] min-h-0' : 'flex-1'}`}>
                 <ChartContainer symbol={selected ?? 'BTCUSDT'} />
              </div>

              {/* Bottom Panel (Resizable) */}
              <AnimatePresence>
                {panelState !== 'HIDDEN' && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }} 
                    animate={{ height: panelState === 'FULL' ? '100%' : '40vh', opacity: 1 }} 
                    exit={{ height: 0, opacity: 0 }} 
                    transition={{ duration: 0.3, ease: EASE }} 
                    className={`${panelState === 'FULL' ? 'flex-1' : 'flex-1 min-h-0'} w-full z-20 flex flex-col bg-black/40 border-t border-white/10 backdrop-blur-md`}
                  >
                        <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-black/20 text-xs shrink-0">
                          <span className="text-gray-500 font-bold uppercase tracking-wider">AI Analysis & Depth</span>
                          <div className="flex gap-1">
                            <button onClick={() => setPanelState(panelState === 'NORMAL' ? 'FULL' : 'NORMAL')} className="p-1 hover:text-white text-gray-400">
                              {panelState === 'NORMAL' ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
                            </button>
                            <button onClick={() => setPanelState('HIDDEN')} className="p-1 hover:text-red-400 text-gray-400">
                              <X size={16}/>
                            </button>
                          </div>
                        </div>
                        <div className="flex-1 p-2 overflow-auto custom-scrollbar">
                          <ChartBottomPanel coin={currentCoin} />
                        </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </>
        )}
      </div>
      
      {!isFullscreen && !isMobile && <SmartSearchButton onSelect={handleSelect} />}
    </div>
  );
};

export default Layout;
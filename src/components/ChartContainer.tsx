import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  createChart,
  IChartApi,
  LineStyle,
  ColorType,
  CandlestickData,
  ISeriesApi,
  IPriceLine
} from 'lightweight-charts';
import { AdvancedRealTimeChart } from 'react-ts-tradingview-widgets';
import confetti from 'canvas-confetti';
import useScannerStore from '../store/scannerStore'; // Импортируем стор

interface Props { symbol?: string; }

const ChartContainer: React.FC<Props> = ({ symbol = 'BTCUSDT' }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const targetLineRef = useRef<IPriceLine | null>(null);
  const stopLossLineRef = useRef<IPriceLine | null>(null);

  const [fullData, setFullData] = useState<CandlestickData[]>([]);
  const [forecastPack, setForecastPack] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBuilding, setIsBuilding] = useState(false);
  const [viewMode, setViewMode] = useState<'AI' | 'TV'>('AI');
  const [hitInfo, setHitInfo] = useState<{ type: 'WIN'|'LOSS'|null; pct: number }>({ type: null, pct: 0 });

  // 1. Reset
  useEffect(() => {
    setIsLoading(true);
    setIsBuilding(false);
    setHitInfo({ type: null, pct: 0 });
    
    if (candleRef.current) candleRef.current.setData([]);
    if (targetLineRef.current) { try { candleRef.current?.removePriceLine(targetLineRef.current); } catch(_){} targetLineRef.current = null; }
    if (stopLossLineRef.current) { try { candleRef.current?.removePriceLine(stopLossLineRef.current); } catch(_){} stopLossLineRef.current = null; }
  }, [symbol]);

  // 2. Fetch Data
  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(`/api/live/candles?symbol=${encodeURIComponent(symbol || 'BTCUSDT')}&limit=120`).then(r => r.json()),
      fetch('/api/scheduler/latest').then(r => r.json())
    ]).then(([candlesData, forecastData]) => {
      if (!active) return;

      const formatted = (Array.isArray(candlesData) ? candlesData : []).map((c: any) => ({
        time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close)
      })).sort((a: any, b: any) => a.time - b.time);

      const parsed = forecastData?.parsed || forecastData;
      const pack = parsed?.forecastsBySymbol?.[String(symbol).toUpperCase()];
      const validPack = (pack && pack.source === 'deepseek') ? pack : null;
      
      setFullData(formatted);
      setForecastPack(validPack);
      
      if (formatted.length > 0) {
          setIsLoading(false);
          setIsBuilding(true); 
      } else {
          setIsLoading(false);
      }
    }).catch(() => setIsLoading(false));

    return () => { active = false; };
  }, [symbol]);

  // 3. Init Chart
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#9ca3af' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.02)' }, horzLines: { color: 'rgba(255,255,255,0.02)' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderVisible: false },
      crosshair: { vertLine: { color: '#8b5cf6', style: LineStyle.Dashed }, horzLine: { color: '#8b5cf6', style: LineStyle.Dashed } }
    });
    chartRef.current = chart;
    candleRef.current = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444' });

    const ro = new ResizeObserver(() => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      }
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, []);

  // 4. Build Animation
  useEffect(() => {
    if (!isBuilding || !fullData.length || !candleRef.current) return;

    let index = 0;
    const total = fullData.length;
    const chunkSize = Math.ceil(total / 30); 

    const animate = () => {
        if (!candleRef.current) return;
        index += chunkSize;
        candleRef.current.setData(fullData.slice(0, Math.min(index, total)));

        if (index < total) {
            requestAnimationFrame(animate);
        } else {
            setIsBuilding(false); 
        }
    };
    requestAnimationFrame(animate);
  }, [isBuilding, fullData]);

  // 5. Lines Renderer
  useEffect(() => {
    if (isLoading || isBuilding || !candleRef.current || !chartRef.current) return;

    if (fullData.length > 0) candleRef.current.setData(fullData);

    if (targetLineRef.current) { try { candleRef.current.removePriceLine(targetLineRef.current); } catch(_){} targetLineRef.current = null; }
    if (stopLossLineRef.current) { try { candleRef.current.removePriceLine(stopLossLineRef.current); } catch(_){} stopLossLineRef.current = null; }

    if (forecastPack) {
        const tp = parseFloat(String(forecastPack.target_price));
        const sl = parseFloat(String(forecastPack.stop_loss_price));

        if (!isNaN(tp) && tp > 0) {
            targetLineRef.current = candleRef.current.createPriceLine({
                price: tp,
                color: forecastPack.direction === 'SHORT' ? '#ef4444' : '#22c55e',
                lineWidth: 3, lineStyle: LineStyle.Solid, title: `TARGET ${tp}`, axisLabelVisible: true
            } as any);
        }
        if (!isNaN(sl) && sl > 0) {
            stopLossLineRef.current = candleRef.current.createPriceLine({
                price: sl,
                color: '#ef4444', lineWidth: 2, lineStyle: LineStyle.Dotted, title: `STOP ${sl}`, axisLabelVisible: true
            } as any);
        }
    }
    
    chartRef.current.timeScale().fitContent();
  }, [isLoading, isBuilding, forecastPack]);

  // 6. Live Stream & Win/Removal Logic
  useEffect(() => {
    if (isLoading || isBuilding) return;
    const es = new EventSource(`/api/live/stream?symbol=${encodeURIComponent(symbol || 'BTCUSDT')}`);
    es.addEventListener('candle_update', (ev) => {
        try {
            const c = JSON.parse(ev.data);
            if (candleRef.current) candleRef.current.update({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) });
            
            // Check HIT
            if (forecastPack && !hitInfo.type) {
                const p = Number(c.close);
                const tp = parseFloat(String(forecastPack.target_price));
                const sl = parseFloat(String(forecastPack.stop_loss_price));
                const entry = fullData[fullData.length-1]?.close || p;
                
                if (!isNaN(tp) && !isNaN(sl)) {
                    if (forecastPack.direction === 'LONG') {
                        if (p >= tp) { setHitInfo({ type: 'WIN', pct: ((p-entry)/entry)*100 }); confetti(); }
                        else if (p <= sl) setHitInfo({ type: 'LOSS', pct: ((entry-p)/entry)*100 });
                    } else {
                        if (p <= tp) { setHitInfo({ type: 'WIN', pct: ((entry-p)/entry)*100 }); confetti(); }
                        else if (p >= sl) setHitInfo({ type: 'LOSS', pct: ((p-entry)/entry)*100 });
                    }
                }
            }
        } catch (_) {}
    });
    return () => es.close();
  }, [symbol, isLoading, isBuilding, forecastPack, hitInfo.type]);

  // 7. Auto-Remove on Hit
  useEffect(() => {
    if (hitInfo.type) {
      const timer = setTimeout(() => {
        // Remove from store
        useScannerStore.getState().removeCoin(String(symbol).toUpperCase());
        // Clear local
        setForecastPack(null);
        setHitInfo({ type: null, pct: 0 });
      }, 3000); // 3 seconds delay
      return () => clearTimeout(timer);
    }
  }, [hitInfo.type, symbol]);

  return (
    <div className="w-full h-full relative bg-transparent group overflow-hidden">
      {/* HEADER */}
      <div className="absolute top-2 right-2 z-50 flex bg-black/60 backdrop-blur-md rounded-lg p-1 border border-white/10">
        <button onClick={() => setViewMode('AI')} className={`px-3 py-1 text-xs font-bold rounded ${viewMode === 'AI' ? 'bg-violet-600 text-white' : 'text-gray-400'}`}>AI</button>
        <button onClick={() => setViewMode('TV')} className={`px-3 py-1 text-xs font-bold rounded ${viewMode === 'TV' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}>TV</button>
      </div>

      {/* AI VIEW */}
      <div style={{ display: viewMode === 'AI' ? 'block' : 'none' }} className="w-full h-full relative">
        <AnimatePresence>
          {isLoading && (
            <motion.div initial={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-50 flex items-center justify-center bg-[#050505]">
               <div className="text-xs font-mono text-violet-400 animate-pulse">INITIALIZING...</div>
            </motion.div>
          )}
        </AnimatePresence>
        <div ref={containerRef} className="w-full h-full" />
        
        {!isLoading && !isBuilding && forecastPack && (
          <div style={{ position: 'absolute', left: 12, top: 12, zIndex: 40, background: 'rgba(0,0,0,0.7)', color: '#fff', padding: '10px', borderRadius: 8 }}>
             <div style={{ fontWeight: 800, color: forecastPack.direction === 'LONG' ? '#4ade80' : '#f87171' }}>SIGNAL: {forecastPack.direction}</div>
             <div style={{ fontSize: 13 }}>Target: {forecastPack.target_price}</div>
             <div style={{ fontSize: 13 }}>Stop: {forecastPack.stop_loss_price}</div>
          </div>
        )}

        <AnimatePresence>
            {hitInfo.type && (
                <motion.div initial={{opacity:0, scale:0.8}} animate={{opacity:1, scale:1}} className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm z-50">
                    <h1 className={`text-6xl font-black ${hitInfo.type === 'WIN' ? 'text-green-400' : 'text-red-500'}`}>{hitInfo.type === 'WIN' ? 'TARGET HIT 🎯' : 'STOPPED OUT 🛑'}</h1>
                    <div className="text-2xl text-white mt-4 font-mono">{hitInfo.pct.toFixed(2)}%</div>
                </motion.div>
            )}
        </AnimatePresence>
      </div>

      <div style={{ display: viewMode === 'TV' ? 'block' : 'none' }} className="w-full h-full relative z-40">
        <AdvancedRealTimeChart theme="dark" autosize symbol={`MEXC:${String(symbol || 'BTCUSDT').toUpperCase()}`} interval="1" toolbar_bg="#000000" container_id="tv_chart" />
      </div>
    </div>
  );
};

export default ChartContainer;
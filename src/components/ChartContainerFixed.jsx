import React, { useEffect, useRef, useState } from 'react';
import {
  createChart,
  IChartApi,
  LineStyle,
  CandlestickData,
  LineData,
  ISeriesApi,
  ColorType,
} from 'lightweight-charts';

interface Props {
  symbol?: string;
}

const ChartContainer: React.FC<Props> = ({ symbol = '—' }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  
  const candlestickSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const forecastSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const [candles, setCandles] = useState<CandlestickData[]>([]);
  const [rawForecast, setRawForecast] = useState<LineData[]>([]);

  // 1. Загрузка Свечей
  useEffect(() => {
    if (!symbol || symbol.includes('—') || symbol.length < 3) {
      setCandles([]);
      return;
    }

    let isMounted = true;
    const fetchCandles = async () => {
      try {
        const response = await fetch(`/api/live/candles?symbol=${encodeURIComponent(symbol)}&limit=50`);
        const data = await response.json();
        
        if (isMounted && Array.isArray(data)) {
          const formatted = data
            .map((c: any) => ({
              time: Math.floor(Number(c.time)),
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
            }))
            .sort((a, b) => (a.time as number) - (b.time as number));
            
          setCandles(formatted);
        }
      } catch (error) {
        console.error('Candle fetch error:', error);
      }
    };
    fetchCandles();
    return () => { isMounted = false; };
  }, [symbol]);

  // 2. Загрузка Сырого Прогноза
  useEffect(() => {
    let isMounted = true;
    const fetchForecast = async () => {
      try {
        const response = await fetch('/api/scheduler/latest');
        const data = await response.json();
        const parsed = data.parsed || data;
        
        if (isMounted && parsed.forecast_1m && Array.isArray(parsed.forecast_1m)) {
          const formatted = parsed.forecast_1m
            .map((f: any) => ({
              time: Math.floor(Number(f.t) / 1000), 
              value: Number(f.close),
            }))
            .sort((a: any, b: any) => a.time - b.time);
            
          setRawForecast(formatted);
        }
      } catch (error) {
        console.error('Forecast fetch error:', error);
      }
    };
    fetchForecast();
    return () => { isMounted = false; };
  }, []);

  // 3. Инициализация Графика
  useEffect(() => {
    if (!containerRef.current) return;

    if (chartRef.current) chartRef.current.remove();

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 400,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#9ca3af' },
      grid: { vertLines: { color: 'rgba(255, 255, 255, 0.05)' }, horzLines: { color: 'rgba(255, 255, 255, 0.05)' } },
      crosshair: {
        horzLine: { color: '#8b5cf6', style: LineStyle.Dashed },
        vertLine: { color: '#8b5cf6', style: LineStyle.Dashed },
      },
      timeScale: { timeVisible: true, secondsVisible: false }
    });
    
    chartRef.current = chart;

    candlestickSeriesRef.current = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    forecastSeriesRef.current = chart.addLineSeries({
      color: '#8b5cf6',
      lineStyle: LineStyle.Dashed,
      lineWidth: 2,
      crosshairMarkerVisible: true,
      title: 'AI Prediction',
    });

    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({ 
            width: containerRef.current.clientWidth, 
            height: containerRef.current.clientHeight 
        });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => { resizeObserver.disconnect(); chart.remove(); chartRef.current = null; };
  }, []);

  // 4. МАТЕМАТИКА: АДАПТАЦИЯ ПОД ВОЛАТИЛЬНОСТЬ
  useEffect(() => {
    if (!chartRef.current || !candlestickSeriesRef.current || !forecastSeriesRef.current) return;

    if (candles.length > 0) {
      candlestickSeriesRef.current.setData(candles);
    }

    if (candles.length > 0 && rawForecast.length > 0) {
        const lastCandle = candles[candles.length - 1];
        const lastRealPrice = Number(lastCandle.close);
        const lastRealTime = Number(lastCandle.time);

        // 1. Считаем амплитуду (размах) реальной цены за последние 30 свечей
        const recentCandles = candles.slice(-30);
        const realPrices = recentCandles.map(c => c.close);
        const realMax = Math.max(...realPrices);
        const realMin = Math.min(...realPrices);
        // Если монета вообще не двигалась, берем 0.1% от цены как минимальный шум
        const realAmplitude = (realMax - realMin) || (lastRealPrice * 0.001);

        // 2. Считаем амплитуду прогноза (как сильно скачет ИИ)
        const forecastPrices = rawForecast.map(f => f.value);
        const foreMax = Math.max(...forecastPrices);
        const foreMin = Math.min(...forecastPrices);
        const foreAmplitude = (foreMax - foreMin) || 1; // Защита от деления на 0

        // 3. Вычисляем "Фактор Успокоения"
        // Мы говорим: "Прогноз должен быть таким же шумным, как реальная монета, не больше"
        const scalingFactor = realAmplitude / foreAmplitude;

        const startForecastVal = Number(rawForecast[0].value);

        if (startForecastVal) {
            const mappedForecast = rawForecast.map((f, i) => {
                // Насколько цена ушла от начала прогноза?
                const deltaFromStart = f.value - startForecastVal;
                
                // Сжимаем это изменение, чтобы оно соответствовало нашей монете
                const scaledDelta = deltaFromStart * scalingFactor;
                
                // Прибавляем аккуратное изменение к реальной цене
                const newPrice = lastRealPrice + scaledDelta;

                return {
                    time: lastRealTime + (i + 1) * 60,
                    value: newPrice
                };
            });

            forecastSeriesRef.current.setData(mappedForecast);
        }
    } else {
        forecastSeriesRef.current.setData([]);
    }
    
    chartRef.current.timeScale().fitContent();

  }, [candles, rawForecast]);

  return (
    <div className="w-full h-full drop-shadow-[0_0_15px_rgba(139,92,246,0.3)]">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
};

export default ChartContainer;
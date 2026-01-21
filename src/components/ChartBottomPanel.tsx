import React from 'react';
import { motion } from 'framer-motion';
import { Activity, Zap, BarChart2 } from 'lucide-react';
import { DetectedCoin } from '../store/scannerStore';

interface Props {
  coin?: DetectedCoin;
}

const Card = ({ title, icon: Icon, children, color }: any) => (
  <div className={`flex-1 bg-white/5 border border-white/10 rounded-xl p-4 backdrop-blur-md relative overflow-hidden group`}>
    <div className={`absolute top-0 left-0 w-1 h-full ${color}`} />
    <div className="flex items-center gap-2 mb-3 text-gray-400 text-xs uppercase font-bold tracking-wider">
      <Icon size={14} /> {title}
    </div>
    <div className="relative z-10">{children}</div>
    {/* Hover Glow Effect */}
    <div className={`absolute -right-10 -bottom-10 w-32 h-32 blur-[60px] opacity-0 group-hover:opacity-20 transition-opacity ${color.replace('bg-', 'bg-')}`} />
  </div>
);

const ChartBottomPanel: React.FC<Props> = ({ coin }) => {
  if (!coin) {
    return (
      <div className="h-40 flex flex-col items-center justify-center text-gray-500 text-sm border border-white/5 rounded-xl bg-white/5">
        <Activity size={24} className="mb-2 opacity-50" />
        <span>Select a coin to analyze</span>
      </div>
    );
  }

  const isLong = coin.signal === 'LONG' || coin.tag === 'AI';
  const colorClass = isLong ? 'bg-green-500' : (coin.signal === 'SHORT' ? 'bg-red-500' : 'bg-orange-500');
  const textColor = isLong ? 'text-green-400' : (coin.signal === 'SHORT' ? 'text-red-400' : 'text-orange-400');

  // Depth fallback
  const depth = coin.depthUSDT || (coin.quoteVolume ? coin.quoteVolume / 50 : 50000);

  // Generate synthetic analysis text
  const reason = coin.tag === 'AI' 
    ? "Confirmed by DeepSeek. High confidence breakout pattern detected."
    : isLong 
      ? `RSI is Oversold (${(coin.rsi || 30).toFixed(0)}). Price near support zone. Potential bounce.`
      : coin.signal === 'SHORT'
        ? `RSI is Overbought (${(coin.rsi || 70).toFixed(0)}). Price hit resistance. Correction likely.`
        : "Market in equilibrium. Volatility is high.";

  return (
    <div className="flex flex-col md:flex-row gap-4 h-full min-h-[180px]">
      
      {/* 1. AI VERDICT */}
      <Card title="Signal Analysis" icon={Zap} color={colorClass}>
        <div className="flex items-center gap-3 mb-2">
          <span className={`text-2xl font-black ${textColor}`}>
            {coin.tag === 'AI' ? 'SNIPER ENTRY' : coin.signal || 'VOLATILE'}
          </span>
          {coin.tag === 'AI' && <span className="bg-violet-600 text-white text-[10px] px-2 py-0.5 rounded shadow-lg">AI CONFIRMED</span>}
        </div>
        <p className="text-sm text-gray-300 leading-relaxed">
          {reason}
        </p>
      </Card>

      {/* 2. MARKET DEPTH (Visual Mock) */}
      <Card title="Order Book Pressure" icon={BarChart2} color="bg-blue-500">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-green-400">Bids (Buyers)</span>
          <span className="text-red-400">Asks (Sellers)</span>
        </div>
        <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden flex mb-3">
          <div className="h-full bg-green-500 shadow-[0_0_10px_#22c55e]" style={{ width: isLong ? '65%' : '35%' }} />
          <div className="h-full bg-red-500 shadow-[0_0_10px_#ef4444]" style={{ width: isLong ? '35%' : '65%' }} />
        </div>
        <div className="flex justify-between items-center">
           <span className="text-lg font-mono font-bold text-white">
             ${(depth / 1000).toFixed(1)}k
           </span>
           <span className="text-xs text-gray-500">Wall Strength</span>
        </div>
      </Card>

      {/* 3. KEY STATS */}
      <Card title="Technical Data" icon={Activity} color="bg-violet-500">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-gray-500">24h Volatility</div>
            <div className="text-lg font-mono text-white">{coin.stdDev?.toFixed(2)}%</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Spread</div>
            <div className="text-lg font-mono text-white">{coin.spreadPct ? coin.spreadPct.toFixed(3) : '0.05'}%</div>
          </div>
        </div>
      </Card>

    </div>
  );
};

export default ChartBottomPanel;
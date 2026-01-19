import React from 'react';
import { useScannerStore } from '../store/scannerStore';

interface Props {
  onSelect?: (symbol: string) => void;
}

const SmartSearchButton: React.FC<Props> = ({ onSelect }) => {
  const coins = useScannerStore((s) => s.coins || []);

  const handleClick = () => {
    if (!coins.length) return;
    const now = Date.now();
    const candidates = coins.filter((c) => c.expiresAt > now);
    const pool = candidates.length ? candidates : coins;
    const best = pool.slice().sort((a, b) => a.stdDev - b.stdDev)[0];
    try { navigator.vibrate?.(10); } catch {}
    if (onSelect) onSelect(best.symbol);
    const el = document.getElementById(best.symbol);
    if (el && 'scrollIntoView' in el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <button
      onClick={handleClick}
      title="Find Best Entry"
      className="fixed right-6 bottom-6 z-50 rounded-full bg-white/6 backdrop-blur-md px-4 py-3 shadow-glow-violet ring-1 ring-primary/40 border border-white/8 text-white hover:scale-105 transition-transform"
    >
      Find Best Entry
    </button>
  );
};

export default SmartSearchButton;

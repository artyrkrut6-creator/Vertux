import React from 'react'
import { Send } from 'lucide-react'

export default function PremiumPaywall({ open=false, onClose=()=>{} }){
  if (!open) return null

  function handleUpgrade(){
    window.open('https://t.me/donate','_blank')
  }

  function handleMockActivate(){
    localStorage.setItem('isPremium','1')
    onClose && onClose()
    window.location.reload()
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/70" onClick={onClose}></div>
        <div className="relative glass-card p-5 w-11/12 max-w-sm rounded-2xl">
        <h2 className="text-xl font-semibold text-primary">Upgrade to Vortex Premium</h2>
          <p className="muted mt-2 text-sm">Unlock extended forecasts, higher timeframes, and priority AI insights.</p>
        <div className="mt-4 flex gap-3">
            <button onClick={handleUpgrade} className="btn-primary flex items-center justify-center gap-2"><Send size={16} /> Pay via @donate</button>
          <button onClick={handleMockActivate} className="flex-1 border border-gray-700 text-gray-200 py-2 rounded">Mock activate</button>
        </div>
          <button onClick={onClose} className="mt-3 text-sm muted">Close</button>
      </div>
    </div>
  )
}

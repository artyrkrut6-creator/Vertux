import React from 'react'
import { Lock } from 'lucide-react'

const TF_OPTIONS = ['1m','5m','15m','1h','4h','1D']

export default function TimeframeSelector({ value='1m', onChange=()=>{}, onRequirePremium=()=>{} }){
  const isPremium = !!localStorage.getItem('isPremium')

  function handleClick(tf){
    const premiumOnly = ['4h','1D']
    if (!isPremium && premiumOnly.includes(tf)){
      onRequirePremium()
      return
    }
    onChange(tf)
  }

  return (
    <div className="flex gap-2 overflow-auto pb-3">
      {TF_OPTIONS.map(tf => {
        const locked = !isPremium && ['4h','1D'].includes(tf)
        const active = value === tf
        return (
          <button
            key={tf}
            onClick={() => handleClick(tf)}
            className={`flex items-center gap-2 px-3 py-2 rounded-full text-sm whitespace-nowrap transition ${active ? 'bg-primary text-black' : 'bg-gray-800 text-white'}`}
          >
            <span>{tf}</span>
            {locked && <Lock size={14} className="text-gray-300/70" />}
          </button>
        )
      })}
    </div>
  )
}

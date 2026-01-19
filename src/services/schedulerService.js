export async function getLatestScheduled(){
  try{
    const API_BASE = (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) ? 'http://localhost:5176' : ''
    const res = await fetch(`${API_BASE}/api/scheduler/latest`)
    if (!res.ok) throw new Error('no scheduled')
    return await res.json()
  }catch(e){ console.warn('getLatestScheduled error', e); return null }
}

export default { getLatestScheduled }

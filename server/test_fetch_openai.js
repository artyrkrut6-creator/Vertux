(async ()=>{
  try{
    const OPENAI_KEY = process.env.OPENAI_API_KEY || 'sk-1234567890abcdef1234567890abcdef12345678'
    const url = 'https://api.openai.com/v1/chat/completions'
    const body = { model: 'gpt-4o-mini', messages:[{role:'user', content:'Hello'}], max_tokens:5 }
    const resp = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` }, body: JSON.stringify(body) })
    console.log('status', resp.status)
    const txt = await resp.text()
    console.log('body', txt)
  }catch(e){ console.error('fetch error:', e && e.stack || e) }
})();
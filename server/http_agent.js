const { HttpsProxyAgent } = require('https-proxy-agent')
const proxyUrl = process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.PROXY || 'http://127.0.0.1:10801'
let agent = null
if (proxyUrl){
  try{
    agent = new HttpsProxyAgent(proxyUrl)
    console.log('[http_agent] Using proxy:', proxyUrl)
  }catch(e){
    console.error('[http_agent] Failed to create proxy agent:', String(e))
    agent = null
  }
} else {
  // no proxy configured
}

module.exports = { agent }


const { HttpsProxyAgent } = require('https-proxy-agent')

// Only create a proxy agent if an explicit proxy env var is provided.
// Do NOT default to a local proxy URL — that caused unexpected network failures when no proxy runs locally.
const proxyUrl = process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.PROXY || null
let agent = null

const PROXY_INSECURE = (String(process.env.PROXY_INSECURE || '').toLowerCase() === 'true')
if (PROXY_INSECURE) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  console.warn('[http_agent] PROXY_INSECURE enabled: NODE_TLS_REJECT_UNAUTHORIZED=0')
}

if (proxyUrl) {
  try {
    agent = new HttpsProxyAgent(proxyUrl)
    if (PROXY_INSECURE) {
      try { agent.options = agent.options || {}; agent.options.rejectUnauthorized = false } catch (e) {}
    }
    console.log('[http_agent] Using proxy:', proxyUrl, 'insecure=', PROXY_INSECURE)
  } catch (e) {
    console.error('[http_agent] Failed to create proxy agent:', String(e))
    agent = null
  }
} else {
  console.log('[http_agent] No proxy configured (no PROXY_URL/HTTP_PROXY/HTTPS_PROXY)')
}

module.exports = { agent, PROXY_INSECURE }

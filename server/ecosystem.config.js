module.exports = {
  apps: [
    {
      name: 'remote-llm-proxy',
      script: 'server/remote_proxy.js',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 9000
      }
    }
  ]
}

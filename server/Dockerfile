FROM node:20-alpine
WORKDIR /app
COPY package*.json ./ 2>/dev/null || true
COPY . .
RUN npm install --production || true
ENV PORT=9000
EXPOSE 9000
CMD ["node", "server/remote_proxy.js"]

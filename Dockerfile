FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && (npm ci --omit=dev || npm install --omit=dev)
COPY server/ ./server/
ENV PORT=3000
EXPOSE 3000
CMD ["node","server/server.js"]

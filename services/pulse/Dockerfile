FROM node:22-slim

# libatomic1: the rocksdb-native prebuild links libatomic.so.1, which node:22-slim omits.
# iproute2: gives `ss` for the health check.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libatomic1 iproute2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pulse.js ./
RUN npm install --omit=dev

# the key and the times it keeps live on the persistent volume mounted at /data
RUN useradd -m app && mkdir -p /data && chown app:app /data
USER app

ENV STORAGE=/data
# fixed UDP port, published unfirewalled so devices needn't holepunch
ENV PORT=49739

# healthy once the DHT has bound its UDP port (a crash exits the container)
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ss -uln | grep -q ":$PORT " || exit 1

# logs its public key on startup: that key goes in apps' pulse(key)
CMD ["node", "pulse.js"]

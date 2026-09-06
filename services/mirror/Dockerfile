FROM node:22-slim

# libatomic1: the rocksdb-native prebuild links libatomic.so.1, which
# node:22-slim omits (Node doesn't need it) — without it the addon won't load.
# iproute2: gives `ss` for the health check.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libatomic1 iproute2 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g blind-peer-cli@^1.9

# storage dir lives on a persistent volume mounted at /data
RUN useradd -m app && mkdir -p /data && chown app:app /data
USER app

ENV STORAGE=/data/blind-peer
# max storage in MB (default 100000 = 100GB); size to your box's disk
ENV MAX_STORAGE=20000
# pinned so the health check can verify the DHT bound it
ENV PORT=49737

# healthy once the DHT has bound its UDP port (a crash exits the container;
# this also catches a start-up hang before it ever listens)
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ss -uln | grep -q ":$PORT " || exit 1

# blind-peer logs its public key on startup — that key goes in cero({ mirrors })
CMD ["sh", "-c", "blind-peer --storage \"$STORAGE\" --max-storage \"$MAX_STORAGE\" --port \"$PORT\""]

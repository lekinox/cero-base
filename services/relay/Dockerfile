FROM node:22-slim

# libatomic1: native prebuilds may link libatomic.so.1, which node:22-slim omits.
# iproute2: gives `ss` for the health check.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libatomic1 iproute2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json relay.js ./
RUN npm install --omit=dev

# only the keypair seed lives on the persistent volume mounted at /data
RUN useradd -m app && mkdir -p /data && chown app:app /data
USER app

ENV KEY_FILE=/data/key
# fixed UDP port, published unfirewalled so peers needn't holepunch
ENV PORT=49738
# abuse caps: open sessions per remote public key, per remote IP and in total;
# a session that hasn't paired within PAIR_TIMEOUT ms is dropped
ENV MAX_PER_KEY=8
ENV MAX_PER_IP=256
ENV MAX_SESSIONS=2000
ENV PAIR_TIMEOUT=10000

# healthy once the DHT has bound its UDP port (a crash exits the container)
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ss -uln | grep -q ":$PORT " || exit 1

# logs its public key on startup — that key goes in apps' RELAYS / relayThrough
CMD ["node", "relay.js"]

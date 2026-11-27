FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends libatomic1 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g blind-push-gateway-cli@^1.0

RUN useradd -m app
USER app
WORKDIR /home/app

# config.json and the Firebase service account are mounted into ~/.blind-push-gateway
# the gateway logs its public key on startup — that key goes in the mirror's PUSH_GATEWAY_KEY
CMD ["blind-push-gateway", "run"]

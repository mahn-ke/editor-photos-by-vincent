# Debian (glibc) because onnxruntime-node has no musl build; LibRaw and exiftool for DNGs
FROM node:26-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libraw-bin libimage-exiftool-perl curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Tests run as part of every image build, so CI fails before a broken image ships
FROM base AS test
COPY . .
RUN npm test && touch /tmp/tests-passed

FROM base AS runtime
COPY --from=test /tmp/tests-passed /tmp/tests-passed
COPY . .
# Models are downloaded on first use into the data volume (pinned by sha256)
ENV NODE_ENV=production DATA_DIR=/app/data CACHE_DIR=/app/cache MODEL_DIR=/app/cache/models
EXPOSE 3000
CMD ["node", "main.js"]

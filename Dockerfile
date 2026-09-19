FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 poppler-utils unzip ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs rag_service.py study_prompt.md ./
COPY public ./public
COPY entrypoint.sh ./entrypoint.sh
COPY data ./data
RUN chmod +x ./entrypoint.sh && mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8080
ENV RAG_URL=http://127.0.0.1:8090
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]

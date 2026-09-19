# StudyMate deployment

## Docker (recommended for the complete application)

Create a `.env` file with the server-side LLM credentials:

```env
BUILT_IN_FORGE_API_URL=your_llm_gateway_url
BUILT_IN_FORGE_API_KEY=your_server_side_key
STUDY_CHAT_MODEL=gemini-3.5-flash-lite
```

Build and run:

```bash
docker compose up --build -d
```

Open `http://localhost:8080`. The Node gateway and Python RAG service run inside one container, while `/app/data` persists users, sessions, uploads, and RAG chunks in the named Docker volume.

## Vercel-ready frontend package

The `vercel/` directory contains a static frontend package and a proxy API function. Set `STUDYMATE_GATEWAY_URL` in Vercel to the public URL of a deployed StudyMate Docker gateway. The proxy forwards `/api/*` requests to that gateway; this keeps Python RAG and JSON persistence outside Vercel’s ephemeral functions.

Vercel alone is not suitable for this current full stack because Python RAG and file-backed auth/history need a persistent service or managed database. For a fully serverless Vercel deployment, replace JSON storage with PostgreSQL/Redis, move retrieval into a hosted service, and configure object storage for uploads.

## Security before public launch

Use HTTPS, a strong secret-managed LLM key, a managed database, rate limiting, email verification, password reset, CSRF protections appropriate to the deployment, and object storage for user documents. Never commit `.env` or user data.

# Environment Variables

Provider keys:

```env
OPENAI_API_KEY=
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
FIREWORKS_API_KEY=
```

Model selection:

- Chat, embedding, and image generation model choices live in `ayati-main/data/runtime/llm-config.json`.
- Embeddings currently support the OpenAI provider and use `OPENAI_API_KEY`.
- Image generation currently supports the OpenAI provider and uses `OPENAI_API_KEY`.

HTTP API:

```env
AYATI_HTTP_HOST=127.0.0.1
AYATI_HTTP_PORT=8081
AYATI_HTTP_ALLOW_ORIGIN=*
AYATI_HTTP_API_TOKEN=
AYATI_UPLOAD_MAX_BYTES=26214400
```

Document vectors:

```env
AYATI_DOCUMENT_VECTOR_ENABLED=true
AYATI_DOCUMENT_EMBED_BATCH_SIZE=32
AYATI_DOCUMENT_VECTOR_MIN_CHUNKS=40
```

Python tool:

```env
AYATI_PYTHON_INTERPRETER=
```

Telegram:

```env
AYATI_TELEGRAM_ENABLED=true
AYATI_TELEGRAM_BOT_TOKEN=
AYATI_TELEGRAM_ALLOWED_CHAT_ID=
```

AgentMail and Nylas Mail have plugin-specific variables documented in the root README.

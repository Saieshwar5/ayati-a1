# Common Errors

Daemon cannot start:

- Check provider `.env` values.
- Check whether ports `8080` or `8081` are already in use.
- Run `pnpm --filter ayati-main build` to catch TypeScript errors.

CLI not connected:

- Ensure the daemon is running.
- Confirm WebSocket URL is `ws://localhost:8080`.
- Check `ayati-cli/src/app/hooks/use-websocket.ts` if the connection target changes.

Daemon running but no visible reply:

- Check whether the input arrived through the expected transport.
- Check WebSocket client connection state.
- Check provider configuration and startup logs.
- Check whether a system-event policy path requires approval or notification rather than direct action.

Uploads fail:

- Ensure request is `multipart/form-data`.
- Ensure field name is `file`.
- Check `AYATI_UPLOAD_MAX_BYTES`.
- Check HTTP server host/port env vars.

Document vectors unavailable:

- Check OpenAI credentials.
- Check `AYATI_DOCUMENT_VECTOR_ENABLED`.
- Review startup logs for document embedder warnings.

Episodic memory unavailable:

- Check OpenAI credentials.
- Review startup logs for memory embedder warnings.

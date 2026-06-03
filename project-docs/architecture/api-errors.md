# API Errors

WebSocket:

- Invalid JSON is rejected with `{ "type": "error", "content": "Invalid JSON" }`.
- Unknown clients are logged by the backend when sending replies.

HTTP upload/artifact API:

- Non-managed paths return 404.
- Uploads require `multipart/form-data`.
- Upload field name must be `file`.
- Upload size is limited by `AYATI_UPLOAD_MAX_BYTES`, defaulting to 25 MB.
- Artifact paths are constrained to the runs directory.

When changing transport behavior, update both backend tests and any client parsing assumptions.

## 0.1.1

- Fix: with `configFile` set, keys the Gateway fills in from configSchema defaults are no longer rejected as inline settings (service failed to start).

# Changelog

## 0.1.0

First release.

- Loopback HTTP listener run as an OpenClaw plugin background service.
- Multipart image uploads with streaming to disk, SHA-256 and client-key deduplication, sessions, and batching by
  quiet period or an explicit `done` call.
- Each batch is handed to a configured agent through the Gateway's `POST /hooks/agent` (idempotency key = batch
  id, no session key), with exponential-backoff retries and an optional incident URL.
- Outgoing folder served back to clients (list, download, acknowledge).
- Authentication by a trusted reverse-proxy identity header (default `Tailscale-User-Login`) or a Bearer token from
  a 0600 file; 20 failures per minute per client give 429.
- Configuration inline or through `configFile`; `service_name`, `identity_header` and optional hook fields.

# RCC web console (experimental)

This folder holds the browser console for RCC and its public demo build. It is for contributors who work on the console and for readers who want to try the demo.

Status: experimental. Telegram is the supported interface. The console is not part of the setup in [INSTALL.md](../../INSTALL.md).

## Boundaries

- Telegram is the only supported operator interface.
- Web control needs explicit local configuration (`RCC_WEB_CONTROL_ENABLED`) and a private token (`RCC_WEB_AUTH_TOKEN`). It is off by default.
- The hosted relay needs its own deployment, bearer tokens, durable storage, and a security review.
- The web console and the relay must never get Codex or OpenAI credentials.

## Public demo

The demo build shows the console with simulated data. It runs in the browser only.

- There is no token field, base URL field, or relay setup. The connection area shows "Demo Mac (simulated)".
- `demo-relay.js` answers the requests that the console makes: the snapshot, commands, and command results. It returns fixture projects, threads, approvals, and replies. It makes no network calls.
- Approve, deny, steer, and interrupt work on the fixtures. File upload and artifact download are not available.
- Demo state resets when the page reloads, or when you press Reset demo.
- The build adds `demo-config.js`, which sets `window.RCC_DEMO = true`. The normal console does not load that file, and its behaviour does not change.

Build and serve the demo locally:

```bash
npm run web:demo:build
npm run web:demo:serve   # http://127.0.0.1:4790/
```

The build writes `dist-demo/`, which git ignores. Its `_headers` file sets `connect-src 'none'`. The local server sends the same headers, so the browser enforces the same policy. The Cloudflare deploy steps are in [deploy/web-demo/README.md](../../deploy/web-demo/README.md).

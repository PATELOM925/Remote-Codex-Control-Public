# RCC Web Console (Experimental)

The public alpha setup path is Telegram-first. This web console code remains in the repository for ongoing development, but it is not documented as the public onboarding path.

Do not use the web console in public docs or launch claims until it passes fresh security review and end-to-end browser testing for the current branch.

Current boundary:

- Telegram is the supported public operator surface.
- Web control requires explicit local configuration and a private token.
- Hosted relay requires separate deployment, bearer tokens, durable storage verification, and security review.
- Web/relay must not receive Codex/OpenAI credentials.

## Public demo

The demo build shows the real console with made-up data. It runs in the browser only.

- There is no token field, base URL field or relay setup. The connection area shows "Demo Mac (simulated)".
- `demo-relay.js` answers the requests the console makes (snapshot, commands and command results) with fixture projects, threads, approvals and replies. It makes no network calls.
- Approving, denying, steering and interrupting work on the fixtures. File upload and artifact download are disabled.
- State resets when the page reloads, or when you press Reset demo.
- The build adds `demo-config.js`, which sets `window.RCC_DEMO = true`. The normal console does not load that file, and its behaviour does not change.

Build and serve it locally:

```bash
npm run web:demo:build
npm run web:demo:serve   # http://127.0.0.1:4790/
```

The build writes `dist-demo/`, which is git-ignored. Its `_headers` file sets `connect-src none`. The local server sends the same headers, so the browser enforces the same policy. The Cloudflare deploy notes are in `deploy/web-demo/README.md`.

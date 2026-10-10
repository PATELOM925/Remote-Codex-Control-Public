# Web demo deploy (Cloudflare)

This folder deploys the static public demo of the web console. It is for the maintainer who publishes the demo. For the demo itself, see [apps/web/README.md](../../apps/web/README.md).

The deploy is a manual step. No CI job runs it.

1. Build the site: `npm run web:demo:build`
2. Deploy it: `npx wrangler deploy --config deploy/web-demo/wrangler.jsonc`

The demo is a Worker with static assets only, and it has no backend. Its pages and scripts are plain files. The browser runs a simulated Mac in memory. The `_headers` file sets `connect-src 'none'`, so the page cannot make a network request even if a bug tries one.

Do not add a relay URL, an operator token, or a real Mac connection to this deployment.

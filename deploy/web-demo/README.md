# Public web demo (Cloudflare)

This folder deploys the static demo of the web console. It is a Worker with static assets only.

1. Build the site: `npm run web:demo:build`
2. Deploy it: `npx wrangler deploy --config deploy/web-demo/wrangler.jsonc`

This demo has no backend. Its pages and scripts are plain files, and the browser runs a simulated Mac in memory. The `_headers` file sets `connect-src 'none'`, so the page cannot make a network request even if a bug tries one. Do not add a relay URL, an operator token or a real Mac connection to this deployment.

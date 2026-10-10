# Maintainer notes

This page says which parts of the repository are experimental, and what must be true before the docs can describe them as supported. It is for maintainers who decide what the public docs may claim.

## Public onboarding

The public docs send new users through Telegram only. Keep the web console and the relay out of the onboarding path, and out of claims about the product, until they pass the checks below.

## Experimental code

The repository includes these experimental parts:

- `apps/web/`: the browser control console. It has a public demo mode that uses simulated data.
- `api/relay.js`: the hosted relay function.
- `supabase/rcc_relay_schema.sql`: the durable storage schema for the relay.
- `scripts/setup_relay_quickstart.sh`: a helper for relay setup.

The code stays so that development can continue. The public docs must not describe the hosted relay or public web control as production features.

## Promotion criteria for the web console and the relay

Before the docs call either one a public alpha feature:

- The hosted deployment runs the current commit.
- Requests without a valid token fail closed.
- The operator and Mac tokens are rotated, and the rotation is tested.
- Durable storage mode is tested.
- Mac snapshot freshness and the command lifecycle are tested.
- Run, steer, output, and approval flows pass a browser end-to-end test on a selected thread.
- The docs explain token handling without showing real values.
- A security review covers CORS, CSRF and origin policy, storage, logs, and screenshots.

## Current public message

Use this sentence in launch text:

```text
RCC supervises local Codex from Telegram while execution, credentials, files, approvals, and state stay on the Mac.
```

# Maintainer Notes

The public docs route new users through Telegram only. Keep web/relay docs out of the public onboarding path until they pass fresh end-to-end verification.

## Experimental Code Present

The repository currently includes:

- `apps/web/` - browser control prototype.
- `api/relay.js` - hosted relay function prototype.
- `supabase/rcc_relay_schema.sql` - durable relay schema prototype.
- `scripts/setup_relay_quickstart.sh` - relay setup helper.

These files are kept so development can continue, but the public branch should not claim production hosted relay, public web control, or bus-use reliability.

## Promotion Criteria For Web/Relay

Before documenting web/relay as public alpha:

- hosted deployment is live and tied to the current commit;
- unauthenticated relay requests fail closed;
- operator and Mac bearer tokens are rotated and verified;
- durable storage mode is verified;
- Mac snapshot freshness and command lifecycle are verified;
- selected-thread run/steer/output/approval flows pass browser E2E;
- public docs explain token handling without exposing private values;
- security review covers CORS, CSRF/origin policy, storage, logs, and screenshots.

## Current Public Promise

Telegram-first only:

```text
RCC supervises local Codex from Telegram while execution, credentials, files, approvals, and state stay on the Mac.
```

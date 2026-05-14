# Threat Model

## Scope

Public alpha scope is one trusted operator controlling local Codex from a private Telegram bot on one Mac.

## Trust Boundaries

- Telegram transport is untrusted.
- Bot token is a bearer credential.
- Allowlisted chat IDs are the operator boundary.
- Uploaded files are untrusted content.
- Codex/model output is untrusted until reviewed.
- SQLite and `.dist/` are local private state.
- The local status page must remain localhost-only.

## Threats And Controls

| Threat | Control |
| --- | --- |
| Unauthorized chat | `RCC_ALLOWED_CHAT_IDS` allowlist |
| Bot token leak | ignored `setup.md`, rotation through BotFather |
| Stale approval replay | expired/superseded approval rejection |
| Ambiguous thread target | explicit selection or safe failure |
| Attachment traversal | sanitized filenames and path confinement |
| Artifact leakage | list-first, explicit-send, path recheck |
| Prompt injection | uploaded files treated as untrusted context |
| Hidden reasoning claim | only App Server-exposed `Reasoning Summary` displayed |
| Local API exposure | localhost-only binding |

## Residual Risks

- Artifact redaction is incomplete.
- Desktop UI approval automation is prototype-only.
- Codex App Server protocol can change.
- Manual screenshot/log review is required before public release.
- Web/relay code is experimental and out of public-alpha scope.

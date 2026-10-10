# Threat model

This document lists the trust boundaries, the threats, the controls that address them, and the risks that remain. It is for reviewers and contributors who change the Telegram, approval, file, or artifact paths. The short policy is in [SECURITY.md](../SECURITY.md).

## Scope

The public alpha covers one trusted operator who controls local Codex from a private Telegram bot on one Mac.

## Trust boundaries

- The Telegram transport is untrusted.
- The bot token is a bearer credential.
- The allowlisted chat IDs mark the operator boundary.
- Uploaded files are untrusted content.
- Codex and model output are untrusted until the operator reviews them.
- SQLite and `.dist/` are private local state.
- The local status server must stay on localhost.

## Threats and controls

| Threat | Control |
| --- | --- |
| Unauthorized chat | `RCC_ALLOWED_CHAT_IDS` allowlist. Other chats get a reply and no action. |
| Bot token leak | Token kept in ignored `setup.md`. Revoke it in BotFather. |
| Stale or superseded approval | Expired and superseded approvals are rejected. Old buttons do nothing. |
| Repeated approval tap | Approval callbacks are idempotent. |
| Ambiguous thread target | An ambiguous reference fails with a message. |
| Upload path traversal | File names are sanitized. The saved path must stay in the thread's upload folder. |
| Artifact exfiltration | Artifacts are listed first and sent only when selected. The send step checks the path again. |
| Prompt injection from an upload | Uploaded files are treated as untrusted context. |
| Secret text in approvals or reasoning | Common secret shapes are masked before display or storage. |
| Claim of hidden reasoning | The bot shows only the Reasoning Summary that the App Server exposes. |
| Local status page exposed to the network | The status server refuses any host other than localhost. |
| Relay token guessing or a weak token | The relay rejects tokens shorter than 32 characters with 503. It compares tokens in constant time. |
| Oversized relay request | The relay rejects bodies over 1 MiB and command messages over 64 KiB, except file uploads. |
| Untrusted browser origin on the relay | The relay accepts only origins in `RCC_RELAY_ALLOWED_ORIGINS` when that list is set. |
| Relay traffic sent in plain text | The relay URL must be `https://`, or a loopback `http://` URL for tests. Any other URL keeps the relay off. |

## Residual risks

- Artifact redaction is incomplete.
- Desktop UI approval automation is a prototype.
- The Codex App Server protocol can change.
- Screenshots and logs can contain private data. Review them before you share them.
- The web console and the relay are experimental. They are outside the public alpha scope.
- Without `RCC_RELAY_ALLOWED_ORIGINS`, the relay accepts requests from any origin outside Vercel. Its token checks still apply.

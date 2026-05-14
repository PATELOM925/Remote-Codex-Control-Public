# Agent Instructions

This repository builds a Telegram-first remote supervision layer for Codex running on a Mac.

## Mission

Make one trusted operator effective away from the laptop. Optimize for approval clarity, steering continuity, safe file attachment, explicit artifact retrieval, and strict safety defaults.

## Product Rules

1. The Mac is the execution surface.
2. Telegram is the documented remote UI in the public alpha.
3. Every approval surfaced remotely must include project and thread context.
4. Every Telegram-uploaded file must be attached to a specific thread.
5. Push to `main` is blocked by default.
6. Model/reasoning changes apply to a new thread or subsequent turn, not by mutating active work unsafely.
7. Public docs must not expose values copied from `setup.md`.

## Coding Rules

- Use typed interfaces for bridge events.
- Prefer explicit state machines over boolean flags.
- Persist operator-visible state in SQLite.
- Make callbacks idempotent.
- Treat Telegram callbacks and Codex events as independent asynchronous streams.
- Log transitions with structured logs.

## Architecture Guardrails

- Keep App Server integration, Telegram transport, registry/state, artifacts, file intake, and Git guardrails separated.
- Do not let file uploads bypass thread scoping.
- Do not let Git actions bypass review flow.
- Do not let ambiguous commands default to destructive behavior.
- Do not claim hosted relay, web control, or native mobile support as public alpha behavior without fresh verification.

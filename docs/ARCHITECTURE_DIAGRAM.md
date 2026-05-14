# RCC Architecture Diagram

Public alpha path: Telegram controls a local daemon; Codex, files, credentials, and state stay on the Mac.

```mermaid
flowchart LR
  operator["Trusted operator\nTelegram app"] --> tg["Telegram Bot API\nlong polling"]
  tg --> daemon["RCC daemon\nlocal Node.js process"]
  daemon --> codex["Codex App Server\nlocal stdio protocol"]
  codex --> app["Codex on Mac"]
  daemon --> db[("SQLite WAL\n.dist/rcc.sqlite")]
  daemon --> uploads["Thread-scoped uploads\n.dist/uploads/<thread>"]
  daemon --> artifacts["Thread-scoped artifacts\n.dist/artifacts/<thread>"]
  daemon --> policies["Deterministic policies\nallowlist, approvals, paths, artifacts, git"]
```

## Trust Boundaries

```mermaid
flowchart TB
  subgraph Remote["Remote channel"]
    operator["Operator chat"]
    tg["Telegram transport"]
  end

  subgraph Mac["Trusted Mac boundary"]
    daemon["RCC daemon"]
    codex["Codex App Server"]
    db[("Local SQLite")]
    fs["Local files and artifacts"]
  end

  operator --> tg
  tg -->|"bot token + allowlisted chat only"| daemon
  daemon -->|"typed requests"| codex
  daemon --> db
  daemon --> fs
```

Boundary rules:

- Telegram is a remote control channel, not a trust boundary by itself.
- `RCC_ALLOWED_CHAT_IDS` gates all Telegram commands.
- Attachments are untrusted and must be materialized into thread-scoped paths.
- Artifacts are list-first and explicit-send.
- Desktop UI automation is prototype-only and disabled by default.
- Web/relay code is not part of the public Telegram alpha path.

## Event Flow

```mermaid
sequenceDiagram
  participant O as Operator
  participant T as Telegram Bot API
  participant R as RCC daemon
  participant C as Codex App Server
  participant S as SQLite

  O->>T: /run task
  T->>R: update via getUpdates
  R->>S: record operator message
  R->>C: turn/start or turn/steer
  C-->>R: output / approval / completion events
  R->>S: persist operator-visible state
  R-->>T: focused-thread update
  T-->>O: output or approval card
```

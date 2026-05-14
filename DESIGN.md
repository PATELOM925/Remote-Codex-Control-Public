# DESIGN

## Product thesis

A live coding agent is most useful when the operator can supervise and redirect it without sitting at the keyboard. The right v1 is not full autonomy. The right v1 is high-leverage remote supervision.

## Primary user

A solo builder using Codex on a personal Mac who wants to monitor, steer, and approve work from a phone while away from the laptop.

## Jobs to be done

1. When Codex needs approval, show me the exact project and thread so I can answer fast.
2. When I change my mind mid-run, let me message the new plan without restarting everything.
3. When I need to give more context, let me upload a file from Telegram into the active thread.
4. When Codex finishes, send me the output files directly in Telegram.
5. When Git actions are involved, force me through explicit review and confirmation steps.

## Product constraints

- The Mac remains the execution environment.
- The bot is private and single-operator in v1.
- Project access is allowlisted.
- File uploads from Telegram are scoped to a specific thread workspace.
- Push to `main` is blocked by default.

## Experience principles

### 1. Approval speed
A request should be understandable in one screen without opening the laptop.

### 2. Context continuity
Every action must preserve project, thread, and turn continuity.

### 3. No ambiguous file handling
A Telegram attachment is never "global context." It is always bound to a chosen thread.

### 4. Human remains in control
The operator can interrupt, steer, deny, or revise at any time.

### 5. Safe by default
The system should choose smaller scope, explicit review, and reversible actions.

## Core interaction patterns

### Pattern A — approval card
Operator receives:
- project
- thread
- summary
- action category
- buttons: approve, deny, interrupt, steer

### Pattern B — steering message
Operator replies with a free-form instruction that either:
- steers the active turn, or
- becomes the next task instruction if no turn is active

### Pattern C — attach file
Operator uploads a file and targets a specific thread. The bot confirms the target thread before ingesting.

### Pattern D — artifact return
On completion, the bot sends:
- completion summary
- changed files summary
- artifacts as Telegram documents when size permits

## Success metrics for v1

- Median approval response under 30 seconds from notification to submitted response.
- At least 90% of approvals include correct project and thread mapping.
- At least 95% of Telegram uploads land in the intended thread workspace.
- Zero direct pushes to `main`.
- Operator can finish a full remote loop without opening the laptop.

## Hard edges to resolve early

- What happens when the operator sends a steering message while no active turn exists?
- What happens when multiple approvals are pending on one thread?
- How should artifacts be selected when there are many generated files?
- What is the fallback when Telegram file size limits are exceeded?

## v1 recommendation

Start with one Mac, one Telegram user, one allowlisted project catalog, and one bridge daemon. Make reliability and clarity the product.

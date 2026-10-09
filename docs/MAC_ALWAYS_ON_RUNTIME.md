# RCC Always-On Mac Runtime

Status: LaunchAgent/caffeinate implementation is present. Installing it on a Mac is an operator action because it changes local startup behavior.

## Short Answer

RCC can keep `./run.sh` alive across normal idle sleep by using a `launchd` user agent plus macOS sleep assertions through `caffeinate`.

RCC cannot safely promise that a MacBook keeps running after the lid is closed in every setup. Apple-supported closed-lid operation requires closed-display/clamshell conditions: power, an external display, and external keyboard/mouse or trackpad. Without that, lid close is a system sleep path that user-space apps should not claim to override reliably.

## What Apple/macOS Allows

### Supported and Safe

1. Keep RCC running while the Mac is awake, unlocked/logged in, and the lid is open.
2. Prevent idle system sleep while RCC is running.
3. Let the display sleep while RCC continues in the background.
4. Auto-restart RCC after crashes or login using a per-user `launchd` LaunchAgent.
5. Keep RCC running with the lid closed only when the Mac is in Apple-supported closed-display mode.

### Not Safe to Claim

1. “RCC works after closing any MacBook lid.”
2. “RCC bypasses macOS lid sleep.”
3. “RCC keeps Codex running while the Mac is asleep.”
4. “Remote access works while the Mac is sleeping.”

If the Mac is asleep, RCC cannot receive Telegram updates, stream Codex output, or act on remote commands.

## Evidence

- `man caffeinate` says `caffeinate` creates power-management assertions. `-i` prevents idle system sleep, and `-s` prevents system sleep only while on AC power.
- Apple Developer documentation for `kIOPMAssertionTypePreventUserIdleSystemSleep` says the system may still sleep for lid close, Apple menu sleep, low battery, or other sleep reasons.
- Apple Support says that when an external display is connected to a Mac laptop with a closed lid, the Mac must be connected to power and use an external keyboard and mouse.
- Apple Support for Apple silicon accessories says closed-lid use requires allowing the external display, keyboard, and mouse first.
- Apple Terminal documentation says `launchd` manages daemons/agents and can run shell scripts.
- Apple Developer launchd documentation describes `RunAtLoad` and `KeepAlive` as the supported way to launch and relaunch background jobs.

Sources:

- Apple Developer, power assertion caveat: https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep
- Apple Support, external display with closed lid: https://support.apple.com/en-us/HT201177
- Apple Support, closed-lid accessories on Apple silicon: https://support.apple.com/en-us/102282
- Apple Support, sleep/wake setting: https://support.apple.com/en-gb/guide/mac-help/set-sleep-and-wake-settings-mchle41a6ccd/mac
- Apple Support, launchd shell scripts: https://support.apple.com/en-ca/guide/terminal/apdc6c1077b-5d5d-4d35-9c19-60f2397b2369/mac
- Apple Developer, creating launchd jobs: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html

## Implemented Alpha Path

### Keep-Awake LaunchAgent

RCC includes an optional installer that creates a user LaunchAgent:

- starts RCC at user login
- restarts RCC if it crashes
- wraps RCC in `caffeinate -i -m -s` while on AC power
- writes logs to `.dist/logs/launchd.out.log` and `.dist/logs/launchd.err.log`
- never changes global `pmset` settings automatically
- never promises lid-closed operation unless clamshell requirements are met

Files:

```text
scripts/install-launchd.sh
scripts/uninstall-launchd.sh
scripts/rcc-launchd-runner.sh
launchd/com.remote-codex-control.daemon.plist.template
```

Install:

```bash
./scripts/install-launchd.sh
```

Dry-run:

```bash
./scripts/install-launchd.sh --dry-run
```

Remove:

```bash
./scripts/uninstall-launchd.sh
```

Runner shape:

```bash
cd /path/to/Remote-Codex-Control-Public
/usr/bin/caffeinate -i -m -s ./run.sh
```

Use `-s` only because it is valid on AC power. This matches the real “Mac awake at home” Telegram use case.

### Operator UX Copy

Use this wording:

```text
Keep RCC available from your phone by leaving your Mac awake, online, and on power. RCC can install a LaunchAgent that restarts the daemon and prevents idle sleep while on AC power. Closing a MacBook lid still requires Apple-supported closed-display mode: power, external display, and external keyboard/mouse. RCC does not bypass macOS lid sleep.
```

### P1: Local Desktop Automation Bridge

A local automation bridge is separate from keep-awake. It is needed only if RCC should productize desktop UI approval fallback or desktop-derived mirroring beyond App Server events.

Do not depend on this Codex-session Computer Use plugin at runtime. Instead, build a local-only bridge:

- bound to `127.0.0.1`
- disabled by default
- token-protected
- uses macOS Accessibility/AppleScript or a signed helper later
- exposes only narrow actions like `approval.preflight`, `approval.click`, and `desktop.state`
- logs confidence/reason when it refuses to act
- never exposes screenshots or raw desktop content by default

The bridge is useful for prototype desktop approvals, but App Server approvals remain the preferred path.

## Security Notes

- Do not request administrator privileges for the alpha LaunchAgent.
- Prefer user LaunchAgent over system LaunchDaemon because RCC depends on the user session, Codex account, local setup file, and possibly GUI/Accessibility state.
- Do not auto-edit `pmset` settings. If operators choose to change Battery settings, document it as manual.
- Do not keep the display awake by default; keep the daemon awake and let display sleep.
- Do not tell users to install third-party “keep awake with lid closed” tools as a default path.
- Do not claim remote access works if the Mac is asleep.

## Acceptance Criteria

1. `scripts/install-launchd.sh` installs a per-user LaunchAgent.
2. `scripts/uninstall-launchd.sh` removes it cleanly.
3. Runner starts RCC through `caffeinate -i -m -s ./run.sh`.
4. Logs are written under `.dist/logs/`.
5. `README.md`, `INSTALL.md`, and `QUICKSTART.md` explain the limit honestly.
6. `/status` documents whether sleep prevention is expected/active where detectable.
7. Manual test passes:
   - install LaunchAgent
   - log out/in or bootstrap agent
   - RCC starts
   - Telegram `/status` works
   - display sleeps but daemon remains alive on AC power
8. Docs explicitly say lid-close requires Apple-supported closed-display mode.

## Remaining Product Decision

The local desktop automation bridge is still a separate decision. Approve one of these later:

1. Keep desktop UI fallback as the current AppleScript/accessibility prototype.
2. Add a local-only desktop automation bridge scaffold for approval preflight/clicking and desktop-state diagnostics.
3. Disable desktop UI fallback and require App Server approvals only.

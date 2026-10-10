# Always-on Mac runtime

This page explains how to keep RCC running on your Mac with a LaunchAgent, and what sleep and lid-close limits still apply. It is for operators who want RCC to be reachable from Telegram while they are away.

## Short answer

RCC can keep `./run.sh` running across idle sleep. It does this with a per-user `launchd` LaunchAgent and macOS sleep assertions from `caffeinate`.

RCC cannot make a MacBook keep running after you close the lid in every setup. Apple supports closed-display use only when the Mac has power, an external display, and an external keyboard or mouse. Without those, closing the lid is a system sleep. RCC cannot override it.

If the Mac is asleep, RCC cannot receive Telegram updates, stream Codex output, or run commands.

## What macOS allows

Supported:

1. Keep RCC running while the Mac is awake, logged in, and the lid is open.
2. Prevent idle system sleep while RCC runs.
3. Let the display sleep while RCC keeps running.
4. Restart RCC after a crash or at login, with a per-user LaunchAgent.
5. Keep RCC running with the lid closed only in Apple-supported closed-display mode.

Do not claim these:

- RCC works after you close any MacBook lid.
- RCC bypasses macOS lid sleep.
- RCC keeps Codex running while the Mac is asleep.
- Remote access works while the Mac is asleep.

## Sources

- `man caffeinate`: `-i` prevents idle system sleep. `-s` prevents system sleep only on AC power.
- Apple Developer, `kIOPMAssertionTypePreventUserIdleSystemSleep`: the system can still sleep for a lid close, an Apple menu sleep, a low battery, or another sleep reason.
- Apple Support, [external display with the lid closed](https://support.apple.com/en-us/HT201177): the Mac must have power, an external keyboard, and an external mouse.
- Apple Support, [closed-lid accessories on Apple silicon](https://support.apple.com/en-us/102282): the external display, keyboard, and mouse must be allowed first.
- Apple Support, [sleep and wake settings](https://support.apple.com/en-gb/guide/mac-help/set-sleep-and-wake-settings-mchle41a6ccd/mac).
- Apple Support, [launchd and shell scripts](https://support.apple.com/en-ca/guide/terminal/apdc6c1077b-5d5d-4d35-9c19-60f2397b2369/mac): `launchd` runs daemons and agents, including shell scripts.
- Apple Developer, [creating launchd jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html): `RunAtLoad` and `KeepAlive` start and restart a job.

## The LaunchAgent

The optional installer creates a user LaunchAgent. It does the following:

- Starts RCC at user login.
- Restarts RCC after a crash. This uses `KeepAlive`.
- Runs RCC as `caffeinate -i -m -s ./run.sh`. The `-s` flag applies on AC power only.
- Writes logs to `.dist/logs/launchd.out.log` and `.dist/logs/launchd.err.log`.
- Does not change global `pmset` settings.
- Does not promise lid-closed operation.

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

Generate the plist and check it, without installing it:

```bash
./scripts/install-launchd.sh --dry-run
```

Remove it:

```bash
./scripts/uninstall-launchd.sh
```

The runner skips `caffeinate` when `RCC_DISABLE_CAFFEINATE` is `true` in its environment. The generated LaunchAgent does not set this variable. Add it to the plist only if you need that behaviour.

## Wording for operators

Use this wording when you describe the setup:

```text
Keep RCC available from your phone by leaving your Mac awake, online, and on power. RCC can install a LaunchAgent that restarts the daemon and prevents idle sleep while on AC power. Closing a MacBook lid still requires Apple-supported closed-display mode: power, external display, and external keyboard/mouse. RCC does not bypass macOS lid sleep.
```

## Security notes

- Do not ask for administrator privileges for the LaunchAgent.
- Use a user LaunchAgent, not a system LaunchDaemon. RCC depends on your user session, your Codex sign-in, your `setup.md`, and possibly the GUI and Accessibility state.
- Do not change `pmset` settings automatically. If you change battery settings, do it by hand.
- Do not keep the display awake. Keep the daemon awake and let the display sleep.
- Do not install third-party "keep awake with lid closed" tools as the default path.
- Do not say that remote access works while the Mac sleeps.

## Check it works

1. Install the LaunchAgent.
2. Log out and back in, or start the agent with `launchctl bootstrap`.
3. Check that RCC started, using the logs in `.dist/logs/`.
4. Send `/status` from Telegram. It should answer, and it shows whether sleep prevention is expected and active.
5. With the Mac on power, let the display sleep. The daemon should stay alive.

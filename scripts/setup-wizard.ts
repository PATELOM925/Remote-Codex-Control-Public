import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_CODEX_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const TOKEN_ENV = 'RCC_SETUP_BOT_TOKEN';
const HIDDEN = '<hidden>';
const TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const TOKEN_LIKE_PATTERN = /\d{6,12}:[A-Za-z0-9_-]{30,}/g;
const CHAT_ID_PATTERN = /^[1-9]\d{0,14}$/;
const MAX_TOKEN_TRIES = 3;
const CAPTURE_WINDOW_MS = 120_000;
const POLL_TIMEOUT_S = 10;

export const USAGE = `Usage: npm run setup -- [options]

Guided setup for Remote Codex Control. It asks for your bot token,
your Telegram chat, and the folders the agent may work in.

Options:
  --chat-id <id>          Your numeric private chat ID. Skips the chat check.
  --project <path>        A folder the agent may work in. Repeat for more folders.
  --yes                   Accept the defaults and replace setup.md without asking.
                          Needs --chat-id and a bot token in RCC_SETUP_BOT_TOKEN.
  --dry-run               Print the setup.md that would be written. Write nothing.
  --skip-telegram-check   Do not call Telegram. Only allowed with --dry-run.
  --help                  Show this help.

Environment:
  RCC_SETUP_BOT_TOKEN     Bot token from BotFather. Used instead of the prompt.
                          Set it in the environment. Never pass it as an argument.`;

export class WizardError extends Error {}

export interface WizardIo {
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  log(line: string): void;
}

export interface WizardDeps {
  io: WizardIo;
  fetch: typeof fetch;
  fs: typeof fs;
  env: Record<string, string | undefined>;
  clock: { now(): number };
  home: string;
  startDir: string;
  rootDir: string;
  setupPath: string;
  nodeVersion: string;
  now(): Date;
  checkCodex(): Promise<string | undefined>;
  isGitIgnored(file: string): Promise<boolean | undefined>;
  startRcc(): Promise<number>;
}

export interface ParsedArgs {
  chatId?: string;
  projects: string[];
  yes: boolean;
  dryRun: boolean;
  skipTelegramCheck: boolean;
  help: boolean;
}

export interface ChatCandidate {
  id: string;
  type: string;
  firstName?: string;
  username?: string;
}

export interface SetupValues {
  botToken: string;
  chatId: string;
  projectRoots: string[];
}

/** Replaces the given token and any bot-token-shaped text with a placeholder before the text is printed. */
export const scrubSecrets = (text: string, token?: string): string => {
  const withoutToken = token ? text.split(token).join(HIDDEN) : text;
  return withoutToken.replace(TOKEN_LIKE_PATTERN, HIDDEN);
};

const messageOf = (error: unknown, token?: string): string =>
  scrubSecrets(error instanceof Error ? error.message : String(error), token);

export const isBotTokenShape = (token: string): boolean => TOKEN_PATTERN.test(token);

export const isNodeVersionSupported = (current: string, engineRange: string): boolean => {
  const match = />=\s*(\d+)\.(\d+)(?:\.(\d+))?/.exec(engineRange);
  if (!match) {
    return true;
  }
  const wanted = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const have = current.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const actual = have[index] ?? 0;
    const minimum = wanted[index] ?? 0;
    if (actual !== minimum) {
      return actual > minimum;
    }
  }
  return true;
};

export const parseArgs = (argv: string[]): ParsedArgs => {
  const options: ParsedArgs = { projects: [], yes: false, dryRun: false, skipTelegramCheck: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);
    const takeValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new WizardError(`${name} needs a value.`);
      }
      index += 1;
      return next;
    };

    switch (name) {
      case '--chat-id':
        options.chatId = takeValue();
        break;
      case '--project':
        options.projects.push(takeValue());
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--skip-telegram-check':
        options.skipTelegramCheck = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--token':
      case '--bot-token':
        throw new WizardError(`Do not pass the bot token as an argument. Set ${TOKEN_ENV} in the environment instead.`);
      default:
        // Do not echo the argument. A token pasted by mistake must not reach the terminal.
        throw new WizardError('Unknown or unexpected argument. Run with --help to see the options.');
    }
  }

  if (options.chatId !== undefined && !CHAT_ID_PATTERN.test(options.chatId)) {
    throw new WizardError('--chat-id must be a numeric private chat ID.');
  }
  if (options.skipTelegramCheck && !options.dryRun) {
    throw new WizardError('--skip-telegram-check only works with --dry-run.');
  }
  return options;
};

const callTelegram = async <T>(
  deps: WizardDeps,
  token: string,
  method: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> => {
  let response: Response;
  try {
    response = await deps.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // The original error is dropped on purpose. It can include the request URL, which holds the token.
    throw new WizardError('Could not reach Telegram. Check your network connection and try again.');
  }

  let payload: { ok?: boolean; result?: T; description?: string } | undefined;
  try {
    payload = (await response.json()) as { ok?: boolean; result?: T; description?: string };
  } catch {
    payload = undefined;
  }

  if (!payload?.ok || payload.result === undefined) {
    const detail = payload?.description ? ` Telegram said: ${scrubSecrets(payload.description, token)}.` : '';
    if (response.status === 401 || response.status === 404) {
      throw new WizardError('Telegram rejected this token. Check that you copied the whole token from BotFather.');
    }
    if (response.status === 409) {
      throw new WizardError('Telegram refused to send updates for this bot. Stop ./run.sh if it is running, then try again.');
    }
    throw new WizardError(`Telegram returned an error (HTTP ${response.status}).${detail}`);
  }
  return payload.result;
};

export const fetchBotIdentity = async (
  deps: WizardDeps,
  token: string,
): Promise<{ username?: string; firstName?: string }> => {
  const me = await callTelegram<{ username?: string; first_name?: string }>(deps, token, 'getMe', {}, 15_000);
  return { username: me.username, firstName: me.first_name };
};

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: string; first_name?: string; username?: string };
    from?: { first_name?: string; username?: string };
  };
}

/**
 * Polls getUpdates until the user confirms a private chat that sent a message.
 * Returns undefined when the capture window ends with no confirmed chat.
 */
export const captureOperatorChat = async (
  deps: WizardDeps,
  token: string,
  confirmChat: (candidate: ChatCandidate) => Promise<boolean>,
): Promise<ChatCandidate | undefined> => {
  const deadline = deps.clock.now() + CAPTURE_WINDOW_MS;
  let offset: number | undefined;

  while (deps.clock.now() < deadline) {
    const updates = await callTelegram<TelegramUpdate[]>(
      deps,
      token,
      'getUpdates',
      {
        timeout: POLL_TIMEOUT_S,
        allowed_updates: ['message'],
        ...(offset === undefined ? {} : { offset }),
      },
      (POLL_TIMEOUT_S + 15) * 1000,
    );

    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (!message) {
        continue;
      }

      const chat = message.chat;
      if (chat.type !== 'private') {
        deps.io.log(`Ignored a ${chat.type} chat. RCC only accepts a private chat with you. Send the bot a message from your own account.`);
        continue;
      }

      const candidate: ChatCandidate = {
        id: String(chat.id),
        type: chat.type,
        firstName: message.from?.first_name ?? chat.first_name,
        username: message.from?.username ?? chat.username,
      };
      if (await confirmChat(candidate)) {
        return candidate;
      }
      deps.io.log('OK. Waiting for another message.');
    }
  }

  return undefined;
};

export const expandHome = (input: string, home: string): string => {
  if (input === '~') {
    return home;
  }
  return input.startsWith('~/') ? path.join(home, input.slice(2)) : input;
};

export const displayPath = (folder: string, home: string): string => {
  if (folder === home) {
    return '~';
  }
  return folder.startsWith(`${home}${path.sep}`) ? `~${folder.slice(home.length)}` : folder;
};

export const resolveProjectFolder = (input: string, deps: WizardDeps): string => {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new WizardError('Enter a folder path.');
  }
  if (trimmed.includes(',')) {
    throw new WizardError('A folder path cannot contain a comma.');
  }

  const resolved = path.resolve(deps.startDir, expandHome(trimmed, deps.home));
  const shown = displayPath(resolved, deps.home);
  if (!deps.fs.existsSync(resolved)) {
    throw new WizardError(`Folder not found: ${shown}`);
  }
  if (!deps.fs.statSync(resolved).isDirectory()) {
    throw new WizardError(`Not a folder: ${shown}`);
  }
  if (isTooBroad(resolved, deps.home)) {
    throw new WizardError(`${shown} is too broad. Choose one project folder, not your home folder or the disk root.`);
  }
  return resolved;
};

// The agent may write anywhere under a project folder, so the home folder and the disk root are refused.
export const isTooBroad = (folder: string, home: string): boolean =>
  folder === path.parse(folder).root || path.resolve(folder) === path.resolve(home);

export const renderSetupMd = (values: SetupValues, options: { hideToken: boolean }): string =>
  [
    '# RCC local setup. Written by npm run setup.',
    '# This file holds your bot token. Keep it private and do not commit it.',
    '',
    '# Telegram',
    `RCC_TELEGRAM_BOT_TOKEN=${options.hideToken ? HIDDEN : values.botToken}`,
    `RCC_OPERATOR_CHAT_ID=${values.chatId}`,
    `RCC_ALLOWED_CHAT_IDS=${values.chatId}`,
    'RCC_TELEGRAM_TRANSPORT=long_polling',
    '',
    '# Folders the agent may work in. Separate them with commas.',
    `RCC_PROJECT_ROOTS=${values.projectRoots.join(',')}`,
    '',
    '# The relay is not part of the local Telegram setup.',
    'RCC_RELAY_ENABLED=false',
    '',
  ].join('\n');

const readEngineRange = (deps: WizardDeps): string => {
  const pkg = JSON.parse(deps.fs.readFileSync(path.join(deps.rootDir, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  return pkg.engines?.node ?? '>=0.0.0';
};

const parseChatIdInput = (value: string): string | undefined => (CHAT_ID_PATTERN.test(value) ? value : undefined);

const promptForToken = async (opts: ParsedArgs, deps: WizardDeps): Promise<string> => {
  deps.io.log('');
  deps.io.log('Bot token');
  deps.io.log('1. In Telegram, open @BotFather and send /newbot.');
  deps.io.log('2. Pick a display name and a username that ends in "bot".');
  deps.io.log('3. Copy the token BotFather sends back and paste it below. It will not be shown.');

  for (let attempt = 1; attempt <= MAX_TOKEN_TRIES; attempt += 1) {
    const answer = (await deps.io.askSecret('Bot token: ')).trim();
    if (!isBotTokenShape(answer)) {
      deps.io.log('That does not look like a BotFather token. It has a number, a colon, then letters, numbers, _ or -.');
    } else if (opts.skipTelegramCheck) {
      deps.io.log('Skipped the Telegram check (--skip-telegram-check).');
      return answer;
    } else {
      try {
        const identity = await fetchBotIdentity(deps, answer);
        const label = identity.username ? `@${identity.username}` : identity.firstName ?? 'your bot';
        deps.io.log(`Connected to ${label}.`);
        return answer;
      } catch (error) {
        deps.io.log(messageOf(error, answer));
      }
    }
    if (attempt < MAX_TOKEN_TRIES) {
      deps.io.log(`Try again. ${MAX_TOKEN_TRIES - attempt} ${MAX_TOKEN_TRIES - attempt === 1 ? 'try' : 'tries'} left.`);
    }
  }

  throw new WizardError(`No valid bot token after ${MAX_TOKEN_TRIES} tries. Run npm run setup again when you have the token.`);
};

const promptForChat = async (token: string, deps: WizardDeps): Promise<string> => {
  const confirm = async (question: string): Promise<boolean> => /^y(es)?$/i.test((await deps.io.ask(question)).trim());
  const confirmChat = async (candidate: ChatCandidate): Promise<boolean> => {
    deps.io.log('Message received:');
    deps.io.log(`  Name: ${candidate.firstName ?? '(none)'}`);
    if (candidate.username) {
      deps.io.log(`  Username: @${candidate.username}`);
    }
    deps.io.log(`  Chat type: ${candidate.type}`);
    deps.io.log(`  Chat ID: ${candidate.id}`);
    return confirm('Is this your own chat? [y/N]: ');
  };

  deps.io.log('');
  deps.io.log('Chat ID');
  deps.io.log('Open your bot in Telegram and send it any message, such as /start.');
  deps.io.log('Waiting up to 120 seconds.');

  let candidate = await captureOperatorChat(deps, token, confirmChat);
  while (!candidate) {
    const typed = (await deps.io.ask(
      'No confirmed message arrived. Type your numeric chat ID, or press Enter to wait another 120 seconds: ',
    )).trim();
    if (typed === '') {
      deps.io.log('Waiting for a message.');
      candidate = await captureOperatorChat(deps, token, confirmChat);
      continue;
    }
    const chatId = parseChatIdInput(typed);
    if (chatId) {
      return chatId;
    }
    deps.io.log('A chat ID is a positive number, such as 123456789.');
  }
  return candidate.id;
};

const promptForProjects = async (opts: ParsedArgs, deps: WizardDeps): Promise<string[]> => {
  if (opts.projects.length > 0) {
    return [...new Set(opts.projects.map((input) => resolveProjectFolder(input, deps)))];
  }
  if (opts.yes) {
    return [resolveProjectFolder(deps.startDir, deps)];
  }

  deps.io.log('');
  deps.io.log('Project folders');
  deps.io.log('These are the folders the agent may work in.');
  const folders: string[] = [];
  for (;;) {
    const first = folders.length === 0;
    // Offer the start folder as the default only when it is a sensible project folder.
    const fallback = first && !isTooBroad(deps.startDir, deps.home) ? deps.startDir : '';
    const prompt = !first
      ? 'Add another project folder, or press Enter to finish: '
      : fallback
        ? `Project folder [${displayPath(fallback, deps.home)}]: `
        : 'Project folder (for example ~/code/my-app): ';
    const typed = (await deps.io.ask(prompt)).trim();
    const input = typed === '' && first ? fallback : typed;
    if (input === '' && first) {
      deps.io.log('Enter a folder path.');
      continue;
    }
    if (input === '') {
      break;
    }
    try {
      const folder = resolveProjectFolder(input, deps);
      if (!folders.includes(folder)) {
        folders.push(folder);
      }
    } catch (error) {
      deps.io.log(messageOf(error));
    }
  }
  return folders;
};

const runSteps = async (opts: ParsedArgs, deps: WizardDeps): Promise<number> => {
  const requiredNode = readEngineRange(deps);
  if (!isNodeVersionSupported(deps.nodeVersion, requiredNode)) {
    deps.io.log(`Node ${deps.nodeVersion} is too old for RCC. Install Node ${requiredNode}, then run npm run setup again.`);
    return 1;
  }

  const codex = await deps.checkCodex();
  deps.io.log(
    codex
      ? `Codex found: ${codex}.`
      : 'Codex was not found. Install and sign in to the Codex app or CLI before real use. Setup will continue.',
  );

  if (opts.yes && opts.chatId === undefined) {
    throw new WizardError('--yes needs --chat-id, because a person must confirm the Telegram chat.');
  }

  let token: string;
  const envToken = deps.env[TOKEN_ENV]?.trim() ?? '';
  if (envToken) {
    if (!isBotTokenShape(envToken)) {
      throw new WizardError(`${TOKEN_ENV} does not look like a BotFather token.`);
    }
    token = envToken;
    if (opts.skipTelegramCheck) {
      deps.io.log('Skipped the Telegram check (--skip-telegram-check).');
    } else {
      const identity = await fetchBotIdentity(deps, token);
      deps.io.log(`Connected to ${identity.username ? `@${identity.username}` : 'your bot'}.`);
    }
  } else {
    if (opts.yes) {
      throw new WizardError(`Set ${TOKEN_ENV} in the environment for --yes runs.`);
    }
    token = await promptForToken(opts, deps);
  }

  const chatId = opts.chatId ?? (await promptForChat(token, deps));
  const projectRoots = await promptForProjects(opts, deps);
  const setupText = renderSetupMd({ botToken: token, chatId, projectRoots }, { hideToken: false });

  const exists = deps.fs.existsSync(deps.setupPath);
  const lastChanged = exists ? deps.fs.statSync(deps.setupPath).mtime.toLocaleString() : undefined;

  if (opts.dryRun) {
    if (exists) {
      deps.io.log(`setup.md exists and was last changed ${lastChanged}. A real run asks before it replaces the file.`);
    }
    deps.io.log('Dry run. Nothing was written. This is the setup.md that would be written:');
    deps.io.log('');
    deps.io.log(renderSetupMd({ botToken: token, chatId, projectRoots }, { hideToken: true }).trimEnd());
    return 0;
  }

  if (exists) {
    deps.io.log(`setup.md already exists and was last changed ${lastChanged}.`);
    if (opts.yes) {
      deps.io.log('Replacing it. The old file is kept as a backup.');
    } else {
      const replace = /^y(es)?$/i.test((await deps.io.ask('Replace it? The old file is kept as a backup. [y/N]: ')).trim());
      if (!replace) {
        deps.io.log('Left setup.md unchanged.');
        return 0;
      }
    }
  }

  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  if (exists) {
    const backupPath = `${deps.setupPath}.bak-${stamp}`;
    deps.fs.copyFileSync(deps.setupPath, backupPath, fs.constants.COPYFILE_EXCL);
    deps.fs.chmodSync(backupPath, 0o600);
    deps.io.log(`Backed up the old file to ${path.basename(backupPath)}.`);
  }

  // The file holds the bot token. It is created exclusively with mode 600, then renamed into place.
  const tempPath = `${deps.setupPath}.tmp-${process.pid}`;
  try {
    deps.fs.writeFileSync(tempPath, setupText, { mode: 0o600, flag: 'wx' });
    deps.fs.chmodSync(tempPath, 0o600);
    deps.fs.renameSync(tempPath, deps.setupPath);
  } catch (error) {
    deps.fs.rmSync(tempPath, { force: true });
    throw error;
  }
  deps.io.log('Wrote setup.md (permissions 600).');

  if ((await deps.isGitIgnored(deps.setupPath)) === false) {
    deps.io.log('Warning: setup.md is not git-ignored. Do not commit it. Check .gitignore before you commit.');
  }

  deps.io.log('');
  deps.io.log('Next steps:');
  deps.io.log('1. Run ./run.sh and keep that terminal open.');
  deps.io.log('2. In Telegram, send /status to your bot.');

  if (opts.yes) {
    return 0;
  }
  const start = /^y(es)?$/i.test((await deps.io.ask('Start RCC now with ./run.sh? [y/N]: ')).trim());
  return start ? deps.startRcc() : 0;
};

export const runWizard = async (argv: string[], deps: WizardDeps): Promise<number> => {
  let opts: ParsedArgs;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    deps.io.log(messageOf(error));
    deps.io.log('Run with --help to see the options.');
    return 2;
  }

  if (opts.help) {
    deps.io.log(USAGE);
    return 0;
  }

  try {
    return await runSteps(opts, deps);
  } catch (error) {
    deps.io.log(`Setup stopped: ${messageOf(error, deps.env[TOKEN_ENV])}`);
    return 1;
  }
};

const checkCodexVersion = (command: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(String(stdout).trim().split('\n')[0] || 'installed');
    });
  });

const findCodex = async (): Promise<string | undefined> => {
  for (const command of ['codex', APP_CODEX_BIN]) {
    const version = await checkCodexVersion(command);
    if (version) {
      return version;
    }
  }
  return undefined;
};

const checkGitIgnored = (file: string): Promise<boolean | undefined> =>
  new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', '--', path.basename(file)], { cwd: path.dirname(file), timeout: 5000 }, (error) => {
      if (!error) {
        resolve(true);
        return;
      }
      // Exit code 1 means git ran and the file is not ignored. Anything else means git could not answer.
      resolve((error as { code?: unknown }).code === 1 ? false : undefined);
    });
  });

export const createTerminalIo = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream & { isTTY?: boolean; columns?: number } = process.stdout,
): WizardIo & { close(): void } => {
  let hidden = false;
  let closed = false;
  let rejectPending: ((error: Error) => void) | undefined;

  // Readline echoes typed characters through this sink. Dropping them while hidden keeps the token off the screen.
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) {
        output.write(chunk);
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean; columns?: number };
  sink.isTTY = output.isTTY;
  sink.columns = output.columns;

  const rl = readline.createInterface({ input, output: sink, terminal: Boolean(output.isTTY) });
  rl.on('close', () => {
    closed = true;
    rejectPending?.(new WizardError('Input ended before setup finished.'));
  });
  rl.on('SIGINT', () => {
    output.write('\n');
    rl.close();
    process.exit(130);
  });

  const question = (prompt: string, secret: boolean): Promise<string> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new WizardError('Input ended before setup finished.'));
        return;
      }
      output.write(prompt);
      hidden = secret;
      rejectPending = reject;
      rl.question('', (answer) => {
        hidden = false;
        rejectPending = undefined;
        if (secret) {
          output.write('\n');
        }
        resolve(answer);
      });
    });

  return {
    ask: (prompt) => question(prompt, false),
    askSecret: (prompt) => question(prompt, true),
    log: (line) => console.log(line),
    close: () => rl.close(),
  };
};

const isMainModule = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const io = createTerminalIo();
  const startRcc = (): Promise<number> =>
    new Promise((resolve) => {
      // Release the terminal so run.sh can read it.
      io.close();
      const child = spawn('bash', [path.join(ROOT_DIR, 'run.sh')], { cwd: ROOT_DIR, stdio: 'inherit' });
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });

  const deps: WizardDeps = {
    io,
    fetch: globalThis.fetch,
    fs,
    env: process.env,
    clock: { now: () => Date.now() },
    home: os.homedir(),
    // npm changes the working directory to the package, so INIT_CWD holds where the user ran npm.
    startDir: process.env.INIT_CWD ?? process.cwd(),
    rootDir: ROOT_DIR,
    setupPath: path.join(ROOT_DIR, 'setup.md'),
    nodeVersion: process.versions.node,
    now: () => new Date(),
    checkCodex: findCodex,
    isGitIgnored: checkGitIgnored,
    startRcc,
  };

  runWizard(process.argv.slice(2), deps)
    .then((code) => {
      io.close();
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      io.close();
      console.error(`Setup stopped: ${messageOf(error, process.env[TOKEN_ENV])}`);
      process.exitCode = 1;
    });
}

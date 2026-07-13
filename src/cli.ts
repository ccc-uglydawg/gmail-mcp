#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFileSync } from 'node:fs';
import open from 'open';
import { buildContext, type AppContext } from './context.js';
import { OAuthService } from './google/oauth.js';
import { loadOAuthConfig } from './config.js';
import { AccountStore } from './store.js';

/**
 * Minimal flag parser: pulls `--key value` and `--flag` (boolean) pairs out of
 * argv, leaving positional args behind. No dependency on a CLI framework —
 * the surface is small enough not to warrant one.
 */
interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function print(value: unknown): void {
  stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const HELP = `gmail — Gmail + Google Calendar from your shell

Usage:
  gmail auth [--label <name>]            Connect a Google account (opens browser)
  gmail accounts                         List connected accounts
  gmail default <label>                  Set the default account
  gmail remove <label>                   Disconnect an account
  gmail search "<query>" [--account <l>] [--max <n>]
  gmail get <message_id> [--account <l>]
  gmail attachment <message_id> <attachment_id> --out <file> [--account <l>]
  gmail send --to <addr> --subject <s> --body <b> [--cc <a>] [--bcc <a>] [--account <l>] [--yes]
  gmail cal-search [--query <q>] [--from <rfc3339>] [--to <rfc3339>] [--max <n>] [--account <l>]
  gmail cal-add --title <t> --start <rfc3339> --end <rfc3339> [--tz <ianazone>] [--desc <d>] [--location <l>] [--account <acct>]

Account resolution: --account picks a label; omit it to use the default.
Credentials: set GMAIL_OAUTH_CLIENT_ID (and optionally GMAIL_OAUTH_CLIENT_SECRET),
or ~/.gmail-mcp/config.json. See the README for OAuth client setup.`;

async function cmdAuth(flags: Record<string, string | boolean>): Promise<void> {
  // Auth doesn't need the full context (no clients yet) — just config + store.
  const config = loadOAuthConfig();
  const store = AccountStore.load();
  const oauth = new OAuthService(config);

  stdout.write('Opening your browser to authorize… (if it does not open, copy the URL printed below)\n');
  const account = await oauth.authorizeInteractive(async (url) => {
    stdout.write(`\n${url}\n\n`);
    try {
      await open(url);
    } catch {
      /* headless — the URL is printed above. */
    }
  });

  let label = str(flags, 'label');
  if (!label) {
    label = await prompt(`Connected ${account.email}. Label for this account (e.g. personal): `);
  }
  if (!label) {
    throw new Error('A label is required.');
  }

  const saved = store.upsert({ label, ...account });
  print({
    connected: saved.email,
    label: saved.label,
    is_default: saved.isDefault,
    scopes: saved.scopes,
  });
}

async function cmdSend(ctx: AppContext, flags: Record<string, string | boolean>): Promise<void> {
  const to = str(flags, 'to');
  const subject = str(flags, 'subject');
  const body = str(flags, 'body');
  if (!to || !subject || body === undefined) {
    throw new Error('send requires --to, --subject, and --body.');
  }
  const account = ctx.store.resolve(str(flags, 'account'));

  if (flags.yes !== true) {
    stdout.write(
      `About to send from ${account.email}:\n` +
        `  To:      ${to}\n` +
        `  Subject: ${subject}\n` +
        `  Body:    ${body.length} chars\n`,
    );
    const answer = await prompt('Send this email? [y/N] ');
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      print({ sent: false, reason: 'cancelled by user' });
      return;
    }
  }

  const result = await ctx.gmail.send(account, to, subject, body, str(flags, 'cc'), str(flags, 'bcc'));
  print({ sent: true, account: account.email, ...result });
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === 'help' || flags.help === true) {
    stdout.write(HELP + '\n');
    return;
  }

  // auth builds its own minimal deps (no account required yet).
  if (command === 'auth') {
    await cmdAuth(flags);
    return;
  }

  const ctx = buildContext();

  switch (command) {
    case 'accounts':
      print({ accounts: ctx.store.list() });
      break;

    case 'default': {
      const label = positional[1];
      if (!label) throw new Error('Usage: gmail default <label>');
      ctx.store.setDefault(label);
      print({ default: label });
      break;
    }

    case 'remove': {
      const label = positional[1];
      if (!label) throw new Error('Usage: gmail remove <label>');
      ctx.store.remove(label);
      print({ removed: label });
      break;
    }

    case 'search': {
      const query = positional[1];
      if (!query) throw new Error('Usage: gmail search "<query>"');
      const account = ctx.store.resolve(str(flags, 'account'));
      const max = Math.min(50, Math.max(1, Number(str(flags, 'max') ?? 10)));
      print(await ctx.gmail.search(account, query, max));
      break;
    }

    case 'get': {
      const id = positional[1];
      if (!id) throw new Error('Usage: gmail get <message_id>');
      const account = ctx.store.resolve(str(flags, 'account'));
      print(await ctx.gmail.getMessage(account, id));
      break;
    }

    case 'attachment': {
      const [, messageId, attachmentId] = positional;
      const out = str(flags, 'out');
      if (!messageId || !attachmentId || !out) {
        throw new Error('Usage: gmail attachment <message_id> <attachment_id> --out <file>');
      }
      const account = ctx.store.resolve(str(flags, 'account'));
      const bytes = await ctx.gmail.getAttachment(account, messageId, attachmentId);
      writeFileSync(out, bytes);
      print({ saved: out, bytes: bytes.length });
      break;
    }

    case 'send':
      await cmdSend(ctx, flags);
      break;

    case 'cal-search': {
      const account = ctx.store.resolve(str(flags, 'account'));
      const max = Math.min(100, Math.max(1, Number(str(flags, 'max') ?? 25)));
      print(
        await ctx.calendar.searchEvents(
          account,
          str(flags, 'query'),
          str(flags, 'from'),
          str(flags, 'to'),
          max,
        ),
      );
      break;
    }

    case 'cal-add': {
      const title = str(flags, 'title');
      const start = str(flags, 'start');
      const end = str(flags, 'end');
      if (!title || !start || !end) {
        throw new Error('cal-add requires --title, --start, and --end.');
      }
      const account = ctx.store.resolve(str(flags, 'account'));
      print(
        await ctx.calendar.createEvent(account, {
          title,
          start,
          end,
          timezone: str(flags, 'tz'),
          description: str(flags, 'desc'),
          location: str(flags, 'location'),
        }),
      );
      break;
    }

    default:
      stderr(`Unknown command: ${command}\n\n` + HELP);
      process.exitCode = 1;
  }
}

function stderr(msg: string): void {
  process.stderr.write(msg + '\n');
}

main().catch((err) => {
  stderr(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

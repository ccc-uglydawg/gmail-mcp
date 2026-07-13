# gmail-mcp

Gmail + Google Calendar over the [Model Context Protocol](https://modelcontextprotocol.io) — and a plain CLI.

Search, read, and send mail; search and create calendar events. Use it as an **MCP server** inside
Claude Desktop / Claude Code / Cursor, or as a **command-line tool** in your shell. One local install,
your own Google OAuth client, tokens encrypted at rest on your machine. No third-party server sees your
mail.

- **Read:** `gmail_search`, `gmail_get`, `gmail_get_attachment`
- **Send:** `gmail_send` (plain text, cc/bcc)
- **Calendar:** `calendar_search`, `calendar_add_event`
- **Accounts:** connect multiple Google accounts, address them by label

---

## Install

Requires **Node 20+**.

```bash
pnpm add -g gmail-mcp
# or run without installing:
pnpm dlx gmail-mcp --help
```

(npm/npx work too — `npm i -g gmail-mcp`, `npx gmail-mcp`. This repo is developed with pnpm.)

Then create your Google OAuth client (once — see below) and connect an account:

```bash
gmail auth
```

---

## Google OAuth setup (one time)

You bring your own OAuth client so the app talks to Google as *you*. It stays in "Testing" mode and
private to you — no verification needed.

1. **Create a project** at <https://console.cloud.google.com/> (signed in to the Google account you want
   to connect). Name it anything.
2. **Enable APIs** → APIs & Services → Library → enable **Gmail API** and **Google Calendar API**.
3. **OAuth consent screen** → User type **External** → fill in app name + your email. Under **Scopes**,
   add:
   - `.../auth/gmail.readonly`
   - `.../auth/gmail.send`
   - `.../auth/calendar.events`
   - `.../auth/userinfo.email`

   Under **Test users**, add every Google address you plan to connect. Leave the app in **Testing**.
4. **Create the OAuth client** → Credentials → Create credentials → **OAuth client ID** →
   application type **Desktop app**. Name it `gmail-mcp`.
   - Unlike a *Web* client, a Desktop client needs **no fixed redirect URI** — this tool uses Google's
     loopback flow on a random `127.0.0.1` port.
5. **Copy the Client ID** (and secret, if shown). Provide them to the tool one of two ways:

   ```bash
   # Environment variables:
   export GMAIL_OAUTH_CLIENT_ID="…apps.googleusercontent.com"
   export GMAIL_OAUTH_CLIENT_SECRET="…"        # optional for Desktop clients
   ```

   or a config file at `~/.gmail-mcp/config.json`:

   ```json
   { "clientId": "…apps.googleusercontent.com", "clientSecret": "…" }
   ```

6. **Connect:**

   ```bash
   gmail auth
   ```

   Your browser opens; approve the scopes (click through the "Google hasn't verified this app" notice —
   expected for a Testing-mode app). Enter a short label (`personal`, `work`, …). The first account
   connected becomes the default.

---

## Use it as a CLI

```bash
gmail accounts
gmail search "from:someone@example.com has:attachment" --max 20
gmail get 197ec5fed968c712
gmail attachment 197ec5fed968c712 ANGjdJ8x… --out ./file.pdf
gmail send --to a@b.com --subject "Hi" --body "Sent from gmail-mcp"      # prompts y/N
gmail send --to a@b.com --subject "Hi" --body "…" --yes                  # skip the prompt
gmail cal-search --from 2026-07-12T00:00:00Z --max 10
gmail cal-add --title "Standup" --start 2026-07-14T09:00:00 --end 2026-07-14T09:15:00 --tz America/Chicago
```

Every command takes `--account <label>` to target a specific connected account; omit it to use the default.

## Use it as an MCP server

Add it to your MCP host's config. **Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["-y", "gmail-mcp"],
      "env": {
        "GMAIL_OAUTH_CLIENT_ID": "…apps.googleusercontent.com",
        "GMAIL_OAUTH_CLIENT_SECRET": "…"
      }
    }
  }
}
```

(If you set up `~/.gmail-mcp/config.json` and ran `gmail auth` already, you can drop the `env` block.)

**Claude Code:**

```bash
claude mcp add gmail -- npx -y gmail-mcp
```

(The host config uses `npx` because it ships with Node — end users don't need pnpm installed just to
run the published package. pnpm is only needed for local development of this repo.)

The host launches `gmail-mcp` over stdio and exposes these tools:

| Tool | What it does |
|------|--------------|
| `list_accounts` | List connected accounts + default |
| `gmail_search` | Search with Gmail query syntax |
| `gmail_get` | Full body + attachment metadata for one message |
| `gmail_get_attachment` | Download an attachment to disk |
| `gmail_send` | Send plain-text mail (to/cc/bcc) |
| `calendar_search` | Search primary-calendar events |
| `calendar_add_event` | Create an event on the primary calendar |

> **Sending:** `gmail_send` sends immediately. There is no built-in approval gate — rely on your MCP
> host's tool-call confirmation, and instruct the model to confirm with you before sending.

---

## Where your data lives

Everything is local, under `~/.gmail-mcp/` (override with `GMAIL_MCP_HOME`):

- `accounts.json` — your refresh/access tokens, **encrypted at rest** (AES-256-GCM).
- `key` — the machine-local encryption key (mode `0600`).
- `config.json` — your OAuth client id/secret, if you chose the file route.

This is machine-local encryption: it protects the token file from casual disk reads and backups, not
from someone who already has read access to your home directory (same posture as `~/.aws/credentials`,
but sealed). To fully revoke, delete the account (`gmail remove <label>`) and revoke at
<https://myaccount.google.com/permissions>.

---

## Development

```bash
pnpm install
pnpm run build          # tsc -> dist/
pnpm run typecheck      # tsc --noEmit
pnpm run dev:cli search "in:inbox newer_than:1d"   # run TS directly via tsx
pnpm run dev:mcp        # run the MCP server from source
```

Project layout:

```
src/
  google/oauth.ts     OAuth2 loopback flow + token refresh
  google/gmail.ts     Gmail search / get / send / attachments
  google/calendar.ts  Calendar search / create
  store.ts            Encrypted, file-backed multi-account token store
  config.ts           OAuth client + state-dir resolution
  tools.ts            Tool definitions (Zod schemas + handlers)
  mcp.ts              MCP server entrypoint (stdio)
  cli.ts              CLI entrypoint
```

## License

MIT © 2026 Sean O'Dea

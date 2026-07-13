import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The OAuth scopes this tool requests. Mirrors Noteward's grant: read + send
 * mail, read/write primary calendar, and the account email so we know which
 * account just authenticated.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

/**
 * Where all local state lives. Override with GMAIL_MCP_HOME for tests or to
 * keep multiple isolated profiles.
 */
export function stateDir(): string {
  return process.env.GMAIL_MCP_HOME ?? join(homedir(), '.gmail-mcp');
}

export function accountsPath(): string {
  return join(stateDir(), 'accounts.json');
}

export function keyPath(): string {
  return join(stateDir(), 'key');
}

/**
 * Base directory the MCP `gmail_get_attachment` tool is allowed to write into.
 * Attachment writes are confined here so a prompt-injected model cannot be
 * steered into overwriting arbitrary files. Override with GMAIL_MCP_DOWNLOAD_DIR.
 */
export function downloadDir(): string {
  return process.env.GMAIL_MCP_DOWNLOAD_DIR ?? join(stateDir(), 'downloads');
}

function configPath(): string {
  return join(stateDir(), 'config.json');
}

export interface OAuthConfig {
  clientId: string;
  /**
   * Optional for installed/Desktop OAuth clients. Google still accepts it and
   * some projects mint Desktop clients with a secret, so we send it when set.
   */
  clientSecret?: string;
}

/**
 * Resolve the OAuth client credentials. Precedence:
 *   1. env: GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET
 *   2. ~/.gmail-mcp/config.json: { "clientId": "...", "clientSecret": "..." }
 *
 * Throws a friendly, actionable error if no client id is found — this is the
 * single most common first-run failure, so the message points straight at the
 * fix.
 */
export function loadOAuthConfig(): OAuthConfig {
  const envId = process.env.GMAIL_OAUTH_CLIENT_ID?.trim();
  const envSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET?.trim();
  if (envId) {
    return { clientId: envId, clientSecret: envSecret || undefined };
  }

  const path = configPath();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OAuthConfig>;
      if (parsed.clientId && parsed.clientId.trim() !== '') {
        return {
          clientId: parsed.clientId.trim(),
          clientSecret: parsed.clientSecret?.trim() || undefined,
        };
      }
    } catch {
      throw new Error(`Could not parse ${path} — expected JSON with a "clientId" field.`);
    }
  }

  throw new Error(
    'No Google OAuth client id found.\n' +
      'Set GMAIL_OAUTH_CLIENT_ID (and optionally GMAIL_OAUTH_CLIENT_SECRET),\n' +
      `or create ${path} with {"clientId":"...","clientSecret":"..."}.\n` +
      'See the README "Google OAuth setup" section to create a Desktop OAuth client.',
  );
}

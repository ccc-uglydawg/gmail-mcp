import { loadOAuthConfig } from './config.js';
import { AccountStore } from './store.js';
import { OAuthService } from './google/oauth.js';
import { GmailClient } from './google/gmail.js';
import { CalendarClient } from './google/calendar.js';

/**
 * The wired-up set of services both the CLI and the MCP server operate on.
 * Built once per process. Loading the OAuth config here means a missing
 * client id fails fast with a clear message before any command runs.
 */
export interface AppContext {
  store: AccountStore;
  oauth: OAuthService;
  gmail: GmailClient;
  calendar: CalendarClient;
}

export function buildContext(): AppContext {
  const config = loadOAuthConfig();
  const store = AccountStore.load();
  const oauth = new OAuthService(config);
  const gmail = new GmailClient(oauth, store);
  const calendar = new CalendarClient(oauth, store, process.env.GMAIL_MCP_TZ ?? 'UTC');
  return { store, oauth, gmail, calendar };
}

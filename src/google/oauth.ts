import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import type { Account, AccountStore } from '../store.js';
import type { OAuthConfig } from '../config.js';
import { SCOPES } from '../config.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Refresh this many ms before actual expiry to leave request headroom. */
const REFRESH_SKEW_MS = 60_000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Google OAuth2 for installed/Desktop apps using the loopback redirect flow.
 * Ported from Noteward's GoogleOAuthService, with the browser-based web
 * redirect replaced by a one-shot local HTTP listener on an ephemeral port
 * (Google's recommended native-app flow).
 */
export class OAuthService {
  constructor(private config: OAuthConfig) {}

  /**
   * Return a usable access token for the account, refreshing in place (and
   * persisting via the store) if it is expired or within the skew window.
   */
  async freshAccessToken(account: Account, store: AccountStore): Promise<string> {
    if (account.expiresAt === null || account.expiresAt - REFRESH_SKEW_MS <= Date.now()) {
      await this.refresh(account);
      store.persist();
    }
    return account.accessToken;
  }

  /**
   * Refresh an access token in place using the stored refresh token. Mutates
   * the passed account object; the caller persists.
   */
  async refresh(account: Account): Promise<void> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
    });
    if (this.config.clientSecret) {
      body.set('client_secret', this.config.clientSecret);
    }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`Token refresh failed for ${account.label}: ${await res.text()}`);
    }
    const tokens = (await res.json()) as TokenResponse;
    account.accessToken = tokens.access_token;
    account.expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  }

  /**
   * Run the full interactive loopback authorization: spin up a local listener
   * on a random 127.0.0.1 port, open the consent URL in the browser, capture
   * the returned code, exchange it for tokens, and fetch the account email.
   * Returns everything needed to persist a new Account (minus the label, which
   * the CLI collects from the user).
   *
   * @param openBrowser  Called with the authorize URL. Should open a browser;
   *                     callers that can't (headless) print it instead.
   */
  async authorizeInteractive(
    openBrowser: (url: string) => void | Promise<void>,
  ): Promise<Omit<Account, 'label' | 'isDefault'>> {
    const state = randomBytes(16).toString('hex');
    const { code, redirectUri } = await this.runLoopback(state, openBrowser);
    const tokens = await this.exchangeCode(code, redirectUri);
    const email = await this.fetchEmail(tokens.access_token);

    const refresh = tokens.refresh_token;
    if (!refresh) {
      throw new Error(
        'Google did not return a refresh_token. Revoke access at ' +
          'https://myaccount.google.com/permissions and re-run `gmail auth`.',
      );
    }

    return {
      email,
      refreshToken: refresh,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
    };
  }

  /**
   * Start a one-request HTTP server on an ephemeral loopback port, build the
   * authorize URL pointing at it, hand the URL to the opener, and resolve once
   * Google redirects back with the code. Rejects on state mismatch or an
   * error param.
   */
  private runLoopback(
    state: string,
    openBrowser: (url: string) => void | Promise<void>,
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        // Ignore favicon and any stray requests; only handle the callback.
        if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
          res.writeHead(404).end();
          return;
        }

        const respond = (message: string): void => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><meta charset="utf-8"><title>gmail-mcp</title>` +
              `<body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto">` +
              `<h1>gmail-mcp</h1><p>${message}</p>` +
              `<p>You can close this tab and return to the terminal.</p></body>`,
          );
        };

        const error = url.searchParams.get('error');
        if (error) {
          respond(`Authorization failed: ${error}. Nothing was saved.`);
          server.close();
          reject(new Error(`Authorization denied: ${error}`));
          return;
        }

        if (url.searchParams.get('state') !== state) {
          respond('State mismatch — possible CSRF. Nothing was saved.');
          server.close();
          reject(new Error('OAuth state mismatch.'));
          return;
        }

        const code = url.searchParams.get('code')!;
        respond('Authorized. ✅');
        server.close();
        resolve({ code, redirectUri });
      });

      let redirectUri = '';
      server.on('error', reject);
      // Port 0 = OS picks a free ephemeral port. Bind to loopback only.
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        redirectUri = `http://127.0.0.1:${port}`;
        const authorizeUrl = this.buildAuthorizeUrl(state, redirectUri);
        Promise.resolve(openBrowser(authorizeUrl)).catch(reject);
      });
    });
  }

  private buildAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      // Force a refresh_token on every grant — without prompt=consent, a second
      // authorization of the same account silently omits it.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (this.config.clientSecret) {
      body.set('client_secret', this.config.clientSecret);
    }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`Token exchange failed: ${await res.text()}`);
    }
    return (await res.json()) as TokenResponse;
  }

  private async fetchEmail(accessToken: string): Promise<string> {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Userinfo fetch failed: ${await res.text()}`);
    }
    const info = (await res.json()) as { email?: string };
    return info.email ?? '';
  }
}

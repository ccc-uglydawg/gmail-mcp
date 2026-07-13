import type { Account, AccountStore } from '../store.js';
import type { OAuthService } from './oauth.js';

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

export interface MessageSummary {
  id: string | null;
  thread_id: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  label_ids: string[];
}

export interface AttachmentMeta {
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
}

export interface FullMessage extends MessageSummary {
  body_text: string;
  attachments: AttachmentMeta[];
}

/**
 * Gmail REST client. Ported from Noteward's GmailConnector — same endpoints,
 * same normalization, same MIME-walk body extraction. Illuminate's Http facade
 * is replaced with global fetch; token freshness is delegated to OAuthService.
 */
export class GmailClient {
  constructor(
    private oauth: OAuthService,
    private store: AccountStore,
  ) {}

  private async token(account: Account): Promise<string> {
    return this.oauth.freshAccessToken(account, this.store);
  }

  private async get(account: Account, path: string, params?: Record<string, string | string[]>) {
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, value);
      }
    }
    return fetch(url, { headers: { Authorization: `Bearer ${await this.token(account)}` } });
  }

  /**
   * Search using Gmail's standard query syntax (from:, subject:, has:attachment,
   * newer_than:, etc). Returns lightweight summaries — the list endpoint returns
   * only IDs, so we fetch each in 'metadata' format for headers + snippet.
   */
  async search(account: Account, query: string, maxResults = 10): Promise<MessageSummary[]> {
    const list = await this.get(account, '/messages', {
      q: query,
      maxResults: String(maxResults),
    });
    if (!list.ok) {
      throw new Error(`Gmail search failed for ${account.label}: ${await list.text()}`);
    }

    const listJson = (await list.json()) as { messages?: Array<{ id: string }> };
    const ids = (listJson.messages ?? []).map((m) => m.id);
    if (ids.length === 0) {
      return [];
    }

    const summaries: MessageSummary[] = [];
    for (const id of ids) {
      const res = await this.get(account, `/messages/${id}`, {
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      if (res.ok) {
        summaries.push(this.normalizeSummary((await res.json()) as GmailMessage));
      }
    }
    return summaries;
  }

  /**
   * Fetch one message with full body + attachment metadata. Body is text/plain
   * when present, else stripped text/html. Attachment bytes are NOT downloaded
   * here — callers get {attachment_id, filename, mime, size}.
   */
  async getMessage(account: Account, messageId: string): Promise<FullMessage> {
    const res = await this.get(account, `/messages/${messageId}`, { format: 'full' });
    if (!res.ok) {
      throw new Error(`Gmail get failed for ${account.label}: ${await res.text()}`);
    }
    const payload = (await res.json()) as GmailMessage;
    return {
      ...this.normalizeSummary(payload),
      body_text: this.extractBody(payload.payload ?? {}),
      attachments: this.collectAttachments(payload.payload ?? {}),
    };
  }

  /**
   * Download the raw bytes of a single attachment. Gmail returns base64url —
   * we decode to a Buffer so callers can write straight to disk.
   */
  async getAttachment(
    account: Account,
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer> {
    const res = await this.get(account, `/messages/${messageId}/attachments/${attachmentId}`);
    if (!res.ok) {
      throw new Error(`Gmail attachment fetch failed for ${account.label}: ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: string };
    if (!json.data) {
      throw new Error(`Gmail attachment ${attachmentId} returned no data.`);
    }
    return base64UrlDecode(json.data);
  }

  /**
   * Send a plain-text message from the account. Minimal RFC 5322 composition —
   * plain text, no attachments. CC/BCC supported. Returns the sent id + thread.
   */
  async send(
    account: Account,
    to: string | string[],
    subject: string,
    body: string,
    cc?: string | string[],
    bcc?: string | string[],
  ): Promise<{ message_id: string; thread_id: string }> {
    const raw = buildRawMessage(account.email, to, subject, body, cc, bcc);
    const res = await fetch(`${BASE_URL}/messages/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token(account)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: base64UrlEncode(raw) }),
    });
    if (!res.ok) {
      throw new Error(`Gmail send failed for ${account.label}: ${await res.text()}`);
    }
    const json = (await res.json()) as { id: string; threadId: string };
    return { message_id: json.id, thread_id: json.threadId };
  }

  private normalizeSummary(message: GmailMessage): MessageSummary {
    const headers = indexHeaders(message.payload?.headers ?? []);
    return {
      id: message.id ?? null,
      thread_id: message.threadId ?? null,
      from: headers.from ?? null,
      to: headers.to ?? null,
      subject: headers.subject ?? null,
      date: headers.date ?? null,
      snippet: message.snippet ?? null,
      label_ids: message.labelIds ?? [],
    };
  }

  /** text/plain first; fall back to text/html with tags stripped. */
  private extractBody(payload: GmailPart): string {
    const plain = findPart(payload, 'text/plain');
    if (plain !== null) {
      return base64UrlDecode(plain).toString('utf8');
    }
    const html = findPart(payload, 'text/html');
    if (html !== null) {
      return stripTags(base64UrlDecode(html).toString('utf8')).trim();
    }
    return '';
  }

  /** Collect every MIME part that has both a filename and an attachmentId. */
  private collectAttachments(payload: GmailPart): AttachmentMeta[] {
    const found: AttachmentMeta[] = [];
    walkParts(payload, (part) => {
      const filename = (part.filename ?? '').trim();
      const attachmentId = part.body?.attachmentId ?? '';
      if (filename === '' || attachmentId === '') return;
      found.push({
        attachment_id: attachmentId,
        filename,
        mime: part.mimeType ?? 'application/octet-stream',
        size: part.body?.size ?? 0,
      });
    });
    return found;
  }
}

function indexHeaders(headers: GmailHeader[]): Record<string, string> {
  const indexed: Record<string, string> = {};
  for (const h of headers) {
    indexed[h.name.toLowerCase()] = h.value;
  }
  return indexed;
}

function walkParts(payload: GmailPart, visitor: (part: GmailPart) => void): void {
  visitor(payload);
  for (const part of payload.parts ?? []) {
    walkParts(part, visitor);
  }
}

function findPart(payload: GmailPart, mimeType: string): string | null {
  if (payload.mimeType === mimeType && payload.body?.data) {
    return payload.body.data;
  }
  for (const part of payload.parts ?? []) {
    const found = findPart(part, mimeType);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Build an RFC 5322 message. Plain text, single part. Subject is Q-encoded
 * (base64) when it contains non-ASCII so Unicode survives.
 */
function buildRawMessage(
  from: string,
  to: string | string[],
  subject: string,
  body: string,
  cc?: string | string[],
  bcc?: string | string[],
): string {
  const lines: string[] = [];
  lines.push(`From: ${sanitizeHeader(from)}`);
  lines.push(`To: ${joinAddresses(to)}`);
  if (cc && (Array.isArray(cc) ? cc.length : cc)) lines.push(`Cc: ${joinAddresses(cc)}`);
  if (bcc && (Array.isArray(bcc) ? bcc.length : bcc)) lines.push(`Bcc: ${joinAddresses(bcc)}`);
  // Subject is CRLF-checked before encoding; a bare ASCII subject with an
  // embedded newline would otherwise inject headers (encodeSubject only
  // Q-encodes non-ASCII). Body is intentionally NOT sanitized — it sits after
  // the header/body separator, so CRLF there is just body content.
  lines.push(`Subject: ${encodeSubject(sanitizeHeader(subject))}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(body);
  return lines.join('\r\n');
}

function joinAddresses(addresses: string | string[]): string {
  const list = Array.isArray(addresses) ? addresses : [addresses];
  return list.map(sanitizeHeader).join(', ');
}

/**
 * Reject any header-bound value containing CR or LF. Without this, a subject or
 * address like "x\r\nBcc: attacker@evil.com" would inject arbitrary headers
 * into the composed RFC 5322 message (SMTP header injection).
 */
function sanitizeHeader(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error('Header value contains illegal CR/LF characters.');
  }
  return value;
}

function encodeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  return /[^\x20-\x7e]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
    : subject;
}

/** Crude tag strip — matches the original's strip_tags() fallback for html bodies. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data, 'utf8').toString('base64url');
}

function base64UrlDecode(data: string): Buffer {
  return Buffer.from(data, 'base64url');
}

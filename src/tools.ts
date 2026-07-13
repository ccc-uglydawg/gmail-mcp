import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { downloadDir } from './config.js';

/**
 * Resolve a caller-supplied attachment path INTO the confined download dir.
 * The MCP tool exposes this to an LLM, so an absolute path or `..` traversal
 * must not be able to write outside the download directory. We take only the
 * basename of the requested path and place it under downloadDir(); if the
 * result still somehow escapes (symlink edge cases), we reject.
 */
function safeDownloadPath(requested: string): string {
  const base = resolve(downloadDir());
  mkdirSync(base, { recursive: true });
  const dest = resolve(join(base, basename(requested)));
  const rel = relative(base, dest);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('save_path escapes the download directory.');
  }
  return dest;
}

/**
 * Tool definitions shared by the MCP server. Each has a name, a description
 * written for an LLM with no other context, a Zod input schema, and a handler
 * that returns a plain JSON-serializable result. Descriptions and schemas are
 * ported from Noteward's App\Mcp\Tools\* classes.
 *
 * NOTE: gmail_send here sends DIRECTLY — there is no Signal/approval gate as in
 * Noteward. The MCP host (Claude Desktop/Code) is responsible for surfacing the
 * tool call to the user for confirmation before it runs.
 */
export interface ToolDef {
  name: string;
  description: string;
  // Raw Zod shape (object of field schemas) — the MCP SDK's registerTool takes
  // this shape directly as `inputSchema`.
  shape: z.ZodRawShape;
  handler: (ctx: AppContext, args: Record<string, unknown>) => Promise<unknown>;
}

const addressSchema = z.union([z.string(), z.array(z.string())]);

export function buildTools(): ToolDef[] {
  return [
    {
      name: 'list_accounts',
      description:
        'List the connected Google accounts and which one is the default. Use this to discover valid `label` values for the other tools.',
      shape: {},
      handler: async (ctx) => ({ accounts: ctx.store.list() }),
    },
    {
      name: 'gmail_search',
      description:
        'Search Gmail messages using Gmail\'s standard query syntax (e.g. "from:foo@bar.com subject:invoice", "in:inbox newer_than:7d", "has:attachment"). Returns lightweight summaries — call gmail_get on a returned id to fetch the full body.',
      shape: {
        query: z
          .string()
          .describe(
            'Gmail search query in standard Gmail syntax. Required. Examples: "from:boss@work.com", "subject:contract has:attachment", "in:inbox newer_than:3d".',
          ),
        label: z
          .string()
          .optional()
          .describe('Which connected Google account to search. Defaults to the default account.'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum number of messages to return. Defaults to 10, capped at 50.'),
      },
      handler: async (ctx, args) => {
        const account = ctx.store.resolve(args.label as string | undefined);
        const query = String(args.query ?? '');
        const max = Math.min(50, Math.max(1, Number(args.max_results ?? 10)));
        const messages = await ctx.gmail.search(account, query, max);
        return {
          account: { label: account.label, email: account.email },
          query,
          count: messages.length,
          messages,
        };
      },
    },
    {
      name: 'gmail_get',
      description:
        'Fetch the full body and attachment metadata of one Gmail message by id. Returns body_text (text/plain preferred, stripped text/html fallback) and an attachments array with {attachment_id, filename, mime, size}. Does NOT download attachment bytes — call gmail_get_attachment for that.',
      shape: {
        message_id: z.string().describe('Gmail message id returned by gmail_search.'),
        label: z.string().optional().describe('Which connected Google account. Defaults to the default account.'),
      },
      handler: async (ctx, args) => {
        const messageId = String(args.message_id ?? '').trim();
        if (messageId === '') throw new Error('message_id is required.');
        const account = ctx.store.resolve(args.label as string | undefined);
        const message = await ctx.gmail.getMessage(account, messageId);
        return { account: { label: account.label, email: account.email }, message };
      },
    },
    {
      name: 'gmail_get_attachment',
      description:
        'Download one attachment\'s bytes and save it into the configured download directory (GMAIL_MCP_DOWNLOAD_DIR, default ~/.gmail-mcp/downloads). Provide message_id and attachment_id (from gmail_get) and a filename. Only the filename portion of save_path is used — paths cannot escape the download directory. Returns the full path and byte size written.',
      shape: {
        message_id: z.string().describe('Gmail message id.'),
        attachment_id: z.string().describe('Attachment id from gmail_get\'s attachments array.'),
        save_path: z.string().describe('Filename for the saved attachment (e.g. "invoice.pdf"). Directory components are ignored; the file is written into the download directory.'),
        label: z.string().optional().describe('Which connected Google account. Defaults to the default account.'),
      },
      handler: async (ctx, args) => {
        const messageId = String(args.message_id ?? '').trim();
        const attachmentId = String(args.attachment_id ?? '').trim();
        const savePath = String(args.save_path ?? '').trim();
        if (!messageId || !attachmentId || !savePath) {
          throw new Error('message_id, attachment_id, and save_path are all required.');
        }
        const account = ctx.store.resolve(args.label as string | undefined);
        const bytes = await ctx.gmail.getAttachment(account, messageId, attachmentId);
        // Confine writes to the download dir — save_path is only used for its
        // filename, never as an absolute/traversal path.
        const dest = safeDownloadPath(savePath);
        writeFileSync(dest, bytes);
        return { saved: dest, bytes: bytes.length };
      },
    },
    {
      name: 'gmail_send',
      description:
        'Send a plain-text email from one of the connected Google accounts. Sends immediately — there is no built-in approval step, so confirm with the user before calling. Returns the sent message_id and thread_id.',
      shape: {
        to: addressSchema.describe('Recipient email address, or array of addresses.'),
        subject: z.string().describe('Email subject line.'),
        body: z.string().describe('Plain text email body. No HTML.'),
        cc: addressSchema.optional().describe('Optional CC recipients (string or array).'),
        bcc: addressSchema.optional().describe('Optional BCC recipients (string or array).'),
        label: z.string().optional().describe('Which connected Google account to send from. Defaults to the default account.'),
      },
      handler: async (ctx, args) => {
        const to = args.to as string | string[];
        if (!to || (Array.isArray(to) && to.length === 0)) throw new Error('to is required.');
        const subject = String(args.subject ?? '').trim();
        if (subject === '') throw new Error('subject is required.');
        const body = String(args.body ?? '');
        const account = ctx.store.resolve(args.label as string | undefined);
        const result = await ctx.gmail.send(
          account,
          to,
          subject,
          body,
          args.cc as string | string[] | undefined,
          args.bcc as string | string[] | undefined,
        );
        return { account: { label: account.label, email: account.email }, ...result };
      },
    },
    {
      name: 'calendar_search',
      description:
        'Search events on the primary Google Calendar. Optional free-text query matches title/description/location/attendees. time_min/time_max are RFC3339 timestamps. Recurring events are expanded into instances, ordered by start time.',
      shape: {
        query: z.string().optional().describe('Free-text search across event fields.'),
        time_min: z.string().optional().describe('Inclusive lower bound, RFC3339 (e.g. 2026-07-12T00:00:00Z).'),
        time_max: z.string().optional().describe('Exclusive upper bound, RFC3339.'),
        max_results: z.number().int().min(1).max(100).optional().describe('Max events. Defaults to 25.'),
        label: z.string().optional().describe('Which connected Google account. Defaults to the default account.'),
      },
      handler: async (ctx, args) => {
        const account = ctx.store.resolve(args.label as string | undefined);
        const events = await ctx.calendar.searchEvents(
          account,
          args.query as string | undefined,
          args.time_min as string | undefined,
          args.time_max as string | undefined,
          Math.min(100, Math.max(1, Number(args.max_results ?? 25))),
        );
        return { account: { label: account.label, email: account.email }, count: events.length, events };
      },
    },
    {
      name: 'calendar_add_event',
      description:
        'Create one event on the primary Google Calendar. start/end are RFC3339 datetimes. timezone is an IANA name (e.g. America/Chicago); defaults to the server timezone. Returns the created event including its id and html_link.',
      shape: {
        title: z.string().describe('Event title / summary.'),
        start: z.string().describe('Start datetime, RFC3339 (e.g. 2026-07-12T14:00:00).'),
        end: z.string().describe('End datetime, RFC3339.'),
        timezone: z.string().optional().describe('IANA timezone name. Defaults to the server timezone.'),
        description: z.string().optional().describe('Optional event description.'),
        location: z.string().optional().describe('Optional event location.'),
        label: z.string().optional().describe('Which connected Google account. Defaults to the default account.'),
      },
      handler: async (ctx, args) => {
        const account = ctx.store.resolve(args.label as string | undefined);
        const event = await ctx.calendar.createEvent(account, {
          title: String(args.title ?? ''),
          start: String(args.start ?? ''),
          end: String(args.end ?? ''),
          timezone: args.timezone as string | undefined,
          description: args.description as string | undefined,
          location: args.location as string | undefined,
        });
        return { account: { label: account.label, email: account.email }, event };
      },
    },
  ];
}

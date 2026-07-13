import type { Account, AccountStore } from '../store.js';
import type { OAuthService } from './oauth.js';

const BASE_URL = 'https://www.googleapis.com/calendar/v3';

interface GoogleEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
}

export interface NormalizedEvent {
  id: string | null;
  title: string;
  description: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
  timezone: string | null;
  html_link: string | null;
  status: string | null;
}

export interface EventInput {
  title: string;
  /** RFC3339, e.g. 2026-07-12T14:00:00 */
  start: string;
  end: string;
  timezone?: string;
  description?: string;
  location?: string;
}

/**
 * Google Calendar v3 client, primary calendar only. Ported from Noteward's
 * GoogleCalendarConnector — same normalization, same createEvent payload shape.
 */
export class CalendarClient {
  constructor(
    private oauth: OAuthService,
    private store: AccountStore,
    /** Default timezone for created events when the input omits one. */
    private defaultTimezone = 'UTC',
  ) {}

  private async token(account: Account): Promise<string> {
    return this.oauth.freshAccessToken(account, this.store);
  }

  /**
   * Search events on the primary calendar. `query` maps to Google's `q`
   * (matches title, description, location, attendees). Recurring events are
   * expanded into instances and ordered by start time.
   */
  async searchEvents(
    account: Account,
    query?: string,
    timeMin?: string,
    timeMax?: string,
    maxResults = 25,
  ): Promise<NormalizedEvent[]> {
    const url = new URL(`${BASE_URL}/calendars/primary/events`);
    url.searchParams.set('maxResults', String(maxResults));
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    if (query) url.searchParams.set('q', query);
    if (timeMin) url.searchParams.set('timeMin', timeMin);
    if (timeMax) url.searchParams.set('timeMax', timeMax);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.token(account)}` },
    });
    if (!res.ok) {
      throw new Error(`Calendar search failed for ${account.label}: ${await res.text()}`);
    }
    const json = (await res.json()) as { items?: GoogleEvent[] };
    return (json.items ?? []).map((e) => normalizeEvent(e));
  }

  /** Create one event on the primary calendar. */
  async createEvent(account: Account, event: EventInput): Promise<NormalizedEvent> {
    const tz = event.timezone ?? this.defaultTimezone;
    const payload: Record<string, unknown> = {
      summary: event.title,
      start: { dateTime: event.start, timeZone: tz },
      end: { dateTime: event.end, timeZone: tz },
    };
    if (event.description) payload.description = event.description;
    if (event.location) payload.location = event.location;

    const res = await fetch(`${BASE_URL}/calendars/primary/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token(account)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Calendar create failed for ${account.label}: ${await res.text()}`);
    }
    return normalizeEvent((await res.json()) as GoogleEvent);
  }
}

/** Flatten Google's verbose event shape to the fields a caller actually wants. */
function normalizeEvent(event: GoogleEvent): NormalizedEvent {
  return {
    id: event.id ?? null,
    title: event.summary ?? '',
    description: event.description ?? null,
    location: event.location ?? null,
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    timezone: event.start?.timeZone ?? null,
    html_link: event.htmlLink ?? null,
    status: event.status ?? null,
  };
}

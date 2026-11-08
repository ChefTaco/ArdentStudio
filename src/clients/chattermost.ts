// Optional one-way announcements through a ChatterMost incoming webhook. Posts are labelled as
// coming from Ardent Project Studio and link back; nothing is ever read back from ChatterMost.
// The webhook URL contains its secret, so it is never logged or returned.

export class ChatterMostError extends Error {
  override name = 'ChatterMostError';
}

export interface Announcement {
  /** Plain text or Markdown, kept short. */
  text: string;
  /** A link back to the Studio page this announcement is about. */
  link?: string | undefined;
}

export const ANNOUNCEMENT_USERNAME = 'Ardent Project Studio';

export class ChatterMostClient {
  private readonly request: typeof fetch;

  constructor(private readonly webhookUrl: string, fetcher?: typeof fetch) {
    this.request = fetcher ?? ((input, init) => fetch(input, init));
  }

  async announce(announcement: Announcement): Promise<void> {
    const text = `${announcement.text.trim().slice(0, 3_500)}${announcement.link ? `\n${announcement.link}` : ''}`;
    if (!text.trim()) throw new ChatterMostError('An announcement needs text');
    let response: Response;
    try {
      response = await this.request(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, username: ANNOUNCEMENT_USERNAME }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ChatterMostError(`ChatterMost webhook request failed (${error instanceof Error ? error.name : 'error'})`);
    }
    await response.body?.cancel();
    if (!response.ok) throw new ChatterMostError(`ChatterMost webhook answered HTTP ${response.status}`);
  }
}

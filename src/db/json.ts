/** JSON columns hold values this service wrote, validated when they came in. */
export function readJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  return JSON.parse(text) as T;
}

export function writeJson(value: unknown): string {
  return JSON.stringify(value);
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function iso(clock: Clock): string {
  return clock.now().toISOString();
}

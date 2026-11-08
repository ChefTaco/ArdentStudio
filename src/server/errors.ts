import type { Context } from 'hono';
import { ZodError } from 'zod';
import type { Logger } from '../logger.js';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 501 | 502 | 503, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);

/** Errors never echo request bodies, tokens or internal paths. */
export function errorResponse(c: Context, error: unknown, logger: Logger): Response {
  if (error instanceof ApiError) {
    return c.json({ error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } }, error.status);
  }
  if (error instanceof ZodError) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'The request is invalid', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
  }
  logger.error('Unhandled request error', { path: c.req.path, method: c.req.method, error: error instanceof Error ? error.name : 'unknown' });
  return c.json({ error: { code: 'INTERNAL', message: 'Internal error' } }, 500);
}

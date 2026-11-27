// The Emberpath client key New Agent and Create agent from definition relay to Magnus (Magnus #164). It is
// write-only: Studio passes it on in one request and never stores, logs, audits, fingerprints or returns it.
import { ApiError } from './errors.js';

/**
 * Magnus's Emberpath client key refusals, passed on with their codes: 400 EMBERPATH_KEY_REQUIRED, 409
 * EMBERPATH_NOT_EXPLICIT, 422 EMBERPATH_KEY_INVALID, EMBERPATH_KEY_FORBIDDEN and EMBERPATH_ALIAS_UNAVAILABLE, and
 * 503 EMBERPATH_UNAVAILABLE. Undefined for any other answer.
 */
export function emberpathRefusal(error: { status: number; code: string; message: string }): ApiError | undefined {
  if (!error.code.startsWith('EMBERPATH_')) return undefined;
  if (error.status === 400 || error.status === 409 || error.status === 422 || error.status === 503) return new ApiError(error.status, error.code, error.message);
  return undefined;
}

/** Drop the key from the parsed request once Magnus has had it, so nothing later in the request can reach it. */
export function forgetEmberpathKey(input: { emberpath_client_key?: string | undefined }): void {
  delete input.emberpath_client_key;
}

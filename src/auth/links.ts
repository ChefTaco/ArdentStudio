import { z } from 'zod';
import { ARDENT_STUDIO_PERMISSIONS, permissionSchema, type ArdentStudioPermission } from '../shared/browser.js';

export class IdentityLinkError extends Error {
  override name = 'IdentityLinkError';
}

const linkSchema = z.object({
  issuer: z.url(),
  subject: z.string().min(1).max(256),
  /** The Studio user this person acts as; recorded on every record and audit row. */
  localUserId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/)
    .refine(value => value !== 'system' && !value.startsWith('service:'), 'localUserId must not name the system or a service actor'),
  displayName: z.string().trim().min(1).max(120).optional(),
  /** A ceiling: the token's permissions grant only within it. Absent means every Studio permission. */
  permissions: z.array(permissionSchema).max(ARDENT_STUDIO_PERMISSIONS.length).optional(),
}).strict();

export type IdentityLink = z.infer<typeof linkSchema>;

/** Parse ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON. Throws on anything malformed or ambiguous. */
export function parseIdentityLinks(raw: string): IdentityLink[] {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new IdentityLinkError('must be valid JSON'); }
  const parsed = z.array(linkSchema).max(10_000).safeParse(json);
  if (!parsed.success) throw new IdentityLinkError('must be a JSON array of {issuer, subject, localUserId, displayName?, permissions?}');
  const seen = new Set<string>();
  for (const link of parsed.data) {
    const key = JSON.stringify([link.issuer, link.subject]);
    if (seen.has(key)) throw new IdentityLinkError('links must be unique per issuer and subject');
    seen.add(key);
  }
  return parsed.data;
}

/** The one link for a verified person, or undefined when there is none or the links are ambiguous. */
export function linkFor(links: readonly IdentityLink[], issuer: string, subject: string): IdentityLink | undefined {
  const matches = links.filter(link => link.issuer === issuer && link.subject === subject);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Token permissions narrowed by the link's ceiling. Unknown permission strings are dropped. */
export function effectivePermissions(link: IdentityLink, tokenPermissions: readonly string[]): ArdentStudioPermission[] {
  const ceiling = new Set<string>(link.permissions ?? ARDENT_STUDIO_PERMISSIONS);
  return ARDENT_STUDIO_PERMISSIONS.filter(permission => ceiling.has(permission) && tokenPermissions.includes(permission));
}

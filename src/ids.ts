import { randomBytes } from 'node:crypto';

// Crockford base32, as used by ULID.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Record prefixes. Ardent and Magnus identifiers are stored as references and never minted here. */
export const ID_PREFIXES = {
  project: 'prj',
  deliverableRequest: 'req',
  file: 'fil',
  template: 'tpl',
  binding: 'bnd',
  teamRevision: 'trv',
  conversation: 'cnv',
  message: 'msg',
  decision: 'dec',
  task: 'tsk',
  deliverable: 'dlv',
  deliverableRevision: 'drv',
  comment: 'cmt',
  reviewDecision: 'rvd',
  export: 'exp',
  draft: 'drf',
  developmentComment: 'dvc',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

let lastTime = -1;
let lastRandom = new Uint8Array(10);

function encodeTime(time: number): string {
  let value = time;
  let out = '';
  for (let index = 0; index < 10; index++) {
    out = ALPHABET[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits -> 16 base32 characters.
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/** A monotonic ULID: ids minted in the same millisecond still sort in creation order. */
export function ulid(now = Date.now()): string {
  if (now === lastTime) {
    const next = Uint8Array.from(lastRandom);
    for (let index = next.length - 1; index >= 0; index--) {
      if (next[index]! < 255) { next[index]! += 1; break; }
      next[index] = 0;
      if (index === 0) throw new Error('ULID random component overflowed within one millisecond');
    }
    lastRandom = next;
  } else {
    lastTime = now;
    lastRandom = new Uint8Array(randomBytes(10));
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

const ID_PATTERN = /^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Whether a value is a well-formed id of the given kind. */
export function isId(kind: IdKind, value: string): boolean {
  return ID_PATTERN.test(value) && value.startsWith(`${ID_PREFIXES[kind]}_`);
}

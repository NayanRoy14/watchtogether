/** Room codes: 6 characters, no look-alikes (0/O, 1/I/L), shown as K7M-2QX. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;

export function generateCode(): string {
  // Rejection sampling keeps the distribution uniform over the 31-char alphabet.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2));
    for (const b of bytes) {
      if (b < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

/** Accepts "k7m-2qx", "K7M 2QX", "K7M2QX"; returns the canonical form or null. */
export function normalizeCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function formatCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

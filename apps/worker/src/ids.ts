/**
 * Members are identified to each other by a hash of their private clientId,
 * so nobody can copy another member's id out of the member list and rejoin as them.
 */
export async function publicId(clientId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientId));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

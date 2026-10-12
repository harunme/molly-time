import { sha256 } from '@noble/hashes/sha2.js';

// WebCrypto is unavailable on public HTTP origins. Both paths produce the same
// SHA-256 so fingerprints, resume checks and server chunk validation still agree.
export async function sha256Blob(blob: Blob): Promise<string> {
  const data = await blob.arrayBuffer();
  const subtle = globalThis.crypto?.subtle;
  const hash = subtle
    ? new Uint8Array(await subtle.digest('SHA-256', data))
    : sha256(new Uint8Array(data));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

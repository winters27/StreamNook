// End-to-end-ish encryption for mod rooms. The per-channel AES-GCM key is derived
// server-side from a master secret and handed ONLY to verified moderators in the
// token response (non-mods never get a token, so never get the key). Messages are
// encrypted on-device before they hit the WebSocket, so the Durable Object only
// ever stores ciphertext. There is no passphrase: being a mod is what grants the
// key, automatically.

const ENC_PREFIX = 'snenc1:';

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True if a message body is an encrypted token (vs legacy plaintext). */
export function isEncrypted(body: string): boolean {
  return body.startsWith(ENC_PREFIX);
}

/** Import the base64 room key (from the gate's token response) as an AES-GCM key. */
export async function importRoomKey(base64: string): Promise<CryptoKey> {
  const raw = fromB64(base64);
  return crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptText(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return ENC_PREFIX + toB64(packed);
}

/** Encrypt raw bytes (image attachments) with the room key. iv is prefixed. */
export async function encryptBytes(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return packed;
}

/** Decrypt bytes produced by encryptBytes. Returns null on the wrong key. */
export async function decryptBytes(key: CryptoKey, packed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
  } catch {
    return null;
  }
}

/** Decrypt a token. Returns null on the wrong key or a malformed token. */
export async function decryptText(key: CryptoKey, token: string): Promise<string | null> {
  try {
    const packed = fromB64(token.slice(ENC_PREFIX.length));
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return dec.decode(pt);
  } catch {
    return null;
  }
}

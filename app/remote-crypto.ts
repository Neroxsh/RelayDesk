const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64url(bytes: ArrayBuffer | Uint8Array) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createPhoneKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    pair,
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

export async function deriveSessionKey(privateJwk: JsonWebKey, publicJwk: JsonWebKey, codeHash: string) {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const source = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: Uint8Array.from(codeHash.match(/.{2}/g) ?? [], (hex) => Number.parseInt(hex, 16)),
      info: encoder.encode("relaydesk-e2ee-v1"),
    },
    source,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportSessionKey(key: CryptoKey) {
  return toBase64url(await crypto.subtle.exportKey("raw", key));
}

export async function importSessionKey(value: string) {
  return crypto.subtle.importKey("raw", fromBase64url(value), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(key: CryptoKey, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(value)));
  return { v: 1, iv: toBase64url(iv), ciphertext: toBase64url(ciphertext) };
}

export async function decryptJson(key: CryptoKey, envelope: { v: number; iv: string; ciphertext: string }): Promise<unknown> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(envelope.iv) },
    key,
    fromBase64url(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as unknown;
}

export function requestId() {
  return toBase64url(crypto.getRandomValues(new Uint8Array(9)));
}

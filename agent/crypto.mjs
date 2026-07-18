import { createHash, randomBytes, webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64url(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function generateDeviceKeys() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    publicKey: await subtle.exportKey("jwk", pair.publicKey),
    privateKey: await subtle.exportKey("jwk", pair.privateKey),
  };
}

export async function deriveSessionKey(privateJwk, publicJwk, codeHash) {
  const privateKey = await subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const publicKey = await subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: Buffer.from(codeHash, "hex"),
      info: encoder.encode("relaydesk-e2ee-v1"),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptJson(key, value) {
  const iv = randomBytes(12);
  const plaintext = encoder.encode(JSON.stringify(value));
  const encrypted = await subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { v: 1, iv: base64url(iv), ciphertext: base64url(new Uint8Array(encrypted)) };
}

export async function decryptJson(key, envelope) {
  if (!envelope || envelope.v !== 1 || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("Invalid encrypted envelope");
  }
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(envelope.iv) },
    key,
    fromBase64url(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext));
}

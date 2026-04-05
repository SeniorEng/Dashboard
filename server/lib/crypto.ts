import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = "enc:";
const MIN_PAYLOAD_LENGTH = IV_LENGTH + TAG_LENGTH;
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

let encryptionKey: Buffer | null = null;

function getKey(): Buffer {
  if (encryptionKey) return encryptionKey;
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error("ENCRYPTION_KEY Umgebungsvariable nicht gesetzt. Generieren Sie einen 64-stelligen Hex-String (32 Bytes).");
  }
  if (!HEX_KEY_PATTERN.test(keyHex)) {
    throw new Error("ENCRYPTION_KEY muss ein 64-stelliger Hex-String sein (32 Bytes für AES-256).");
  }
  encryptionKey = Buffer.from(keyHex, "hex");
  return encryptionKey;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext || plaintext.startsWith(PREFIX)) return plaintext;
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, encrypted]);
  return PREFIX + combined.toString("base64");
}

export function decryptSecret(ciphertext: string): string {
  if (!ciphertext || !ciphertext.startsWith(PREFIX)) return ciphertext;
  try {
    const key = getKey();
    const combined = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
    if (combined.length < MIN_PAYLOAD_LENGTH) {
      console.error("[crypto] Ungültiger verschlüsselter Wert: zu kurz");
      return "";
    }
    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final("utf8");
  } catch (err) {
    console.error("[crypto] Entschlüsselung fehlgeschlagen:", err instanceof Error ? err.message : err);
    return "";
  }
}

export function isEncrypted(value: string | null | undefined): boolean {
  return !!value && value.startsWith(PREFIX);
}

export function isEncryptionConfigured(): boolean {
  return !!process.env.ENCRYPTION_KEY;
}

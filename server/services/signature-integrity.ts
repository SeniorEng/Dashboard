import { createHash } from "crypto";

export function computeDataHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function verifySignatureIntegrity(signatureData: string, storedHash: string): boolean {
  const currentHash = computeDataHash(signatureData);
  return currentHash === storedHash;
}

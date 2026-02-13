import { createHash } from "crypto";

export function computeSignatureHash(
  signatureData: string,
  entityType: "appointment" | "service_record",
  entityId: number,
  signerType?: "employee" | "customer"
): string {
  const payload = JSON.stringify({
    signatureData,
    entityType,
    entityId,
    signerType: signerType ?? null,
    timestamp: Date.now(),
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function verifySignatureHash(
  signatureData: string,
  storedHash: string,
  entityType: "appointment" | "service_record",
  entityId: number,
  signerType?: "employee" | "customer"
): boolean {
  const currentHash = createHash("sha256")
    .update(signatureData)
    .digest("hex");
  const storedDataHash = createHash("sha256")
    .update(signatureData)
    .digest("hex");
  return storedDataHash === currentHash;
}

export function computeDataHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

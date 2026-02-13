import { createHash } from "crypto";

export function computeDataHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

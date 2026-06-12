const RING_SIZE = 100;

export interface PdfCacheSendEvent {
  invoiceId: number;
  cachedInvoice: boolean;
  cachedLn: boolean;
  isCustomerInvoice: boolean;
  durationMs: number;
  at: number;
}

const ring: PdfCacheSendEvent[] = [];
let cursor = 0;

export function recordPdfCacheSend(event: PdfCacheSendEvent): void {
  if (ring.length < RING_SIZE) {
    ring.push(event);
  } else {
    ring[cursor] = event;
    cursor = (cursor + 1) % RING_SIZE;
  }
}

export interface PdfCacheStatsSnapshot {
  windowSize: number;
  totalSends: number;
  invoiceCacheHits: number;
  invoiceCacheMisses: number;
  invoiceCacheHitRate: number | null;
  leistungsnachweisCacheHits: number;
  leistungsnachweisCacheMisses: number;
  leistungsnachweisCacheHitRate: number | null;
  bothCachedHits: number;
  bothCachedHitRate: number | null;
  avgDurationMs: number | null;
  lastEventAt: string | null;
}

export function getPdfCacheStatsSnapshot(): PdfCacheStatsSnapshot {
  const total = ring.length;
  if (total === 0) {
    return {
      windowSize: RING_SIZE,
      totalSends: 0,
      invoiceCacheHits: 0,
      invoiceCacheMisses: 0,
      invoiceCacheHitRate: null,
      leistungsnachweisCacheHits: 0,
      leistungsnachweisCacheMisses: 0,
      leistungsnachweisCacheHitRate: null,
      bothCachedHits: 0,
      bothCachedHitRate: null,
      avgDurationMs: null,
      lastEventAt: null,
    };
  }
  let invHits = 0;
  let lnHits = 0;
  let bothHits = 0;
  let invEligible = 0;
  let durationSum = 0;
  let lastAt = 0;
  for (const e of ring) {
    if (!e.isCustomerInvoice) {
      invEligible += 1;
      if (e.cachedInvoice) invHits += 1;
    }
    if (e.cachedLn) lnHits += 1;
    if (e.cachedLn && (e.isCustomerInvoice || e.cachedInvoice)) bothHits += 1;
    durationSum += e.durationMs;
    if (e.at > lastAt) lastAt = e.at;
  }
  return {
    windowSize: RING_SIZE,
    totalSends: total,
    invoiceCacheHits: invHits,
    invoiceCacheMisses: invEligible - invHits,
    invoiceCacheHitRate: invEligible > 0 ? invHits / invEligible : null,
    leistungsnachweisCacheHits: lnHits,
    leistungsnachweisCacheMisses: total - lnHits,
    leistungsnachweisCacheHitRate: lnHits / total,
    bothCachedHits: bothHits,
    bothCachedHitRate: bothHits / total,
    avgDurationMs: durationSum / total,
    lastEventAt: lastAt > 0 ? new Date(lastAt).toISOString() : null,
  };
}

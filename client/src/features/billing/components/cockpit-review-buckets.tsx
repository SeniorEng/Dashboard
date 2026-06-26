import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, FileCheck, Receipt, Clock } from "lucide-react";
import { iconSize } from "@/design-system";
import type { CockpitReviewBuckets } from "@shared/api";
import { formatAmount, formatDate, formatSentAt } from "../utils";

interface CockpitReviewBucketsProps {
  buckets: CockpitReviewBuckets;
}

// Task #1444 — Zone C: vier READ-ONLY „Zu prüfen"-Buckets. Reine Anzeige der
// vom Reader gelieferten Listen; keine Aktionen (Phase 2). Termin-Zeilen
// verlinken auf das Termin-Detail.
export function CockpitReviewBuckets({ buckets }: CockpitReviewBucketsProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="section-cockpit-review">
      {/* Überfällige Doku */}
      <Card data-testid="card-bucket-overdue-doc">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <AlertTriangle className={`${iconSize.sm} text-red-600`} />
            Überfällige Doku
            <span className="ml-auto tabular-nums text-gray-500" data-testid="text-bucket-overdue-doc-count">
              {buckets.ueberfaelligeDoku.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {buckets.ueberfaelligeDoku.length === 0 ? (
            <p className="text-sm text-gray-500">Keine überfälligen Dokumentationen.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {buckets.ueberfaelligeDoku.map((item) => (
                <li key={item.appointmentId} data-testid={`row-overdue-doc-${item.appointmentId}`}>
                  <Link
                    href={`/appointment/${item.appointmentId}`}
                    className="flex items-center justify-between gap-3 py-2 text-sm hover:bg-gray-50"
                  >
                    <span className="min-w-0 truncate">
                      <span className="text-gray-900">{item.customerName}</span>
                      <span className="ml-2 text-gray-500">{formatDate(item.date.slice(0, 10))}</span>
                      {item.employeeName && (
                        <span className="ml-2 text-gray-400">· {item.employeeName}</span>
                      )}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums text-red-600">
                      {item.daysOverdue} T
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* LN-Prüfung */}
      <Card data-testid="card-bucket-ln-review">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileCheck className={`${iconSize.sm} text-amber-600`} />
            LN-Prüfung
            <span className="ml-auto tabular-nums text-gray-500" data-testid="text-bucket-ln-review-count">
              {buckets.lnPruefung.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {buckets.lnPruefung.length === 0 ? (
            <p className="text-sm text-gray-500">Keine ausstehenden Prüfungen.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {buckets.lnPruefung.map((item) => (
                <li
                  key={item.proofId}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                  data-testid={`row-ln-review-${item.proofId}`}
                >
                  <span className="min-w-0 truncate">
                    <span className="text-gray-900">{item.employeeName}</span>
                    {item.documentTypeName && (
                      <span className="ml-2 text-gray-500">{item.documentTypeName}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-gray-400 tabular-nums">
                    {formatSentAt(item.uploadedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Abrechnungs-Prüfung */}
      <Card data-testid="card-bucket-billing-review">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Receipt className={`${iconSize.sm} text-teal-600`} />
            Abrechnungs-Prüfung
            <span className="ml-auto tabular-nums text-gray-500" data-testid="text-bucket-billing-review-count">
              {buckets.abrechnungsPruefung.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {buckets.abrechnungsPruefung.length === 0 ? (
            <p className="text-sm text-gray-500">Keine abzurechnenden Kunden.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {buckets.abrechnungsPruefung.map((item) => (
                <li
                  key={item.customerId}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                  data-testid={`row-billing-review-${item.customerId}`}
                >
                  <span className="min-w-0 truncate">
                    <span className="text-gray-900">{item.customerName}</span>
                    <span className="ml-2 text-gray-500">({item.itemCount})</span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums text-gray-900">
                    {formatAmount(item.totalCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Zahlungsverzug */}
      <Card data-testid="card-bucket-overdue-invoice">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Clock className={`${iconSize.sm} text-red-600`} />
            Zahlungsverzug
            <span className="ml-auto tabular-nums text-gray-500" data-testid="text-bucket-overdue-invoice-count">
              {buckets.zahlungsverzug.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {buckets.zahlungsverzug.length === 0 ? (
            <p className="text-sm text-gray-500">Keine überfälligen Rechnungen.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {buckets.zahlungsverzug.map((item) => (
                <li
                  key={item.invoiceId}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                  data-testid={`row-overdue-invoice-${item.invoiceId}`}
                >
                  <span className="min-w-0 truncate">
                    <span className="text-gray-900">{item.customerName}</span>
                    <span className="ml-2 text-gray-500">{item.invoiceNumber}</span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums text-red-600">
                    {formatAmount(item.totalCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

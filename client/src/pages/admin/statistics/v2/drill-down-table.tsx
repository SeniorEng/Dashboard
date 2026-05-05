import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronRight, Search, Download } from "lucide-react";
import { exportToCsv, type CsvColumn } from "../helpers";

export interface DrillDownColumn<T> {
  key: string;
  label: string;
  /** Returns the cell value to display (string for tables; number is auto-stringified). */
  render: (row: T) => string | number | null;
  /** Sort key extractor; defaults to render(). */
  sortBy?: (row: T) => string | number;
  /** CSV-only value extractor; defaults to render(). Useful for raw numbers. */
  csvValue?: (row: T) => string | number | null | undefined;
  className?: string;
  hideOnMobile?: boolean;
  /** Right-align numeric cells. */
  align?: "left" | "right";
}

interface DrillDownTableProps<T> {
  rows: T[];
  columns: DrillDownColumn<T>[];
  /** Stable row id used as React key and in test ids. */
  getRowId: (row: T) => string | number;
  /** Optional row link (renders chevron + makes mobile card clickable). */
  getRowLink?: (row: T) => string | null | undefined;
  pageSize?: number;
  emptyMessage?: string;
  testId: string;
  /** When set, renders a "CSV exportieren" button. */
  csvFilename?: string;
}

export function DrillDownTable<T>({
  rows,
  columns,
  getRowId,
  getRowLink,
  pageSize = 50,
  emptyMessage = "Keine Daten vorhanden.",
  testId,
  csvFilename,
}: DrillDownTableProps<T>) {
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      columns.some((c) => {
        const v = c.render(r);
        return v != null && String(v).toLowerCase().includes(q);
      })
    );
  }, [rows, filter, columns]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return filtered;
    const extractor = col.sortBy ?? ((r: T) => col.render(r) ?? "");
    const arr = [...filtered];
    arr.sort((a, b) => {
      const va = extractor(a);
      const vb = extractor(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return va - vb;
      return String(va).localeCompare(String(vb), "de");
    });
    if (sortDir === "desc") arr.reverse();
    return arr;
  }, [filtered, sortKey, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(0);
  }

  function handleExport() {
    if (!csvFilename) return;
    const csvCols: CsvColumn<T>[] = columns.map((c) => ({
      label: c.label,
      value: c.csvValue ?? ((r) => c.render(r)),
    }));
    exportToCsv(csvFilename, csvCols, sorted);
  }

  return (
    <div className="space-y-3" data-testid={testId}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground pointer-events-none" />
          <Input
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setPage(0); }}
            placeholder="Suchen…"
            className="pl-8"
            data-testid={`${testId}-filter`}
          />
        </div>
        <span className="text-xs text-muted-foreground" data-testid={`${testId}-count`}>
          {sorted.length} {sorted.length === 1 ? "Eintrag" : "Einträge"}
        </span>
        {csvFilename && sorted.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-8 text-xs"
            onClick={handleExport}
            data-testid={`${testId}-export-csv`}
          >
            <Download className="w-3.5 h-3.5 mr-1" />
            CSV exportieren
          </Button>
        )}
      </div>

      {pageRows.length === 0 ? (
        <Card data-testid={`${testId}-empty`}>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {filter ? "Keine Treffer für den Filter." : emptyMessage}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="hidden md:block rounded-md border overflow-hidden bg-white">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className={`font-medium text-muted-foreground px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"} ${c.hideOnMobile ? "hidden lg:table-cell" : ""}`}
                    >
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={() => toggleSort(c.key)}
                        data-testid={`${testId}-sort-${c.key}`}
                      >
                        {c.label}
                        {sortKey === c.key ? (
                          sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronsUpDown className="w-3 h-3 opacity-40" />
                        )}
                      </button>
                    </th>
                  ))}
                  {getRowLink && <th className="px-3 py-2 w-10" />}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const id = getRowId(row);
                  const link = getRowLink?.(row);
                  return (
                    <tr
                      key={id}
                      className="border-t hover:bg-muted/20 transition-colors"
                      data-testid={`${testId}-row-${id}`}
                    >
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={`px-3 py-2 ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.className ?? ""} ${c.hideOnMobile ? "hidden lg:table-cell" : ""}`}
                        >
                          {c.render(row) ?? <span className="text-muted-foreground">—</span>}
                        </td>
                      ))}
                      {getRowLink && (
                        <td className="px-3 py-2 text-right">
                          {link && (
                            <Link href={link} data-testid={`${testId}-row-${id}-link`}>
                              <Button variant="ghost" size="sm" className="h-7 px-2">
                                <ChevronRight className="w-4 h-4" />
                              </Button>
                            </Link>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="md:hidden space-y-2">
            {pageRows.map((row) => {
              const id = getRowId(row);
              const link = getRowLink?.(row);
              const firstCol = columns[0];
              const restCols = columns.slice(1);
              const inner = (
                <Card className="hover:shadow-sm transition-shadow">
                  <CardContent className="p-3 flex items-start gap-2">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="font-medium text-sm truncate">{firstCol.render(row) ?? "—"}</div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        {restCols.map((c) => {
                          const v = c.render(row);
                          if (v == null || v === "") return null;
                          return (
                            <span key={c.key}>
                              <span className="text-muted-foreground/70">{c.label}:</span> {v}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    {link && <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />}
                  </CardContent>
                </Card>
              );
              return link ? (
                <Link key={id} href={link} data-testid={`${testId}-card-${id}`} className="block">
                  {inner}
                </Link>
              ) : (
                <div key={id} data-testid={`${testId}-card-${id}`}>{inner}</div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-muted-foreground" data-testid={`${testId}-pagination-info`}>
                Seite {safePage + 1} von {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(0, safePage - 1))}
                  disabled={safePage === 0}
                  data-testid={`${testId}-prev-page`}
                >
                  Zurück
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
                  disabled={safePage >= totalPages - 1}
                  data-testid={`${testId}-next-page`}
                >
                  Weiter
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

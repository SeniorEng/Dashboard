import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronRight, Search } from "lucide-react";
import type { ProcessHealthRow } from "@shared/statistics";

export interface DrillDownColumn {
  key: keyof ProcessHealthRow | string;
  label: string;
  /** Returns the cell value to display. */
  render: (row: ProcessHealthRow) => string | null;
  /** Sort key extractor; defaults to render(). */
  sortBy?: (row: ProcessHealthRow) => string | number;
  className?: string;
  hideOnMobile?: boolean;
}

interface DrillDownTableProps {
  rows: ProcessHealthRow[];
  columns: DrillDownColumn[];
  pageSize?: number;
  emptyMessage?: string;
  testId: string;
}

export function DrillDownTable({
  rows,
  columns,
  pageSize = 50,
  emptyMessage = "Alles sauber — keine offenen Punkte.",
  testId,
}: DrillDownTableProps) {
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
    const col = columns.find((c) => String(c.key) === sortKey);
    if (!col) return filtered;
    const extractor = col.sortBy ?? ((r: ProcessHealthRow) => col.render(r) ?? "");
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
      </div>

      {pageRows.length === 0 ? (
        <Card data-testid={`${testId}-empty`}>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {filter ? "Keine Treffer für den Filter." : emptyMessage}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="hidden md:block rounded-md border overflow-hidden bg-white">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr>
                  {columns.map((c) => (
                    <th
                      key={String(c.key)}
                      className={`text-left font-medium text-muted-foreground px-3 py-2 ${c.hideOnMobile ? "hidden lg:table-cell" : ""}`}
                    >
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={() => toggleSort(String(c.key))}
                        data-testid={`${testId}-sort-${c.key}`}
                      >
                        {c.label}
                        {sortKey === String(c.key) ? (
                          sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronsUpDown className="w-3 h-3 opacity-40" />
                        )}
                      </button>
                    </th>
                  ))}
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t hover:bg-muted/20 transition-colors"
                    data-testid={`${testId}-row-${row.id}`}
                  >
                    {columns.map((c) => (
                      <td
                        key={String(c.key)}
                        className={`px-3 py-2 ${c.className ?? ""} ${c.hideOnMobile ? "hidden lg:table-cell" : ""}`}
                      >
                        {c.render(row) ?? <span className="text-muted-foreground">—</span>}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right">
                      {row.link && (
                        <Link href={row.link} data-testid={`${testId}-row-${row.id}-link`}>
                          <Button variant="ghost" size="sm" className="h-7 px-2">
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="md:hidden space-y-2">
            {pageRows.map((row) => (
              <Link
                key={row.id}
                href={row.link ?? "#"}
                data-testid={`${testId}-card-${row.id}`}
                className="block"
              >
                <Card className="hover:shadow-sm transition-shadow">
                  <CardContent className="p-3 flex items-start gap-2">
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="font-medium text-sm truncate">{row.label}</div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        {columns.slice(1).map((c) => {
                          const v = c.render(row);
                          if (!v) return null;
                          return (
                            <span key={String(c.key)}>
                              <span className="text-muted-foreground/70">{c.label}:</span> {v}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  </CardContent>
                </Card>
              </Link>
            ))}
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

import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { iconSize, componentStyles } from "@/design-system";
import { ArrowRight, FileText, Loader2 } from "lucide-react";
import { Link } from "wouter";

interface Props {
  existingServiceRecord: { id: number; status: string } | null | undefined;
  onCreate: () => void;
  isCreating: boolean;
}

export function AppointmentServiceRecordCard({ existingServiceRecord, onCreate, isCreating }: Props) {
  return (
    <SectionCard
      title="Leistungsnachweis"
      icon={<FileText className={iconSize.sm} />}
      className="mb-4"
    >
      {existingServiceRecord ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <StatusBadge
            type="record"
            value={existingServiceRecord.status}
            data-testid="badge-service-record-status"
          />
          <Link
            href={`/service-records/${existingServiceRecord.id}`}
            data-testid="link-service-record"
            className="w-full sm:w-auto"
          >
            <Button variant="outline" size="sm" className="w-full sm:w-auto whitespace-normal text-left">
              {existingServiceRecord.status === "pending" ? "Leistungsnachweis unterschreiben" : "Leistungsnachweis anzeigen"}
              <ArrowRight className={`${iconSize.sm} ml-1`} />
            </Button>
          </Link>
        </div>
      ) : (
        <Button
          className={`w-full ${componentStyles.btnPrimary}`}
          onClick={onCreate}
          disabled={isCreating}
          data-testid="button-create-service-record"
        >
          {isCreating && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          <FileText className={`${iconSize.sm} mr-2`} />
          Leistungsnachweis erstellen
        </Button>
      )}
    </SectionCard>
  );
}

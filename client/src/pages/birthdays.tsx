import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Cake, Loader2, Gift } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { formatDateForDisplay } from "@shared/utils/date";
import { iconSize } from "@/design-system";
import { EmptyState } from "@/components/patterns/empty-state";
import { ErrorState } from "@/components/patterns/error-state";

interface BirthdayEntry {
  id: number;
  type: "employee" | "customer";
  name: string;
  geburtsdatum: string;
  daysUntil: number;
  age: number;
}

function getDaysLabel(days: number): string {
  if (days === 0) return "Heute";
  if (days === 1) return "Morgen";
  return `In ${days} Tagen`;
}

function getGroupLabel(days: number): string {
  if (days === 0) return "Heute";
  if (days <= 7) return "Diese Woche";
  if (days <= 14) return "Nächste Woche";
  return "Später";
}

function groupBirthdays(birthdays: BirthdayEntry[]): Record<string, BirthdayEntry[]> {
  const groups: Record<string, BirthdayEntry[]> = {
    "Heute": [],
    "Diese Woche": [],
    "Nächste Woche": [],
    "Später": [],
  };

  for (const birthday of birthdays) {
    const group = getGroupLabel(birthday.daysUntil);
    groups[group].push(birthday);
  }

  return groups;
}

export default function BirthdaysPage() {
  const { user } = useAuth();
  
  const { data: birthdays = [], isLoading, error, refetch } = useQuery<BirthdayEntry[]>({
    queryKey: ["/api/birthdays"],
  });

  const groups = groupBirthdays(birthdays);
  const hasAnyBirthdays = birthdays.length > 0;

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <ErrorState
            title="Geburtstage konnten nicht geladen werden"
            description={error instanceof Error ? error.message : "Bitte versuchen Sie es erneut."}
            onRetry={() => refetch()}
          />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-1">
          <Cake className={`${iconSize.lg} text-primary`} />
          <h1 className="text-2xl font-bold text-foreground tracking-tight" data-testid="text-birthdays-title">
            Geburtstage
          </h1>
        </div>
        <p className="text-muted-foreground text-sm ml-10" data-testid="text-birthdays-subtitle">
          {user?.isAdmin 
            ? "Alle Geburtstage der nächsten 30 Tage"
            : "Geburtstage meiner Kunden in den nächsten 30 Tagen"
          }
        </p>
      </div>

      {!hasAnyBirthdays ? (
        <Card className="border-dashed">
          <CardContent className="py-10">
            <EmptyState
              icon={<Gift className={`${iconSize["2xl"]} text-muted-foreground/40`} />}
              title="Keine Geburtstage in den nächsten 30 Tagen"
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {Object.entries(groups).map(([groupName, groupBirthdays]) => {
            if (groupBirthdays.length === 0) return null;
            
            return (
              <div key={groupName}>
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                  {groupName === "Heute" && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                  {groupName}
                  <Badge variant="secondary" className="text-xs">
                    {groupBirthdays.length}
                  </Badge>
                </h2>
                
                <div className="flex flex-col gap-3">
                  {groupBirthdays.map((birthday) => (
                    <BirthdayCard key={`${birthday.type}-${birthday.id}`} birthday={birthday} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Layout>
  );
}

function BirthdayCard({ birthday }: { birthday: BirthdayEntry }) {
  const isToday = birthday.daysUntil === 0;
  const isSoon = birthday.daysUntil <= 3;
  
  const content = (
    <Card 
      className={`overflow-hidden ${
        isToday 
          ? "border-green-300 bg-green-50/50 shadow-md" 
          : isSoon 
            ? "border-amber-200 bg-amber-50/30" 
            : ""
      }`}
      data-testid={`card-birthday-${birthday.type}-${birthday.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="font-semibold text-foreground truncate" data-testid={`text-birthday-name-${birthday.type}-${birthday.id}`}>
                {birthday.name}
              </h3>
              {isToday && (
                <span className="text-lg" role="img" aria-label="Geburtstag">🎂</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge 
                variant="outline" 
                className={`text-xs ${birthday.type === "employee" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-primary/10 text-primary border-primary/20"}`}
              >
                {birthday.type === "employee" ? "Mitarbeiter" : "Kunde"}
              </Badge>
              <span className="text-muted-foreground/50">•</span>
              <span data-testid={`text-birthday-date-${birthday.type}-${birthday.id}`}>
                {formatDateForDisplay(birthday.geburtsdatum, { day: "numeric", month: "long" })}
              </span>
              <span className="text-muted-foreground/50">•</span>
              <span>wird {birthday.age}</span>
            </div>
          </div>
          
          <Badge 
            variant={isToday ? "default" : isSoon ? "secondary" : "outline"}
            className={`shrink-0 ${isToday ? "bg-green-600" : ""}`}
            data-testid={`badge-birthday-days-${birthday.type}-${birthday.id}`}
          >
            {getDaysLabel(birthday.daysUntil)}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );

  if (birthday.type === "customer") {
    return (
      <Link href={`/customer/${birthday.id}`}>
        {content}
      </Link>
    );
  }

  return content;
}

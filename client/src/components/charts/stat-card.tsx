import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon?: React.ReactNode;
  color?: string;
  testId: string;
}

export function StatCard({ label, value, sub, icon, color = "text-teal-600", testId }: StatCardProps) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          {icon && <div className={`${color}`}>{icon}</div>}
          <div className="min-w-0">
            <div className={`text-xl font-bold ${color}`} data-testid={`${testId}-value`}>{value}</div>
            <div className="text-xs text-muted-foreground truncate">{label}</div>
            {sub && <div className="text-xs text-muted-foreground/70">{sub}</div>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

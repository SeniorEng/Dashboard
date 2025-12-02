import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MapPin, ChevronRight, CheckCircle2, PlayCircle, FileText, User } from "lucide-react";
import { Link } from "wouter";

type Appointment = {
  id: number;
  customerId: number;
  type: string;
  date: string;
  time: string;
  durationPromised: number;
  status: string;
  customer: {
    id: number;
    name: string;
    address: string;
    avatar: string;
    needs: string[];
  } | null;
};

export function AppointmentCard({ appointment }: { appointment: Appointment }) {

  const statusColors = {
    "scheduled": "bg-muted text-muted-foreground border-muted-foreground/20",
    "in-progress": "bg-blue-50 text-blue-700 border-blue-200 animate-pulse",
    "documenting": "bg-orange-50 text-orange-700 border-orange-200",
    "completed": "bg-green-50 text-green-700 border-green-200"
  };

  const typeColors: Record<string, string> = {
    "First Visit": "bg-purple-100 text-purple-800 border-purple-200",
    "Customer Appointment": "bg-teal-100 text-teal-800 border-teal-200",
    "Hauswirtschaft": "bg-amber-100 text-amber-800 border-amber-200",
    "Alltagsbegleitung": "bg-pink-100 text-pink-800 border-pink-200"
  };

  return (
    <Link href={`/appointment/${appointment.id}`} className="block group transition-all duration-200 hover:-translate-y-1">
      <Card className="overflow-hidden border-border/60 shadow-sm hover:shadow-md hover:border-primary/30 transition-all bg-card">
          <CardContent className="p-0">
            <div className="flex items-stretch">
              {/* Time Column */}
              <div className="w-20 flex flex-col items-center justify-center bg-secondary/30 border-r border-border/50 p-3 text-center">
                <span className="text-lg font-bold text-foreground">{appointment.time}</span>
                <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Uhr</span>
              </div>

              {/* Main Content */}
              <div className="flex-1 p-4">
                <div className="flex justify-between items-start mb-2">
                  <Badge variant="outline" className={`rounded-full text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 ${typeColors[appointment.type] || 'bg-gray-100 text-gray-800'}`}>
                    {appointment.type}
                  </Badge>
                  <div className={`text-[10px] px-2 py-0.5 rounded-full border font-medium flex items-center gap-1 ${statusColors[appointment.status as keyof typeof statusColors] || statusColors.scheduled}`}>
                    {appointment.status === 'completed' && <CheckCircle2 className="w-3 h-3" />}
                    {appointment.status === 'in-progress' && <PlayCircle className="w-3 h-3" />}
                    {appointment.status === 'documenting' && <FileText className="w-3 h-3" />}
                    {appointment.status.replace('-', ' ')}
                  </div>
                </div>

                {appointment.customer && (
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center ring-2 ring-background shadow-sm">
                      <User className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-bold text-foreground leading-tight">{appointment.customer.name}</h3>
                      <div className="flex items-center text-xs text-muted-foreground mt-0.5">
                        <MapPin className="w-3 h-3 mr-1" />
                        <span className="truncate max-w-[150px]">{appointment.customer.address}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              
              {/* Action Arrow */}
              <div className="w-10 flex items-center justify-center text-muted-foreground/30 group-hover:text-primary transition-colors">
                <ChevronRight className="w-6 h-6" />
              </div>
            </div>
          </CardContent>
        </Card>
    </Link>
  );
}

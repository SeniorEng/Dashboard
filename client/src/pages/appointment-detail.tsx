import { useState, useRef, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointment, useUpdateAppointment } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { 
  MapPin, Clock, Navigation, 
  CheckCircle2, Play, StopCircle, FileText, Save, ChevronLeft, Loader2
} from "lucide-react";
import ladyAvatar from "@assets/generated_images/portrait_of_an_elderly_lady_smiling.png";
import manAvatar from "@assets/generated_images/portrait_of_an_elderly_man_smiling.png";
import SignatureCanvas from 'react-signature-canvas';
import { useToast } from "@/hooks/use-toast";

export default function AppointmentDetail() {
  const [match, params] = useRoute("/appointment/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const id = params?.id ? parseInt(params.id) : 0;
  
  const { data: appointment, isLoading } = useAppointment(id);
  const updateMutation = useUpdateAppointment();
  
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [endTime, setEndTime] = useState<Date | null>(null);
  const [kilometers, setKilometers] = useState("");
  const [notes, setNotes] = useState("");
  const [servicesDone, setServicesDone] = useState<string[]>([]);
  const sigPad = useRef<SignatureCanvas>(null);

  // Initialize state when appointment loads
  useEffect(() => {
    if (appointment) {
      if (appointment.startTime) {
        setStartTime(new Date(appointment.startTime));
      }
      if (appointment.endTime) {
        setEndTime(new Date(appointment.endTime));
      }
      if (appointment.kilometers) {
        setKilometers(appointment.kilometers);
      }
      if (appointment.notes) {
        setNotes(appointment.notes);
      }
      if (appointment.servicesDone) {
        setServicesDone(appointment.servicesDone);
      }
    }
  }, [appointment]);

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  if (!appointment) {
    return <Layout><div>Appointment not found</div></Layout>;
  }

  const avatarSrc = appointment.customer?.avatar === 'lady' ? ladyAvatar : manAvatar;

  const handleStartVisit = () => {
    const now = new Date();
    setStartTime(now);
    updateMutation.mutate({
      id: appointment.id,
      data: { status: "in-progress", startTime: now }
    }, {
      onSuccess: () => {
        toast({
          title: "Visit Started",
          description: `Started visit with ${appointment.customer?.name} at ${now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`,
        });
      }
    });
  };

  const handleFinishVisit = () => {
    const now = new Date();
    setEndTime(now);
    updateMutation.mutate({
      id: appointment.id,
      data: { status: "documenting", endTime: now }
    });
  };

  const handleComplete = () => {
    if (!sigPad.current || sigPad.current.isEmpty()) {
      toast({
        variant: "destructive",
        title: "Signature Required",
        description: "Please ask the customer to sign before completing.",
      });
      return;
    }

    const signatureData = sigPad.current.toDataURL();
    
    updateMutation.mutate({
      id: appointment.id,
      data: { 
        status: "completed",
        kilometers,
        notes,
        servicesDone,
        signatureData
      }
    }, {
      onSuccess: () => {
        toast({
          title: "Visit Completed",
          description: "Documentation saved successfully.",
        });
        setTimeout(() => setLocation("/"), 1500);
      }
    });
  };

  const renderContent = () => {
    switch (appointment.status) {
      case "scheduled":
        return (
          <div className="space-y-6 animate-in fade-in zoom-in-95 duration-300">
             <div className="bg-primary/5 border border-primary/10 rounded-2xl p-6 text-center space-y-4">
                <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto text-primary mb-2">
                  <Clock className="w-8 h-8" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground text-lg">Ready to start?</h3>
                  <p className="text-muted-foreground text-sm mt-1">Scheduled for {appointment.time} • {appointment.durationPromised} mins</p>
                </div>
                <Button 
                  size="lg" 
                  className="w-full font-bold shadow-lg shadow-primary/20" 
                  onClick={handleStartVisit}
                  disabled={updateMutation.isPending}
                  data-testid="button-start-visit"
                >
                  <Play className="w-4 h-4 mr-2 fill-current" /> Start Visit
                </Button>
             </div>

             {appointment.customer && (
               <Card>
                 <CardHeader>
                   <CardTitle className="text-base">Service Plan</CardTitle>
                 </CardHeader>
                 <CardContent>
                   <ul className="space-y-3">
                     {appointment.customer.needs.map((need, i) => (
                       <li key={i} className="flex items-center gap-3 text-sm">
                         <div className="w-1.5 h-1.5 rounded-full bg-primary/60" />
                         {need}
                       </li>
                     ))}
                   </ul>
                 </CardContent>
               </Card>
             )}
          </div>
        );

      case "in-progress":
        return (
          <div className="space-y-6 animate-in fade-in zoom-in-95 duration-300">
            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-8 text-center space-y-6 relative overflow-hidden">
               <div className="absolute top-0 left-0 w-full h-1 bg-blue-200 animate-pulse"></div>
               <div className="space-y-2">
                  <span className="text-blue-600 text-sm font-bold uppercase tracking-wider">Visit in Progress</span>
                  <div className="text-4xl font-bold text-blue-900 font-mono">
                    Active
                  </div>
                  <p className="text-blue-600/80 text-sm">Started at {startTime?.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</p>
               </div>
               <Button 
                 size="lg" 
                 variant="destructive" 
                 className="w-full font-bold" 
                 onClick={handleFinishVisit}
                 disabled={updateMutation.isPending}
                 data-testid="button-finish-visit"
               >
                 <StopCircle className="w-4 h-4 mr-2 fill-current" /> Finish Visit
               </Button>
            </div>

             {appointment.customer && (
               <Card className="opacity-80">
                 <CardHeader>
                   <CardTitle className="text-base">Customer Needs</CardTitle>
                 </CardHeader>
                 <CardContent>
                   <ul className="space-y-2 text-sm text-muted-foreground">
                     {appointment.customer.needs.map((need, i) => (
                       <li key={i}>• {need}</li>
                     ))}
                   </ul>
                 </CardContent>
               </Card>
             )}
          </div>
        );

      case "documenting":
        return (
          <div className="space-y-6 animate-in slide-in-from-bottom-8 duration-500">
            <div className="bg-orange-50 border border-orange-100 p-4 rounded-xl flex items-center gap-3 text-orange-800 text-sm">
              <Clock className="w-5 h-5 shrink-0" />
              <div>
                <span className="font-bold">Visit Duration:</span> 
                {startTime && endTime 
                  ? ` ${Math.round((endTime.getTime() - startTime.getTime()) / 60000)} minutes` 
                  : " --"}
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <FileText className="w-5 h-5 text-primary" />
                  Documentation
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-3">
                  <Label className="text-base">Services Performed</Label>
                  <div className="grid grid-cols-1 gap-3">
                    {["Vital Signs Check", "Medication Administered", "Personal Hygiene", "Meal Preparation", "Housekeeping", "Social Activity"].map((service) => (
                      <div key={service} className="flex items-center space-x-3 p-3 rounded-lg border border-input hover:bg-accent/50 transition-colors">
                        <Checkbox 
                          id={service} 
                          checked={servicesDone.includes(service)}
                          onCheckedChange={(checked) => {
                            if (checked) setServicesDone([...servicesDone, service]);
                            else setServicesDone(servicesDone.filter(s => s !== service));
                          }}
                          data-testid={`checkbox-${service.toLowerCase().replace(/\s+/g, '-')}`}
                        />
                        <Label htmlFor={service} className="font-normal cursor-pointer flex-1">{service}</Label>
                      </div>
                    ))}
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label htmlFor="notes">Notes / Observations</Label>
                  <Textarea 
                    id="notes" 
                    placeholder="Describe briefly what was done..." 
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="min-h-[100px]"
                    data-testid="textarea-notes"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="km">Travel Distance (km)</Label>
                  <div className="relative">
                    <Input 
                      id="km" 
                      type="number" 
                      placeholder="0" 
                      value={kilometers}
                      onChange={(e) => setKilometers(e.target.value)}
                      className="pl-10"
                      data-testid="input-kilometers"
                    />
                    <Navigation className="w-4 h-4 absolute left-3 top-3 text-muted-foreground" />
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <Label>Customer Signature</Label>
                  <div className="border rounded-lg overflow-hidden bg-white shadow-inner">
                    <SignatureCanvas 
                      ref={sigPad}
                      penColor="black"
                      canvasProps={{width: 300, height: 150, className: 'w-full h-[150px]'}} 
                    />
                  </div>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={() => sigPad.current?.clear()} 
                    className="text-xs text-muted-foreground"
                    data-testid="button-clear-signature"
                  >
                    Clear Signature
                  </Button>
                </div>
              </CardContent>
              <CardFooter className="bg-muted/20 p-6">
                <Button 
                  size="lg" 
                  className="w-full font-bold text-lg h-12" 
                  onClick={handleComplete}
                  disabled={updateMutation.isPending}
                  data-testid="button-complete-documentation"
                >
                  <Save className="w-5 h-5 mr-2" /> Complete Documentation
                </Button>
              </CardFooter>
            </Card>
          </div>
        );

      case "completed":
        return (
          <div className="text-center py-12 space-y-6 animate-in zoom-in-90 duration-500">
            <div className="w-24 h-24 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="w-12 h-12" />
            </div>
            <h2 className="text-2xl font-bold text-foreground">All Done!</h2>
            <p className="text-muted-foreground max-w-xs mx-auto">
              Visit successfully documented and saved. Great job, Sarah!
            </p>
            <Button size="lg" variant="outline" onClick={() => setLocation("/")}>
              Back to Dashboard
            </Button>
          </div>
        );
    }
  };

  return (
    <Layout>
      <div className="mb-6">
        <Button 
          variant="ghost" 
          size="sm" 
          className="pl-0 text-muted-foreground hover:text-foreground mb-4" 
          onClick={() => setLocation("/")}
          data-testid="button-back"
        >
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Schedule
        </Button>

        {appointment.customer && (
          <div className="flex items-start gap-4 mb-6">
            <img src={avatarSrc} alt={appointment.customer.name} className="w-16 h-16 rounded-2xl object-cover shadow-md ring-1 ring-border" />
            <div>
              <Badge variant="secondary" className="mb-2">{appointment.type}</Badge>
              <h1 className="text-2xl font-bold leading-tight">{appointment.customer.name}</h1>
              <div className="flex items-center text-muted-foreground text-sm mt-1">
                <MapPin className="w-3.5 h-3.5 mr-1 text-primary" />
                {appointment.customer.address}
              </div>
            </div>
          </div>
        )}
      </div>

      {renderContent()}
    </Layout>
  );
}

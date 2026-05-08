import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Loader2, Plus } from "lucide-react";
import { useCreateProspect } from "@/features/prospects/hooks/use-prospects";
import { AddressFields } from "@/features/customers/components/wizard/address-fields";
import { isDachPhone } from "@shared/schema/common";

export function CreateProspectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [vorname, setVorname] = useState("");
  const [nachname, setNachname] = useState("");
  const [telefon, setTelefon] = useState("");
  const [email, setEmail] = useState("");
  const [strasse, setStrasse] = useState("");
  const [nr, setNr] = useState("");
  const [plz, setPlz] = useState("");
  const [stadt, setStadt] = useState("");
  const [quelle, setQuelle] = useState("");
  const [notiz, setNotiz] = useState("");
  const [wiedervorlageDate, setWiedervorlageDate] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const createMutation = useCreateProspect();

  const handleAddressChange = useCallback((field: string, value: string) => {
    if (field === "strasse") setStrasse(value);
    else if (field === "nr") setNr(value);
    else if (field === "plz") setPlz(value);
    else if (field === "stadt") setStadt(value);
  }, []);

  const handleSubmit = () => {
    const errs: Record<string, string> = {};
    if (!vorname.trim()) errs.vorname = "Vorname ist erforderlich";
    if (!nachname.trim()) errs.nachname = "Nachname ist erforderlich";
    if (telefon.trim() && !isDachPhone(telefon.trim())) {
      errs.telefon = "Ungültige Telefonnummer (DE/AT/CH)";
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email = "Ungültige E-Mail-Adresse";
    }
    if (plz.trim() && !/^\d{5}$/.test(plz.trim())) {
      errs.plz = "PLZ muss 5 Ziffern haben";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    createMutation.mutate({
      vorname,
      nachname,
      telefon: telefon || null,
      email: email || null,
      strasse: strasse || null,
      nr: nr || null,
      plz: plz || null,
      stadt: stadt || null,
      quelle: quelle || null,
      status: wiedervorlageDate ? "wiedervorlage" : "neu",
      wiedervorlageDate: wiedervorlageDate || null,
      _initialNote: notiz || undefined,
    }, {
      onSuccess: () => {
        setVorname(""); setNachname(""); setTelefon(""); setEmail("");
        setStrasse(""); setNr(""); setPlz(""); setStadt("");
        setQuelle(""); setNotiz(""); setWiedervorlageDate("");
        setErrors({});
        onClose();
      },
    });
  };

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Neuer Interessent</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 mt-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Vorname *</Label>
              <Input value={vorname} onChange={(e) => setVorname(e.target.value)} className={errors.vorname ? "border-destructive" : ""} data-testid="input-prospect-vorname" />
              {errors.vorname && <p className="text-destructive text-xs mt-1">{errors.vorname}</p>}
            </div>
            <div>
              <Label>Nachname *</Label>
              <Input value={nachname} onChange={(e) => setNachname(e.target.value)} className={errors.nachname ? "border-destructive" : ""} data-testid="input-prospect-nachname" />
              {errors.nachname && <p className="text-destructive text-xs mt-1">{errors.nachname}</p>}
            </div>
          </div>
          <div>
            <Label>Telefon</Label>
            <Input value={telefon} onChange={(e) => setTelefon(e.target.value)} type="tel" className={errors.telefon ? "border-destructive" : ""} data-testid="input-prospect-telefon" />
            {errors.telefon && <p className="text-destructive text-xs mt-1">{errors.telefon}</p>}
          </div>
          <div>
            <Label>E-Mail</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className={errors.email ? "border-destructive" : ""} data-testid="input-prospect-email" />
            {errors.email && <p className="text-destructive text-xs mt-1">{errors.email}</p>}
          </div>
          <AddressFields
            strasse={strasse}
            nr={nr}
            plz={plz}
            stadt={stadt}
            onChange={handleAddressChange}
            testIdPrefix="prospect"
          />
          {errors.plz && <p className="text-destructive text-xs">{errors.plz}</p>}
          <div>
            <Label>Quelle</Label>
            <Input value={quelle} onChange={(e) => setQuelle(e.target.value)} placeholder="z.B. pflege24.de" data-testid="input-prospect-quelle" />
          </div>
          <div>
            <Label>Wiedervorlage am</Label>
            <Input type="date" value={wiedervorlageDate} onChange={(e) => setWiedervorlageDate(e.target.value)} data-testid="input-prospect-wiedervorlage" />
            <p className="text-[11px] text-gray-500 mt-1">Wenn gesetzt, wird der Status automatisch auf „Wiedervorlage" gesetzt</p>
          </div>
          <div>
            <Label>Notiz</Label>
            <Textarea value={notiz} onChange={(e) => setNotiz(e.target.value)} placeholder="z.B. Wünscht Hauswirtschaft 2x wöchentlich, Rückruf vereinbart" rows={3} data-testid="input-prospect-notiz" />
          </div>
          <Button onClick={handleSubmit} disabled={!vorname || !nachname || createMutation.isPending} className="w-full" data-testid="button-create-prospect">
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
            Interessent anlegen
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

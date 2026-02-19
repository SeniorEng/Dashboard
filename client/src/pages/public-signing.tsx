import { useState, useEffect, useCallback } from "react";
import DOMPurify from "dompurify";
import { useParams } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SignaturePad } from "@/components/ui/signature-pad";
import { Loader2, FileText, Check, AlertTriangle, Clock, ShieldCheck } from "lucide-react";

interface DocumentData {
  documentId: number;
  fileName: string;
  renderedHtml: string;
  hasEmployerSignature: boolean;
  generatedAt: string;
  expiresAt: string;
}

type PageState = "loading" | "ready" | "signing" | "submitting" | "success" | "error";

export default function PublicSigningPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [pageState, setPageState] = useState<PageState>("loading");
  const [docData, setDocData] = useState<DocumentData | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [errorType, setErrorType] = useState<"expired" | "used" | "not_found" | "generic">("generic");

  useEffect(() => {
    if (!token) return;
    fetch(`/api/public/sign/${token}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          if (data.error === "ALREADY_USED") {
            setErrorType("used");
            setErrorMessage(data.message);
          } else if (data.error === "EXPIRED") {
            setErrorType("expired");
            setErrorMessage(data.message);
          } else {
            setErrorType("not_found");
            setErrorMessage(data.message || "Link ungültig.");
          }
          setPageState("error");
          return;
        }
        setDocData(data);
        setPageState("ready");
      })
      .catch(() => {
        setErrorType("generic");
        setErrorMessage("Verbindungsfehler. Bitte versuchen Sie es erneut.");
        setPageState("error");
      });
  }, [token]);

  const handleSign = useCallback(async (signatureData: string) => {
    setPageState("submitting");
    try {
      const res = await fetch(`/api/public/sign/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureData }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.message || "Fehler beim Speichern der Unterschrift.");
        setPageState("ready");
        return;
      }
      setPageState("success");
    } catch {
      setErrorMessage("Verbindungsfehler. Bitte versuchen Sie es erneut.");
      setPageState("ready");
    }
  }, [token]);

  if (pageState === "loading") {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <Loader2 className="h-10 w-10 animate-spin text-teal-600 mx-auto" />
          <p className="text-gray-600">Dokument wird geladen...</p>
        </div>
      </div>
    );
  }

  if (pageState === "error") {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            {errorType === "used" ? (
              <Check className="h-12 w-12 text-green-500 mx-auto" />
            ) : errorType === "expired" ? (
              <Clock className="h-12 w-12 text-amber-500 mx-auto" />
            ) : (
              <AlertTriangle className="h-12 w-12 text-red-500 mx-auto" />
            )}
            <h2 className="text-lg font-semibold">
              {errorType === "used" ? "Bereits unterschrieben" :
               errorType === "expired" ? "Link abgelaufen" :
               "Link ungültig"}
            </h2>
            <p className="text-sm text-gray-600">{errorMessage}</p>
            {errorType === "expired" && (
              <p className="text-xs text-gray-400">Bitte kontaktieren Sie Ihren Arbeitgeber für einen neuen Unterschrifts-Link.</p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (pageState === "success") {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="h-16 w-16 rounded-full bg-green-100 flex items-center justify-center mx-auto">
              <Check className="h-8 w-8 text-green-600" />
            </div>
            <h2 className="text-xl font-semibold text-green-800">Vielen Dank!</h2>
            <p className="text-sm text-gray-600">
              Ihre Unterschrift wurde erfolgreich gespeichert. Das Dokument wurde aktualisiert und Ihr Arbeitgeber wurde benachrichtigt.
            </p>
            <p className="text-xs text-gray-400">Sie können diese Seite jetzt schließen.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <div className="flex items-center gap-2 py-3">
          <ShieldCheck className="h-6 w-6 text-teal-600" />
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Digitale Unterschrift</h1>
            <p className="text-xs text-gray-500">SeniorenEngel Dokumentenverwaltung</p>
          </div>
        </div>

        {docData && (
          <>
            <Card>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <FileText className="h-4 w-4 text-teal-600" />
                  <span className="font-medium">{docData.fileName}</span>
                </div>

                {docData.expiresAt && (
                  <p className="text-xs text-gray-400">
                    Gültig bis: {new Date(docData.expiresAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}
                  </p>
                )}

                <div className="border rounded-lg p-4 bg-white max-h-[40vh] overflow-y-auto">
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(docData.renderedHtml, { ALLOWED_TAGS: ['h1','h2','h3','h4','p','br','strong','em','ul','ol','li','table','tr','td','th','thead','tbody','img','div','span','hr','b','i','u','a'], ALLOWED_ATTR: ['class','style','src','alt','width','height','colspan','rowspan','href'] }) }}
                    data-testid="preview-signing-document"
                  />
                </div>
              </CardContent>
            </Card>

            {pageState === "ready" && (
              <Card>
                <CardContent className="pt-4">
                  {errorMessage && (
                    <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                      {errorMessage}
                    </div>
                  )}
                  <SignaturePad
                    title="Ihre Unterschrift"
                    description="Bitte unterschreiben Sie in dem Feld unten, um das Dokument zu bestätigen."
                    onSave={handleSign}
                    data-testid="signing-pad"
                  />
                </CardContent>
              </Card>
            )}

            {pageState === "submitting" && (
              <Card>
                <CardContent className="py-8 text-center space-y-3">
                  <Loader2 className="h-8 w-8 animate-spin text-teal-600 mx-auto" />
                  <p className="text-sm text-gray-600">Unterschrift wird gespeichert...</p>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

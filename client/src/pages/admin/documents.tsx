import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, FileCheck2, FileText } from "lucide-react";
import { iconSize } from "@/design-system";
import { DocumentTypesContent } from "./document-types";
import { DocumentTemplatesContent } from "./document-templates";

export default function AdminDocuments() {
  const [activeTab, setActiveTab] = useState("types");

  return (
    <Layout variant="admin">
      <div className="flex items-center gap-2 sm:gap-4 mb-6">
        <Link href="/admin">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">Dokumente & Vorlagen</h1>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4 w-full sm:w-auto" data-testid="tabs-documents">
          <TabsTrigger value="types" className="flex items-center gap-1.5" data-testid="tab-document-types">
            <FileCheck2 className="h-4 w-4" />
            <span>Dokumententypen</span>
          </TabsTrigger>
          <TabsTrigger value="templates" className="flex items-center gap-1.5" data-testid="tab-document-templates">
            <FileText className="h-4 w-4" />
            <span>Vertragsvorlagen</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="types">
          <DocumentTypesContent />
        </TabsContent>

        <TabsContent value="templates">
          <DocumentTemplatesContent />
        </TabsContent>
      </Tabs>
    </Layout>
  );
}

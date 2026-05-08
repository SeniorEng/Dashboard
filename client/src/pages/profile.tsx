import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/patterns";
import { api, unwrapResult } from "@/lib/api/client";
import { Loader2 } from "lucide-react";
import {
  type ProfileData,
  PersonalDataSection,
  EmergencyContactSection,
  PetAcceptanceSection,
  WhatsAppSection,
  BrowserNotificationsSection,
  PasswordSection,
  ProofsSection,
  DocumentsSection,
} from "@/features/profile";

export default function ProfilePage() {
  const { data: profile, isLoading } = useQuery<ProfileData>({
    queryKey: ["profile"],
    queryFn: async () => {
      const result = await api.get<ProfileData>("/profile");
      return unwrapResult(result);
    },
  });

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  if (!profile) {
    return (
      <Layout>
        <PageHeader title="Mein Profil" backHref="/" />
        <p className="text-muted-foreground text-center py-8">Profil konnte nicht geladen werden.</p>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader title="Mein Profil" backHref="/" />
      <div className="space-y-4">
        <PersonalDataSection profile={profile} />
        <EmergencyContactSection profile={profile} />
        <PetAcceptanceSection profile={profile} />
        <WhatsAppSection />
        <BrowserNotificationsSection />
        <PasswordSection />
        <ProofsSection />
        <DocumentsSection employeeId={profile.id} />
      </div>
    </Layout>
  );
}

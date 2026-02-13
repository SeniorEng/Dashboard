import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import { lazy, Suspense } from "react";

import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import LoginPage from "@/pages/login";

const AppointmentDetail = lazy(() => import("@/pages/appointment-detail"));
const NewAppointment = lazy(() => import("@/pages/new-appointment"));
const EditAppointment = lazy(() => import("@/pages/edit-appointment"));
const DocumentAppointment = lazy(() => import("@/pages/document-appointment"));
const Customers = lazy(() => import("@/pages/customers"));
const MyTimes = lazy(() => import("@/pages/my-times"));
const Birthdays = lazy(() => import("@/pages/birthdays"));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password"));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password"));
const AdminDashboard = lazy(() => import("@/pages/admin/dashboard"));
const AdminUsers = lazy(() => import("@/pages/admin/users"));
const AdminCustomerAssignments = lazy(() => import("@/pages/admin/customer-assignments"));
const AdminCustomers = lazy(() => import("@/pages/admin/customers"));
const AdminCustomerDetail = lazy(() => import("@/pages/admin/customer-detail"));
const AdminCustomerNew = lazy(() => import("@/pages/admin/customer-new"));
const AdminCustomerEdit = lazy(() => import("@/pages/admin/customer-edit"));
const AdminTimeEntries = lazy(() => import("@/pages/admin/time-entries"));
const AdminInsuranceProviders = lazy(() => import("@/pages/admin/insurance-providers"));
const AdminServices = lazy(() => import("@/pages/admin/services"));
const AdminSettings = lazy(() => import("@/pages/admin/settings"));
const AdminDocumentTypes = lazy(() => import("@/pages/admin/document-types"));
const AdminAuditLog = lazy(() => import("@/pages/admin/audit-log"));
const UndocumentedAppointments = lazy(() => import("@/pages/undocumented-appointments"));
const CustomerDetail = lazy(() => import("@/pages/customer-detail"));
const TasksPage = lazy(() => import("@/pages/tasks"));
const ServiceRecordsPage = lazy(() => import("@/pages/service-records"));
const ServiceRecordDetailPage = lazy(() => import("@/pages/service-record-detail"));

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
      <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
    </div>
  );
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, isLoading } = useAuth();
  const [, navigate] = useLocation();

  if (isLoading) {
    return <PageLoader />;
  }

  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Component />
    </Suspense>
  );
}

function AdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, isLoading, user } = useAuth();

  if (isLoading) {
    return <PageLoader />;
  }

  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  if (!user?.isAdmin) {
    return <Redirect to="/" />;
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Component />
    </Suspense>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/forgot-password">
        <Suspense fallback={<PageLoader />}>
          <ForgotPasswordPage />
        </Suspense>
      </Route>
      <Route path="/reset-password">
        <Suspense fallback={<PageLoader />}>
          <ResetPasswordPage />
        </Suspense>
      </Route>
      <Route path="/">
        <ProtectedRoute component={Dashboard} />
      </Route>
      <Route path="/customers">
        <ProtectedRoute component={Customers} />
      </Route>
      <Route path="/customer/:id">
        {() => <ProtectedRoute component={() => <CustomerDetail />} />}
      </Route>
      <Route path="/my-times">
        <ProtectedRoute component={MyTimes} />
      </Route>
      <Route path="/birthdays">
        <ProtectedRoute component={Birthdays} />
      </Route>
      <Route path="/undocumented">
        <ProtectedRoute component={UndocumentedAppointments} />
      </Route>
      <Route path="/tasks">
        <ProtectedRoute component={TasksPage} />
      </Route>
      <Route path="/service-records">
        <ProtectedRoute component={ServiceRecordsPage} />
      </Route>
      <Route path="/service-records/:id">
        {() => <ProtectedRoute component={() => <ServiceRecordDetailPage />} />}
      </Route>
      <Route path="/appointment/:id">
        {(params) => <ProtectedRoute component={() => <AppointmentDetail />} />}
      </Route>
      <Route path="/new-appointment">
        <ProtectedRoute component={NewAppointment} />
      </Route>
      <Route path="/edit-appointment/:id">
        {(params) => <ProtectedRoute component={() => <EditAppointment />} />}
      </Route>
      <Route path="/document-appointment/:id">
        {(params) => <ProtectedRoute component={() => <DocumentAppointment />} />}
      </Route>
      <Route path="/admin">
        <AdminRoute component={AdminDashboard} />
      </Route>
      <Route path="/admin/users">
        <AdminRoute component={AdminUsers} />
      </Route>
      <Route path="/admin/customer-assignments">
        <AdminRoute component={AdminCustomerAssignments} />
      </Route>
      <Route path="/admin/customers/new">
        <AdminRoute component={AdminCustomerNew} />
      </Route>
      <Route path="/admin/customers/:id/edit">
        {() => <AdminRoute component={() => <AdminCustomerEdit />} />}
      </Route>
      <Route path="/admin/customers/:id">
        {() => <AdminRoute component={() => <AdminCustomerDetail />} />}
      </Route>
      <Route path="/admin/customers">
        <AdminRoute component={AdminCustomers} />
      </Route>
      <Route path="/admin/insurance-providers">
        <AdminRoute component={AdminInsuranceProviders} />
      </Route>
      <Route path="/admin/services">
        <AdminRoute component={AdminServices} />
      </Route>
      <Route path="/admin/time-entries">
        <AdminRoute component={AdminTimeEntries} />
      </Route>
      <Route path="/admin/settings">
        <AdminRoute component={AdminSettings} />
      </Route>
      <Route path="/admin/document-types">
        <AdminRoute component={AdminDocumentTypes} />
      </Route>
      <Route path="/admin/audit-log">
        <AdminRoute component={AdminAuditLog} />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;

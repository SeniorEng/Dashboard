import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/error-boundary";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import AppointmentDetail from "@/pages/appointment-detail";
import NewAppointment from "@/pages/new-appointment";
import EditAppointment from "@/pages/edit-appointment";
import DocumentAppointment from "@/pages/document-appointment";
import Customers from "@/pages/customers";
import MyTimes from "@/pages/my-times";
import Birthdays from "@/pages/birthdays";
import LoginPage from "@/pages/login";
import ForgotPasswordPage from "@/pages/forgot-password";
import ResetPasswordPage from "@/pages/reset-password";
import AdminDashboard from "@/pages/admin/dashboard";
import AdminUsers from "@/pages/admin/users";
import AdminCustomerAssignments from "@/pages/admin/customer-assignments";
import AdminCustomers from "@/pages/admin/customers";
import AdminCustomerDetail from "@/pages/admin/customer-detail";
import AdminCustomerNew from "@/pages/admin/customer-new";
import AdminCustomerEdit from "@/pages/admin/customer-edit";
import AdminTimeEntries from "@/pages/admin/time-entries";
import UndocumentedAppointments from "@/pages/undocumented-appointments";
import CustomerDetail from "@/pages/customer-detail";
import TasksPage from "@/pages/tasks";

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, isLoading } = useAuth();
  const [, navigate] = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  return <Component />;
}

function AdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  if (!user?.isAdmin) {
    return <Redirect to="/" />;
  }

  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/forgot-password" component={ForgotPasswordPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
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
      <Route path="/admin/time-entries">
        <AdminRoute component={AdminTimeEntries} />
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

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Spin } from 'antd';
import { useAuthStore } from './store/authStore';
import AppLayout from './components/layout/AppLayout';
import LandingPage from './pages/landing/LandingPage';
import LoginPage from './pages/login/LoginPage';
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage';
import VerifyOtpPage from './pages/auth/VerifyOtpPage';
import ResetPasswordPage from './pages/auth/ResetPasswordPage';
import DashboardPage from './pages/dashboard/DashboardPage';
import GatesPage from './pages/gates/GatesPage';
import GateSimulatorPage from './pages/gates/GateSimulatorPage';
import EventsPage from './pages/events/EventsPage';
import UsersPage from './pages/users/UsersPage';
import TenantsPage from './pages/admin/TenantsPage';
import ResidentsPage from './pages/admin/ResidentsPage';
import VehiclesPage from './pages/admin/VehiclesPage';
import SubscriptionsPage from './pages/admin/SubscriptionsPage';
import PlansManagementPage from './pages/admin/PlansManagementPage';
import DevicesPage from './pages/admin/DevicesPage';
import FirmwareManagementPage from './pages/admin/FirmwareManagementPage';
import MyVisitorsPage from './pages/visitors/MyVisitorsPage';
import VisitorPassPage from './pages/public/VisitorPassPage';
import ReportUnauthorizedPage from './pages/public/ReportUnauthorizedPage';
import SecurityAlertsPage from './pages/security/SecurityAlertsPage';
import SignupPage from './pages/signup/SignupPage';
import SignupSuccessPage from './pages/signup/SignupSuccessPage';
import BillingSettingsPage from './pages/billing/BillingSettingsPage';
import PaymentsAdminPage from './pages/admin/PaymentsAdminPage';
import ProfilePage from './pages/profile/ProfilePage';
import SettingsPage from './pages/settings/SettingsPage';
import NotificationsPage from './pages/notifications/NotificationsPage';
import PrivacyPage from './pages/static/Privacy';
import TermsPage from './pages/static/Terms';
import SecurityPage from './pages/static/Security';
import AboutPage from './pages/static/About';
import BlogPage from './pages/static/Blog';
import ContactPage from './pages/static/Contact';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Spin size="large" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function App() {
  const { isAuthenticated, checkAuth, tokens } = useAuthStore();
  const [isInitialized, setIsInitialized] = useState(false);

  // Check auth and refresh user data on app mount
  useEffect(() => {
    const initAuth = async () => {
      if (tokens) {
        await checkAuth();
      }
      setIsInitialized(true);
    };
    initAuth();
  }, []);

  // Show loading while initializing
  if (!isInitialized) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Public landing page */}
        <Route path="/" element={<LandingPage />} />

        {/* Login */}
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />}
        />

        {/* Password Reset Flow */}
        <Route
          path="/forgot-password"
          element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <ForgotPasswordPage />}
        />
        <Route
          path="/verify-otp"
          element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <VerifyOtpPage />}
        />
        <Route
          path="/reset-password"
          element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <ResetPasswordPage />}
        />

        {/* Signup */}
        <Route
          path="/signup"
          element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <SignupPage />}
        />

        {/* Signup Success - after Stripe Checkout */}
        <Route
          path="/signup/success"
          element={<SignupSuccessPage />}
        />

        {/* Public visitor pass page (no auth required) */}
        <Route path="/visitor-pass/:qrToken" element={<VisitorPassPage />} />

        {/* Public report unauthorized page (no auth required - accessed via email link) */}
        <Route path="/report-unauthorized" element={<ReportUnauthorizedPage />} />

        {/* Public legal pages */}
        <Route path="/about" element={<AboutPage />} />
        <Route path="/blog" element={<BlogPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/security" element={<SecurityPage />} />

        {/* Protected app routes */}
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="gates" element={<GatesPage />} />
          <Route path="simulator" element={<GateSimulatorPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="admin/tenants" element={<TenantsPage />} />
          <Route path="admin/subscriptions" element={<SubscriptionsPage />} />
          <Route path="admin/plans" element={<PlansManagementPage />} />
          <Route path="admin/devices" element={<DevicesPage />} />
          <Route path="admin/firmware" element={<FirmwareManagementPage />} />
          <Route path="admin/residents" element={<ResidentsPage />} />
          <Route path="admin/vehicles" element={<VehiclesPage />} />
          <Route path="admin/payments" element={<PaymentsAdminPage />} />
          <Route path="visitors" element={<MyVisitorsPage />} />
          <Route path="security-alerts" element={<SecurityAlertsPage />} />
          <Route path="billing/settings" element={<BillingSettingsPage />} />
        </Route>

        {/* Catch all - redirect to landing */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;

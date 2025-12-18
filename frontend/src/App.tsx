import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import AppLayout from './components/layout/AppLayout';
import LandingPage from './pages/landing/LandingPage';
import LoginPage from './pages/login/LoginPage';
import DashboardPage from './pages/dashboard/DashboardPage';
import GatesPage from './pages/gates/GatesPage';
import GateSimulatorPage from './pages/gates/GateSimulatorPage';
import EventsPage from './pages/events/EventsPage';
import UsersPage from './pages/users/UsersPage';
import TenantsPage from './pages/admin/TenantsPage';
import ResidentsPage from './pages/admin/ResidentsPage';
import VehiclesPage from './pages/admin/VehiclesPage';
import MyVisitorsPage from './pages/visitors/MyVisitorsPage';
import VisitorPassPage from './pages/public/VisitorPassPage';
import SignupPage from './pages/signup/SignupPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function App() {
  const { isAuthenticated } = useAuthStore();

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

        {/* Signup */}
        <Route
          path="/signup"
          element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <SignupPage />}
        />

        {/* Public visitor pass page (no auth required) */}
        <Route path="/visitor-pass/:qrToken" element={<VisitorPassPage />} />

        {/* Protected app routes */}
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="gates" element={<GatesPage />} />
          <Route path="simulator" element={<GateSimulatorPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="admin/tenants" element={<TenantsPage />} />
          <Route path="admin/residents" element={<ResidentsPage />} />
          <Route path="admin/vehicles" element={<VehiclesPage />} />
          <Route path="visitors" element={<MyVisitorsPage />} />
        </Route>

        {/* Catch all - redirect to landing */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;

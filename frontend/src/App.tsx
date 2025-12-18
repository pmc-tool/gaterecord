import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import AppLayout from './components/layout/AppLayout';
import LoginPage from './pages/login/LoginPage';
import DashboardPage from './pages/dashboard/DashboardPage';
import GatesPage from './pages/gates/GatesPage';
import GateSimulatorPage from './pages/gates/GateSimulatorPage';
import EventsPage from './pages/events/EventsPage';
import UsersPage from './pages/users/UsersPage';
import TenantsPage from './pages/admin/TenantsPage';
import ResidentsPage from './pages/admin/ResidentsPage';
import VehiclesPage from './pages/admin/VehiclesPage';

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
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />}
        />

        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="gates" element={<GatesPage />} />
          <Route path="simulator" element={<GateSimulatorPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="admin/tenants" element={<TenantsPage />} />
          <Route path="admin/residents" element={<ResidentsPage />} />
          <Route path="admin/vehicles" element={<VehiclesPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;

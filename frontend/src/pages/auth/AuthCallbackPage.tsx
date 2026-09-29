import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Card, Spin, Result, Button, message } from 'antd';
import { useAuthStore } from '../../store/authStore';
import { oidcService } from '../../services/oidc.service';
import { settingsService } from '../../services/settings.service';

/**
 * Keycloak sends the browser back here after the YAAD-account sign-in (or after
 * its change-password screen). Exchanges the code, then continues to the page
 * that started the round trip.
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const { loginWithOidc, setUser } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  // React 18 StrictMode runs effects twice in development; the code is single use.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    (async () => {
      try {
        const result = await oidcService.handleCallback(window.location.search);
        await loginWithOidc(result.tokens);

        if (result.action === 'UPDATE_PASSWORD') {
          if (result.actionStatus === 'success') {
            message.success('Password changed successfully');
            try {
              await settingsService.acknowledgePasswordUpdated();
              const current = useAuthStore.getState().user;
              if (current) setUser({ ...current, mustChangePassword: false });
            } catch {
              // Only the reminder banner stays; the password itself is changed.
            }
          } else if (result.actionStatus === 'cancelled') {
            message.info('Password was not changed');
          }
        }

        navigate(result.returnTo, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
      }
    })();
  }, [loginWithOidc, navigate, setUser]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-md shadow-xl">
        {error ? (
          <Result
            status="error"
            title="Sign-in failed"
            subTitle={error}
            extra={
              <Link to="/login">
                <Button type="primary">Back to sign in</Button>
              </Link>
            }
          />
        ) : (
          <div className="py-12 flex justify-center">
            <Spin size="large" tip="Signing you in..." />
          </div>
        )}
      </Card>
    </div>
  );
}

export default AuthCallbackPage;

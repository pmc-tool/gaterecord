import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Result, Button, Spin, Card, Typography } from 'antd';
import { CheckCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import axios from 'axios';
import { useAuthStore } from '../../store/authStore';

const { Title, Text } = Typography;

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

export default function SignupSuccessPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setAuth } = useAuthStore();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const sessionId = searchParams.get('session_id');

  useEffect(() => {
    const verifyPayment = async () => {
      if (!sessionId) {
        setStatus('error');
        setError('No session ID found. Please try signing up again.');
        return;
      }

      try {
        // Verify the checkout session and activate the account
        const response = await axios.post(`${API_URL}/auth/verify-payment`, {
          sessionId,
        });

        // If we get tokens back, set auth
        if (response.data.accessToken) {
          setAuth(response.data.user, {
            accessToken: response.data.accessToken,
            refreshToken: response.data.refreshToken,
          });
        }

        setStatus('success');

        // Redirect to dashboard after 3 seconds
        setTimeout(() => {
          navigate('/dashboard');
        }, 3000);
      } catch (err: unknown) {
        const error = err as { response?: { data?: { message?: string } } };
        setStatus('error');
        setError(error.response?.data?.message || 'Failed to verify payment. Please contact support.');
      }
    };

    verifyPayment();
  }, [sessionId, navigate, setAuth]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center shadow-xl">
          <Spin indicator={<LoadingOutlined style={{ fontSize: 48 }} spin />} />
          <Title level={4} className="mt-6">Verifying your payment...</Title>
          <Text type="secondary">Please wait while we set up your account.</Text>
        </Card>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <Card className="max-w-md w-full shadow-xl">
          <Result
            status="error"
            title="Payment Verification Failed"
            subTitle={error}
            extra={[
              <Button type="primary" key="retry" onClick={() => navigate('/signup')}>
                Try Again
              </Button>,
              <Button key="support" onClick={() => window.location.href = 'mailto:support@gaterecord.com'}>
                Contact Support
              </Button>,
            ]}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
      <Card className="max-w-md w-full shadow-xl">
        <div className="text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircleOutlined className="text-5xl text-green-500" />
          </div>
          
          <Title level={2} className="mb-2">Welcome to GateRecord!</Title>
          <Text type="secondary" className="text-lg block mb-6">
            Your account has been created successfully.
          </Text>

          <div className="bg-gray-50 rounded-lg p-4 mb-6 text-left">
            <Text className="text-gray-600 block mb-2">
              <CheckCircleOutlined className="text-green-500 mr-2" />
              Payment confirmed
            </Text>
            <Text className="text-gray-600 block mb-2">
              <CheckCircleOutlined className="text-green-500 mr-2" />
              Account activated
            </Text>
            <Text className="text-gray-600 block">
              <CheckCircleOutlined className="text-green-500 mr-2" />
              Ready to use
            </Text>
          </div>

          <Text type="secondary" className="block mb-4">
            Redirecting to dashboard in 3 seconds...
          </Text>

          <Button 
            type="primary" 
            size="large" 
            onClick={() => navigate('/dashboard')}
            className="bg-gradient-to-r from-green-500 to-emerald-600 border-none"
          >
            Go to Dashboard Now
          </Button>
        </div>
      </Card>
    </div>
  );
}

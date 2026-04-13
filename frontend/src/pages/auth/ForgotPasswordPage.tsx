import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Form, Input, Button, Card, Typography, Alert, Space } from 'antd';
import { MailOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import { authService } from '../../services/auth.service';

const { Title, Text } = Typography;

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (values: { email: string }) => {
    setLoading(true);
    setError(null);

    try {
      const response = await authService.forgotPassword(values.email);
      setSuccess(true);
      // Store email for the OTP page
      sessionStorage.setItem('resetEmail', values.email);
      sessionStorage.setItem('otpExpiry', String(Date.now() + response.expiresIn * 1000));
      
      // Navigate to OTP verification page after a short delay
      setTimeout(() => {
        navigate('/verify-otp');
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reset code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="w-full max-w-md">
        <Card className="shadow-xl">
          <Space direction="vertical" size="large" className="w-full">
            <div className="text-center">
              <Link to="/" className="inline-flex items-center gap-2 mb-4">
                <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl flex items-center justify-center">
                  <ShieldCheckIcon className="w-7 h-7 text-white" />
                </div>
              </Link>
              <Title level={2} className="mb-2">
                Forgot Password
              </Title>
              <Text type="secondary">
                Enter your email address and we'll send you a verification code
              </Text>
            </div>

            {error && (
              <Alert
                message="Error"
                description={error}
                type="error"
                showIcon
                closable
                onClose={() => setError(null)}
              />
            )}

            {success && (
              <Alert
                message="Verification Code Sent"
                description="Please check your email for the 6-digit verification code. Redirecting..."
                type="success"
                showIcon
              />
            )}

            <Form
              form={form}
              layout="vertical"
              onFinish={handleSubmit}
              autoComplete="off"
              disabled={success}
            >
              <Form.Item
                name="email"
                rules={[
                  { required: true, message: 'Please enter your email' },
                  { type: 'email', message: 'Please enter a valid email' },
                ]}
              >
                <Input
                  prefix={<MailOutlined className="text-gray-400" />}
                  placeholder="Email"
                  size="large"
                />
              </Form.Item>

              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  block
                  size="large"
                  className="bg-gradient-to-r from-blue-600 to-indigo-600 border-none"
                >
                  Send Verification Code
                </Button>
              </Form.Item>
            </Form>

            <div className="text-center">
              <Link to="/login" className="text-blue-600 hover:text-blue-700">
                <ArrowLeftOutlined className="mr-1" />
                Back to Login
              </Link>
            </div>
          </Space>
        </Card>
      </div>
    </div>
  );
}

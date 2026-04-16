import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Form, Input, Button, Card, Typography, Alert, Space } from 'antd';
import { LockOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import { authService } from '../../services/auth.service';
import PasswordRequirements, { validatePassword as checkPassword } from '../../components/PasswordRequirements';

const { Title, Text } = Typography;

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [email, setEmail] = useState<string>('');
  const [token, setToken] = useState<string>('');
  const [password, setPassword] = useState<string>('');

  useEffect(() => {
    const storedEmail = sessionStorage.getItem('resetEmail');
    const storedToken = sessionStorage.getItem('resetToken');
    
    if (!storedEmail || !storedToken) {
      navigate('/forgot-password');
      return;
    }
    
    setEmail(storedEmail);
    setToken(storedToken);
  }, [navigate]);

  const handleSubmit = async (values: { password: string }) => {
    if (!email || !token) return;
    
    setLoading(true);
    setError(null);

    try {
      await authService.resetPassword(email, token, values.password);
      setSuccess(true);
      
      // Clear session storage
      sessionStorage.removeItem('resetEmail');
      sessionStorage.removeItem('resetToken');
      sessionStorage.removeItem('otpExpiry');
      
      // Redirect to login after a short delay
      setTimeout(() => {
        navigate('/login');
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  const validatePasswordField = (_: unknown, value: string) => {
    const { isValid, errors } = checkPassword(value);
    if (!isValid) {
      return Promise.reject(new Error(errors[0]));
    }
    return Promise.resolve();
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
                Reset Password
              </Title>
              <Text type="secondary">
                Create a new password for your account
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

            {success ? (
              <div className="text-center py-8">
                <CheckCircleOutlined className="text-6xl text-green-500 mb-4" />
                <Title level={3} className="text-green-600">
                  Password Reset Successful!
                </Title>
                <Text type="secondary">
                  Your password has been reset successfully. Redirecting to login...
                </Text>
              </div>
            ) : (
              <Form
                form={form}
                layout="vertical"
                onFinish={handleSubmit}
                autoComplete="off"
              >
                <Form.Item
                  name="password"
                  rules={[{ validator: validatePasswordField }]}
                >
                  <Input.Password
                    prefix={<LockOutlined className="text-gray-400" />}
                    placeholder="New Password"
                    size="large"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Form.Item>

                <Form.Item
                  name="confirmPassword"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: 'Please confirm your password' },
                    ({ getFieldValue }) => ({
                      validator(_, value) {
                        if (!value || getFieldValue('password') === value) {
                          return Promise.resolve();
                        }
                        return Promise.reject(new Error('Passwords do not match'));
                      },
                    }),
                  ]}
                >
                  <Input.Password
                    prefix={<LockOutlined className="text-gray-400" />}
                    placeholder="Confirm New Password"
                    size="large"
                  />
                </Form.Item>

                <PasswordRequirements password={password} />

                <Form.Item>
                  <Button
                    type="primary"
                    htmlType="submit"
                    loading={loading}
                    block
                    size="large"
                    className="bg-gradient-to-r from-blue-600 to-indigo-600 border-none"
                  >
                    Reset Password
                  </Button>
                </Form.Item>
              </Form>
            )}
          </Space>
        </Card>
      </div>
    </div>
  );
}

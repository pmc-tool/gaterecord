import { useNavigate, Link } from 'react-router-dom';
import { Form, Input, Button, Card, Typography, Alert, Space, Table, Tag } from 'antd';
import { UserOutlined, LockOutlined, LoginOutlined } from '@ant-design/icons';
import { useAuthStore } from '../../store/authStore';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';

const { Title, Text } = Typography;

const demoCredentials = [
  {
    key: '1',
    role: 'Super Admin',
    email: 'admin@gatemanagement.com',
    password: 'Admin123!',
    color: 'red',
  },
  {
    key: '2',
    role: 'Building Admin',
    email: 'admin@building1.com',
    password: 'Building123!',
    color: 'blue',
  },
  {
    key: '3',
    role: 'Security',
    email: 'security@building1.com',
    password: 'Security123!',
    color: 'orange',
  },
  {
    key: '4',
    role: 'Resident',
    email: 'john.doe@building1.com',
    password: 'Resident123!',
    color: 'green',
  },
];

export function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading, error, clearError } = useAuthStore();
  const [form] = Form.useForm();

  const handleSubmit = async (values: { email: string; password: string }) => {
    try {
      await login(values);
      navigate('/dashboard');
    } catch {
      // Error is handled in store
    }
  };

  const handleAutoFill = (email: string, password: string) => {
    form.setFieldsValue({ email, password });
  };

  const columns = [
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      render: (role: string, record: typeof demoCredentials[0]) => (
        <Tag color={record.color}>{role}</Tag>
      ),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      render: (email: string) => (
        <span className="font-mono text-xs">{email}</span>
      ),
    },
    {
      title: 'Password',
      dataIndex: 'password',
      key: 'password',
      render: (password: string) => (
        <span className="font-mono text-xs">{password}</span>
      ),
    },
    {
      title: '',
      key: 'action',
      width: 80,
      render: (_: unknown, record: typeof demoCredentials[0]) => (
        <Button
          type="primary"
          size="small"
          icon={<LoginOutlined />}
          onClick={() => handleAutoFill(record.email, record.password)}
        >
          Use
        </Button>
      ),
    },
  ];

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="w-full max-w-md flex flex-col lg:flex-row gap-6">
        {/* Login Form */}
        <Card className="flex-1 shadow-xl">
          <Space direction="vertical" size="large" className="w-full">
            <div className="text-center">
              <Link to="/" className="inline-flex items-center gap-2 mb-4">
                <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl flex items-center justify-center">
                  <ShieldCheckIcon className="w-7 h-7 text-white" />
                </div>
              </Link>
              <Title level={2} className="mb-2">
                Welcome Back
              </Title>
              <Text type="secondary">Sign in to Yaad</Text>
            </div>

            {error && (
              <Alert
                message="Login Failed"
                description={error}
                type="error"
                showIcon
                closable
                onClose={clearError}
              />
            )}

            <Form
              form={form}
              layout="vertical"
              onFinish={handleSubmit}
              autoComplete="off"
            >
              <Form.Item
                name="email"
                rules={[
                  { required: true, message: 'Please enter your email' },
                  { type: 'email', message: 'Please enter a valid email' },
                ]}
              >
                <Input
                  prefix={<UserOutlined />}
                  placeholder="Email"
                  size="large"
                />
              </Form.Item>

              <Form.Item
                name="password"
                rules={[
                  { required: true, message: 'Please enter your password' },
                  { min: 8, message: 'Password must be at least 8 characters' },
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder="Password"
                  size="large"
                />
              </Form.Item>

              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={isLoading}
                  block
                  size="large"
                  className="bg-gradient-to-r from-blue-600 to-indigo-600 border-none"
                >
                  Sign In
                </Button>
              </Form.Item>
            </Form>

            <div className="text-center space-y-2">
              <div>
                <Link to="/forgot-password" className="text-blue-600 hover:text-blue-700">
                  Forgot Password?
                </Link>
              </div>
              <div>
                <Link to="/" className="text-gray-500 hover:text-gray-700">
                  ← Back to Home
                </Link>
              </div>
            </div>
          </Space>
        </Card>

        {/* Demo Credentials Table - Hidden
        <Card
          className="flex-1 shadow-xl"
          title={
            <div className="flex items-center gap-2">
              <span className="text-lg">Demo Credentials</span>
              <Tag color="blue">Click to auto-fill</Tag>
            </div>
          }
        >
          <Table
            dataSource={demoCredentials}
            columns={columns}
            pagination={false}
            size="small"
            rowClassName="cursor-pointer hover:bg-blue-50"
            onRow={(record) => ({
              onClick: () => handleAutoFill(record.email, record.password),
            })}
          />
          <div className="mt-4 p-3 bg-amber-50 rounded-lg border border-amber-200">
            <Text type="secondary" className="text-xs">
              💡 <strong>Tip:</strong> Click any row or the "Use" button to auto-fill credentials
            </Text>
          </div>
        </Card>
        */}
      </div>
    </div>
  );
}

export default LoginPage;

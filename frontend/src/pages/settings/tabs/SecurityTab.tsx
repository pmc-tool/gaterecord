import { useState } from 'react';
import {
  Card,
  Form,
  Input,
  Button,
  Typography,
  message,
  Space,
  Alert,
  Divider,
} from 'antd';
import {
  LockOutlined,
  KeyOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { settingsService, ChangePasswordData } from '../../../services/settings.service';

const { Title, Text, Paragraph } = Typography;

interface PasswordRequirement {
  label: string;
  regex: RegExp;
  met: boolean;
}

export default function SecurityTab() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  const passwordRequirements: PasswordRequirement[] = [
    { label: 'At least 8 characters', regex: /.{8,}/, met: newPassword.length >= 8 },
    { label: 'One uppercase letter', regex: /[A-Z]/, met: /[A-Z]/.test(newPassword) },
    { label: 'One lowercase letter', regex: /[a-z]/, met: /[a-z]/.test(newPassword) },
    { label: 'One number', regex: /\d/, met: /\d/.test(newPassword) },
    { label: 'One special character (@$!%*?&)', regex: /[@$!%*?&]/, met: /[@$!%*?&]/.test(newPassword) },
  ];

  const handleChangePassword = async (values: ChangePasswordData) => {
    try {
      setLoading(true);
      const result = await settingsService.changePassword(values);
      message.success(result.message);
      form.resetFields();
      setNewPassword('');
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      message.error(err.response?.data?.message || 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="shadow-sm">
      <div className="mb-6">
        <Title level={4} className="!mb-2">
          Change Password
        </Title>
        <Paragraph type="secondary">
          Secure your account with a strong password and two-factor authentication.
        </Paragraph>
      </div>

      <Form
        form={form}
        layout="vertical"
        onFinish={handleChangePassword}
        className="max-w-xl"
        autoComplete="off"
      >
        {/* Hidden fields to capture browser autofill */}
        <input type="text" name="fakeusernameremembered" style={{ display: 'none' }} />
        <input type="password" name="fakepasswordremembered" style={{ display: 'none' }} />
        
        <Form.Item
          name="currentPassword"
          label={
            <span className="font-medium">
              Current Password <span className="text-red-500">*</span>
            </span>
          }
          extra="Please enter your existing password for verification."
          rules={[{ required: true, message: 'Please enter your current password' }]}
        >
          <Input.Password
            prefix={<KeyOutlined className="text-gray-400" />}
            placeholder="Enter Current Password"
            size="large"
            autoComplete="off"
          />
        </Form.Item>

        <Form.Item
          name="newPassword"
          label={
            <span className="font-medium">
              New Password <span className="text-red-500">*</span>
            </span>
          }
          extra="Choose a strong password with at least 8 characters."
          rules={[
            { required: true, message: 'Please enter a new password' },
            { min: 8, message: 'Password must be at least 8 characters' },
            {
              pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
              message: 'Password must contain uppercase, lowercase, number and special character',
            },
          ]}
        >
          <Input.Password
            prefix={<LockOutlined className="text-gray-400" />}
            placeholder="Enter New Password"
            size="large"
            autoComplete="off"
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </Form.Item>

        <Form.Item
          name="confirmPassword"
          label={
            <span className="font-medium">
              Re-Enter Password <span className="text-red-500">*</span>
            </span>
          }
          extra="Confirm your new password by entering it again."
          dependencies={['newPassword']}
          rules={[
            { required: true, message: 'Please confirm your new password' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('newPassword') === value) {
                  return Promise.resolve();
                }
                return Promise.reject(new Error('Passwords do not match'));
              },
            }),
          ]}
        >
          <Input.Password
            prefix={<LockOutlined className="text-gray-400" />}
            placeholder="Re-Enter New Password"
            size="large"
            autoComplete="off"
          />
        </Form.Item>

        <Divider />

        {/* Password Requirements */}
        <Alert
          type="info"
          showIcon={false}
          className="mb-6"
          message={
            <div>
              <Text strong className="block mb-2">
                <CheckCircleOutlined className="mr-2" />
                Password Requirements
              </Text>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {passwordRequirements.map((req, index) => (
                  <Space key={index} size="small" className="flex-nowrap">
                    {req.met ? (
                      <CheckCircleOutlined className="text-green-500 flex-shrink-0" />
                    ) : (
                      <CloseCircleOutlined className="text-gray-400 flex-shrink-0" />
                    )}
                    <Text type={req.met ? undefined : 'secondary'}>{req.label}</Text>
                  </Space>
                ))}
              </div>
            </div>
          }
        />

        <Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            size="large"
            style={{
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              border: 'none',
            }}
          >
            Change Password
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}

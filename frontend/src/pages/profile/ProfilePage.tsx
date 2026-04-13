import { useState, useEffect, useRef } from 'react';
import {
  Card,
  Form,
  Input,
  Button,
  Avatar,
  message,
  Spin,
  Typography,
  Divider,
  Space,
  Tag,
  Row,
  Col,
} from 'antd';
import {
  UserOutlined,
  CameraOutlined,
  EditOutlined,
  SaveOutlined,
  MailOutlined,
  PhoneOutlined,
  IdcardOutlined,
  SafetyCertificateOutlined,
  HomeOutlined,
  ApartmentOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { profileService, UpdateProfileData } from '../../services/profile.service';
import { useAuthStore } from '../../store/authStore';
import { User } from '../../types';

const { Title, Text } = Typography;

// Role color mapping
const getRoleConfig = (role: string) => {
  const configs: Record<string, { color: string; bgColor: string; label: string }> = {
    super_admin: { color: '#531dab', bgColor: '#f9f0ff', label: 'Super Admin' },
    building_admin: { color: '#389e0d', bgColor: '#f6ffed', label: 'Building Admin' },
    security: { color: '#d46b08', bgColor: '#fff7e6', label: 'Security' },
    resident: { color: '#096dd9', bgColor: '#e6f7ff', label: 'Resident' },
    staff: { color: '#595959', bgColor: '#fafafa', label: 'Staff' },
  };
  return configs[role] || { color: '#595959', bgColor: '#fafafa', label: role };
};

// Status color mapping
const getStatusConfig = (status: string) => {
  const configs: Record<string, { color: string; label: string }> = {
    active: { color: 'success', label: 'Active' },
    inactive: { color: 'default', label: 'Inactive' },
    pending: { color: 'warning', label: 'Pending' },
  };
  return configs[status] || { color: 'default', label: status };
};

interface InfoItemProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}

const InfoItem = ({ icon, label, value }: InfoItemProps) => (
  <div className="flex items-start gap-3 p-4 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors">
    <div className="text-blue-500 text-lg mt-0.5">{icon}</div>
    <div className="flex-1 min-w-0">
      <Text type="secondary" className="text-xs uppercase tracking-wide block mb-1">
        {label}
      </Text>
      <Text strong className="text-base block truncate">
        {value || '-'}
      </Text>
    </div>
  </div>
);

export default function ProfilePage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [profile, setProfile] = useState<User | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [form] = Form.useForm();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { setUser, user } = useAuthStore();

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const data = await profileService.getProfile();
      setProfile(data);
      form.setFieldsValue({
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone || '',
      });
    } catch (error) {
      message.error('Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (values: UpdateProfileData) => {
    try {
      setSaving(true);
      const updatedProfile = await profileService.updateProfile(values);
      setProfile(updatedProfile);
      setIsEditing(false);
      message.success('Profile updated successfully');

      // Update auth store user
      if (user) {
        setUser({
          ...user,
          firstName: updatedProfile.firstName,
          lastName: updatedProfile.lastName,
          phone: updatedProfile.phone,
        });
      }
    } catch (error) {
      message.error('Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleImageUpload = async (file: File) => {
    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      message.error('Only JPEG, PNG, GIF and WebP images are allowed');
      return false;
    }

    // Validate file size (5MB)
    if (file.size > 5 * 1024 * 1024) {
      message.error('Image size must be less than 5MB');
      return false;
    }

    try {
      setUploading(true);
      const result = await profileService.uploadProfileImage(file);
      setProfile((prev) => (prev ? { ...prev, profileImageUrl: result.profileImageUrl } : null));
      message.success('Profile image updated successfully');

      // Update auth store user
      if (user) {
        setUser({
          ...user,
          profileImageUrl: result.profileImageUrl,
        });
      }
    } catch (error) {
      message.error('Failed to upload image');
    } finally {
      setUploading(false);
    }

    return false; // Prevent default upload behavior
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImageUpload(file);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  const roleConfig = getRoleConfig(profile?.role || '');
  const statusConfig = getStatusConfig(profile?.status || '');

  return (
    <div className="max-w-4xl mx-auto">
      {/* Profile Header Card */}
      <Card
        className="mb-6 overflow-hidden"
        styles={{
          body: { padding: 0 },
        }}
      >
        {/* Banner Background */}
        <div
          className="h-32 relative"
          style={{
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          }}
        />

        {/* Profile Content */}
        <div className="px-6 pb-6">
          <div className="flex flex-col md:flex-row items-center md:items-end gap-4 -mt-16 relative">
            {/* Avatar Section */}
            <div className="relative">
              <Avatar
                size={130}
                src={profile?.profileImageUrl}
                icon={!profile?.profileImageUrl && <UserOutlined />}
                className="border-4 border-white shadow-lg"
                style={{ backgroundColor: '#e6f4ff' }}
              />
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="image/jpeg,image/png,image/gif,image/webp"
                style={{ display: 'none' }}
              />
              <Button
                type="primary"
                shape="circle"
                icon={uploading ? <Spin size="small" /> : <CameraOutlined />}
                disabled={uploading}
                onClick={triggerFileInput}
                className="absolute bottom-2 right-2 shadow-lg"
                size="middle"
                style={{
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  border: 'none',
                }}
              />
            </div>

            {/* User Info */}
            <div className="flex-1 text-center md:text-left md:pb-2">
              <Title level={2} className="!mb-1 !mt-2">
                {profile?.firstName} {profile?.lastName}
              </Title>
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 mt-2">
                <Tag
                  style={{
                    backgroundColor: roleConfig.bgColor,
                    color: roleConfig.color,
                    border: `1px solid ${roleConfig.color}30`,
                    fontWeight: 500,
                  }}
                >
                  {roleConfig.label}
                </Tag>
                <Tag color={statusConfig.color}>{statusConfig.label}</Tag>
              </div>
            </div>

            {/* Edit Button */}
            {!isEditing && (
              <Button
                type="primary"
                icon={<EditOutlined />}
                onClick={() => setIsEditing(true)}
                size="large"
                style={{
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  border: 'none',
                }}
              >
                Edit Profile
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Profile Information Card */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <IdcardOutlined className="text-blue-500" />
            <span>Profile Information</span>
          </div>
        }
        className="shadow-sm"
      >
        {isEditing ? (
          <Form form={form} layout="vertical" onFinish={handleSave}>
            <Row gutter={[24, 0]}>
              <Col xs={24} md={12}>
                <Form.Item
                  name="firstName"
                  label="First Name"
                  rules={[{ required: true, message: 'First name is required' }]}
                >
                  <Input
                    prefix={<UserOutlined className="text-gray-400" />}
                    placeholder="Enter first name"
                    size="large"
                  />
                </Form.Item>
              </Col>

              <Col xs={24} md={12}>
                <Form.Item
                  name="lastName"
                  label="Last Name"
                  rules={[{ required: true, message: 'Last name is required' }]}
                >
                  <Input
                    prefix={<UserOutlined className="text-gray-400" />}
                    placeholder="Enter last name"
                    size="large"
                  />
                </Form.Item>
              </Col>

              <Col xs={24} md={12}>
                <Form.Item name="phone" label="Phone Number">
                  <Input
                    prefix={<PhoneOutlined className="text-gray-400" />}
                    placeholder="Enter phone number"
                    size="large"
                  />
                </Form.Item>
              </Col>
            </Row>

            <Divider />

            <Space size="middle">
              <Button
                type="primary"
                htmlType="submit"
                loading={saving}
                icon={<SaveOutlined />}
                size="large"
                style={{
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  border: 'none',
                }}
              >
                Save Changes
              </Button>
              <Button
                size="large"
                icon={<CloseOutlined />}
                onClick={() => {
                  setIsEditing(false);
                  form.setFieldsValue({
                    firstName: profile?.firstName,
                    lastName: profile?.lastName,
                    phone: profile?.phone || '',
                  });
                }}
              >
                Cancel
              </Button>
            </Space>
          </Form>
        ) : (
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12}>
              <InfoItem
                icon={<UserOutlined />}
                label="First Name"
                value={profile?.firstName}
              />
            </Col>
            <Col xs={24} sm={12}>
              <InfoItem
                icon={<UserOutlined />}
                label="Last Name"
                value={profile?.lastName}
              />
            </Col>
            <Col xs={24} sm={12}>
              <InfoItem
                icon={<MailOutlined />}
                label="Email Address"
                value={profile?.email}
              />
            </Col>
            <Col xs={24} sm={12}>
              <InfoItem
                icon={<PhoneOutlined />}
                label="Phone Number"
                value={profile?.phone}
              />
            </Col>
            <Col xs={24} sm={12}>
              <InfoItem
                icon={<SafetyCertificateOutlined />}
                label="Role"
                value={
                  <Tag
                    style={{
                      backgroundColor: roleConfig.bgColor,
                      color: roleConfig.color,
                      border: `1px solid ${roleConfig.color}30`,
                      fontWeight: 500,
                      margin: 0,
                    }}
                  >
                    {roleConfig.label}
                  </Tag>
                }
              />
            </Col>
            <Col xs={24} sm={12}>
              <InfoItem
                icon={<IdcardOutlined />}
                label="Account Status"
                value={<Tag color={statusConfig.color}>{statusConfig.label}</Tag>}
              />
            </Col>
            {profile?.tenant && (
              <Col xs={24} sm={12}>
                <InfoItem
                  icon={<HomeOutlined />}
                  label="Building"
                  value={profile.tenant.name}
                />
              </Col>
            )}
            {profile?.unit && (
              <Col xs={24} sm={12}>
                <InfoItem
                  icon={<ApartmentOutlined />}
                  label="Unit"
                  value={profile.unit}
                />
              </Col>
            )}
          </Row>
        )}
      </Card>
    </div>
  );
}

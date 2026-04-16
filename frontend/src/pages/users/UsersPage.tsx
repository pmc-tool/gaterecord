import { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  message,
  Popconfirm,
  Tooltip,
  Row,
  Col,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  UserOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import api from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { UserRole } from '../../types';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: 'active' | 'inactive' | 'pending';
  tenantId?: string;
  tenant?: { name: string };
  createdAt: string;
}

const roleColors: Record<string, string> = {
  super_admin: 'red',
  building_admin: 'blue',
  security: 'orange',
  resident: 'green',
};

const roleLabels: Record<string, string> = {
  super_admin: 'Super Admin',
  building_admin: 'Building Admin',
  security: 'Security',
  resident: 'Resident',
};

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [form] = Form.useForm();
  const { user: currentUser } = useAuthStore();
  const isSuperAdmin = currentUser?.role === UserRole.SUPER_ADMIN;
  const [filters, setFilters] = useState({
    search: undefined as string | undefined,
    tenantId: undefined as string | undefined,
    role: undefined as string | undefined,
    status: undefined as string | undefined,
  });

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.append('search', filters.search);
      if (filters.tenantId) params.append('tenantId', filters.tenantId);
      if (filters.role) params.append('role', filters.role);
      if (filters.status) params.append('status', filters.status);

      const response = await api.get(`/users?${params.toString()}`);
      setUsers(response.data);
    } catch (error) {
      message.error('Failed to fetch users');
    } finally {
      setLoading(false);
    }
  };

  const fetchTenants = async () => {
    try {
      const response = await api.get('/admin/tenants');
      setTenants(response.data.data || response.data);
    } catch (error) {
      console.error('Failed to fetch tenants');
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchTenants();
  }, []);

  const handleCreate = () => {
    setEditingUser(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (user: User) => {
    setEditingUser(user);
    form.setFieldsValue({
      ...user,
      password: undefined,
    });
    setModalVisible(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/users/${id}`);
      message.success('User deleted successfully');
      fetchUsers();
    } catch (error) {
      message.error('Failed to delete user');
    }
  };

  const handleSubmit = async (values: Partial<User> & { password?: string }) => {
    try {
      // Clean up empty password - don't send if empty (backend will generate temporary)
      const payload = { ...values };
      if (!payload.password || payload.password.trim() === '') {
        delete payload.password;
      }

      // For building admins, add their tenantId
      if (!isSuperAdmin && currentUser?.tenantId) {
        payload.tenantId = currentUser.tenantId;
      }

      if (editingUser) {
        await api.patch(`/users/${editingUser.id}`, payload);
        message.success('User updated successfully');
      } else {
        await api.post('/users', payload);
        message.success(payload.password 
          ? 'User created successfully. Welcome email sent.' 
          : 'User created successfully. Temporary password sent via email.');
      }
      setModalVisible(false);
      fetchUsers();
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { message?: string | string[] } } };
      const errorMsg = err.response?.data?.message || err.message || 'Failed to save user';
      message.error(Array.isArray(errorMsg) ? errorMsg.join(', ') : String(errorMsg));
    }
  };

  const columns: ColumnsType<User> = [
    {
      title: 'Name',
      key: 'name',
      render: (_, record) => (
        <Space>
          <UserOutlined />
          {record.firstName} {record.lastName}
        </Space>
      ),
      sorter: (a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      render: (role: string) => (
        <Tag color={roleColors[role]}>{roleLabels[role] || role}</Tag>
      ),
    },
    {
      title: 'Building',
      dataIndex: ['tenant', 'name'],
      key: 'tenant',
      render: (name: string) => name || <span className="text-gray-400">-</span>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const statusColors: Record<string, string> = {
          active: 'success',
          inactive: 'default',
          pending: 'warning',
        };
        const statusLabels: Record<string, string> = {
          active: 'Active',
          inactive: 'Inactive',
          pending: 'Pending',
        };
        return <Tag color={statusColors[status] || 'default'}>{statusLabels[status] || status}</Tag>;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Tooltip title="Edit">
            <Button icon={<EditOutlined />} size="small" onClick={() => handleEdit(record)} />
          </Tooltip>
          {record.id !== currentUser?.id && (
            <Popconfirm
              title="Delete this user?"
              onConfirm={() => handleDelete(record.id)}
              okText="Yes"
              cancelText="No"
            >
              <Tooltip title="Delete">
                <Button icon={<DeleteOutlined />} size="small" danger />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const availableRoles =
    currentUser?.role === 'super_admin'
      ? ['super_admin', 'building_admin', 'security', 'resident']
      : ['security', 'resident'];

  return (
    <div>
      <Card
        title="Users Management"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchUsers}>
              Refresh
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              Add User
            </Button>
          </Space>
        }
      >
        <div className="mb-4">
          <Row gutter={[16, 16]} align="middle">
            <Col>
              <Input
                placeholder="Search name or email"
                allowClear
                style={{ width: 200 }}
                prefix={<SearchOutlined />}
                value={filters.search}
                onChange={(e) => setFilters({ ...filters, search: e.target.value || undefined })}
              />
            </Col>
            {isSuperAdmin && (
              <Col>
                <Select
                  placeholder="Select Tenant"
                  allowClear
                  style={{ width: 200 }}
                  value={filters.tenantId}
                  onChange={(value) => setFilters({ ...filters, tenantId: value })}
                  options={tenants.map(t => ({ value: t.id, label: t.name }))}
                />
              </Col>
            )}
            <Col>
              <Select
                placeholder="Role"
                allowClear
                style={{ width: 150 }}
                value={filters.role}
                onChange={(value) => setFilters({ ...filters, role: value })}
              >
                <Select.Option value="super_admin">Super Admin</Select.Option>
                <Select.Option value="building_admin">Building Admin</Select.Option>
                <Select.Option value="security">Security</Select.Option>
                <Select.Option value="resident">Resident</Select.Option>
              </Select>
            </Col>
            <Col>
              <Select
                placeholder="Status"
                allowClear
                style={{ width: 120 }}
                value={filters.status}
                onChange={(value) => setFilters({ ...filters, status: value })}
              >
                <Select.Option value="active">Active</Select.Option>
                <Select.Option value="inactive">Inactive</Select.Option>
                <Select.Option value="pending">Pending</Select.Option>
              </Select>
            </Col>
            <Col>
              <Space>
                <Button type="primary" onClick={fetchUsers}>
                  Apply
                </Button>
                <Button onClick={() => {
                  setFilters({
                    search: undefined,
                    tenantId: undefined,
                    role: undefined,
                    status: undefined,
                  });
                  fetchUsers();
                }}>
                  Reset
                </Button>
              </Space>
            </Col>
          </Row>
        </div>

        <Table
          columns={columns}
          dataSource={users}
          rowKey="id"
          loading={loading}
          scroll={{ x: 800 }}
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} users`,
          }}
        />
      </Card>

      <Modal
        title={editingUser ? 'Edit User' : 'Add User'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <div className="grid grid-cols-2 gap-4">
            <Form.Item
              name="firstName"
              label="First Name"
              rules={[{ required: true, message: 'Please enter first name' }]}
            >
              <Input placeholder="First name" />
            </Form.Item>

            <Form.Item
              name="lastName"
              label="Last Name"
              rules={[{ required: true, message: 'Please enter last name' }]}
            >
              <Input placeholder="Last name" />
            </Form.Item>
          </div>

          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: 'Please enter email' },
              { type: 'email', message: 'Please enter a valid email' },
            ]}
          >
            <Input placeholder="email@example.com" />
          </Form.Item>

          <Form.Item
            name="password"
            label={editingUser ? 'New Password (leave blank to keep current)' : 'Password (optional)'}
            rules={[
              { min: 8, message: 'Password must be at least 8 characters' },
            ]}
            extra={!editingUser ? 'Leave empty to auto-generate and email a temporary password to user' : undefined}
          >
            <Input.Password placeholder={editingUser ? 'Leave blank to keep current' : 'Enter password or leave empty for auto-generated'} />
          </Form.Item>

          <Form.Item
            name="role"
            label="Role"
            rules={[{ required: true, message: 'Please select role' }]}
          >
            <Select placeholder="Select role">
              {availableRoles.map((role) => (
                <Select.Option key={role} value={role}>
                  {roleLabels[role]}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          {isSuperAdmin ? (
            <Form.Item name="tenantId" label="Building (optional for Super Admin)">
              <Select placeholder="Select building" allowClear>
                {tenants.map((tenant) => (
                  <Select.Option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          ) : (
            <Form.Item label="Building">
              <Input value={currentUser?.tenant?.name || 'Your Building'} disabled />
            </Form.Item>
          )}

          <Form.Item name="status" label="Status" initialValue="active">
            <Select>
              <Select.Option value="active">Active</Select.Option>
              <Select.Option value="inactive">Inactive</Select.Option>
              <Select.Option value="pending">Pending</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item className="mb-0 text-right">
            <Space>
              <Button onClick={() => setModalVisible(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit">
                {editingUser ? 'Update' : 'Create'}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

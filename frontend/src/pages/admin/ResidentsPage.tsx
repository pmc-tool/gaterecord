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
  Badge,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  UserOutlined,
  CarOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import api from '../../services/api';

interface Resident {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  unit: string;
  status: string;
  tenantId: string;
  tenant?: { name: string };
  vehicles?: { id: string; licensePlate: string }[];
  rfidCards?: { id: string; uid: string }[];
}

export default function ResidentsPage() {
  const [residents, setResidents] = useState<Resident[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingResident, setEditingResident] = useState<Resident | null>(null);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [form] = Form.useForm();

  const fetchResidents = async () => {
    setLoading(true);
    try {
      const response = await api.get('/residents');
      setResidents(response.data);
    } catch (error) {
      message.error('Failed to fetch residents');
    } finally {
      setLoading(false);
    }
  };

  const fetchTenants = async () => {
    try {
      const response = await api.get('/admin/tenants');
      setTenants(response.data);
    } catch (error) {
      console.error('Failed to fetch tenants');
    }
  };

  useEffect(() => {
    fetchResidents();
    fetchTenants();
  }, []);

  const handleCreate = () => {
    setEditingResident(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (resident: Resident) => {
    setEditingResident(resident);
    form.setFieldsValue({
      ...resident,
      isActive: resident.status === 'active',
    });
    setModalVisible(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/residents/${id}`);
      message.success('Resident deleted successfully');
      fetchResidents();
    } catch (error) {
      message.error('Failed to delete resident');
    }
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    try {
      if (editingResident) {
        await api.patch(`/residents/${editingResident.id}`, values);
        message.success('Resident updated successfully');
      } else {
        await api.post('/residents', values);
        message.success('Resident created successfully');
      }
      setModalVisible(false);
      fetchResidents();
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      message.error(err.response?.data?.message || 'Failed to save resident');
    }
  };

  const columns: ColumnsType<Resident> = [
    {
      title: 'Name',
      key: 'name',
      render: (_, record) => (
        <Space>
          <UserOutlined />
          <span className="font-medium">
            {record.firstName} {record.lastName}
          </span>
        </Space>
      ),
      sorter: (a, b) =>
        `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
    },
    {
      title: 'Unit',
      dataIndex: 'unit',
      key: 'unit',
      render: (unit: string) => <Tag>{unit}</Tag>,
    },
    {
      title: 'Building',
      dataIndex: ['tenant', 'name'],
      key: 'tenant',
    },
    {
      title: 'Contact',
      key: 'contact',
      render: (_, record) => (
        <div className="text-sm">
          {record.email && <div>{record.email}</div>}
          {record.phone && <div className="text-gray-500">{record.phone}</div>}
        </div>
      ),
    },
    {
      title: 'Vehicles',
      key: 'vehicles',
      render: (_, record) => (
        <Space>
          <CarOutlined />
          <Badge count={record.vehicles?.length || 0} showZero />
        </Space>
      ),
    },
    {
      title: 'Access Cards',
      key: 'accessCards',
      render: (_, record) => <Badge count={record.rfidCards?.length || 0} showZero />,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={status === 'active' ? 'success' : 'default'}>
          {status === 'active' ? 'Active' : 'Inactive'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Tooltip title="Edit">
            <Button icon={<EditOutlined />} size="small" onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm
            title="Delete this resident?"
            onConfirm={() => handleDelete(record.id)}
            okText="Yes"
            cancelText="No"
          >
            <Tooltip title="Delete">
              <Button icon={<DeleteOutlined />} size="small" danger />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card
        title="Residents Management"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchResidents}>
              Refresh
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              Add Resident
            </Button>
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={residents}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Modal
        title={editingResident ? 'Edit Resident' : 'Add Resident'}
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
            name="unit"
            label="Unit Number"
            rules={[{ required: true, message: 'Please enter unit number' }]}
          >
            <Input placeholder="e.g., A-101" />
          </Form.Item>

          <Form.Item
            name="tenantId"
            label="Building"
            rules={[{ required: true, message: 'Please select building' }]}
          >
            <Select placeholder="Select building">
              {tenants.map((tenant) => (
                <Select.Option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

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

          {!editingResident && (
            <Form.Item name="password" label="Password (optional, default: Resident123!)">
              <Input.Password placeholder="Leave blank for default password" />
            </Form.Item>
          )}

          <Form.Item name="phone" label="Phone">
            <Input placeholder="+1 234 567 8900" />
          </Form.Item>

          <Form.Item name="isActive" label="Status" initialValue={true}>
            <Select>
              <Select.Option value={true}>Active</Select.Option>
              <Select.Option value={false}>Inactive</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item className="mb-0 text-right">
            <Space>
              <Button onClick={() => setModalVisible(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit">
                {editingResident ? 'Update' : 'Create'}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

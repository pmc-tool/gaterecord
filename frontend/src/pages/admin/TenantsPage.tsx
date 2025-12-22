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
  message,
  Popconfirm,
  Tooltip,
  Descriptions,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  HomeOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import api from '../../services/api';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  address?: string;
  contactEmail?: string;
  contactPhone?: string;
  status: 'active' | 'suspended' | 'trial';
  createdAt: string;
  _count?: {
    users: number;
    gates: number;
    residents: number;
  };
}

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [form] = Form.useForm();

  const fetchTenants = async () => {
    setLoading(true);
    try {
      const response = await api.get('/admin/tenants');
      setTenants(response.data);
    } catch (error) {
      message.error('Failed to fetch tenants');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, []);

  const handleCreate = () => {
    setEditingTenant(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (tenant: Tenant) => {
    setEditingTenant(tenant);
    form.setFieldsValue(tenant);
    setModalVisible(true);
  };

  const handleView = (tenant: Tenant) => {
    setSelectedTenant(tenant);
    setDetailModalVisible(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/admin/tenants/${id}`);
      message.success('Tenant deleted successfully');
      fetchTenants();
    } catch (error) {
      message.error('Failed to delete tenant');
    }
  };

  const handleSubmit = async (values: Partial<Tenant>) => {
    try {
      if (editingTenant) {
        await api.patch(`/admin/tenants/${editingTenant.id}`, values);
        message.success('Tenant updated successfully');
      } else {
        await api.post('/admin/tenants', values);
        message.success('Tenant created successfully');
      }
      setModalVisible(false);
      fetchTenants();
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      message.error(err.response?.data?.message || 'Failed to save tenant');
    }
  };

  const columns: ColumnsType<Tenant> = [
    {
      title: 'Building',
      key: 'name',
      render: (_, record) => (
        <Space>
          <HomeOutlined />
          <span className="font-medium">{record.name}</span>
        </Space>
      ),
      sorter: (a, b) => a.name.localeCompare(b.name),
    },
    {
      title: 'Slug',
      dataIndex: 'slug',
      key: 'slug',
      render: (slug: string) => <code className="text-xs bg-gray-100 px-2 py-1 rounded">{slug}</code>,
    },
    {
      title: 'Address',
      dataIndex: 'address',
      key: 'address',
      render: (address: string) => address || <span className="text-gray-400">-</span>,
    },
    {
      title: 'Contact',
      dataIndex: 'contactEmail',
      key: 'contactEmail',
      render: (email: string) => email || <span className="text-gray-400">-</span>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const statusColors: Record<string, string> = {
          active: 'success',
          suspended: 'error',
          trial: 'warning',
        };
        const statusLabels: Record<string, string> = {
          active: 'Active',
          suspended: 'Suspended',
          trial: 'Trial',
        };
        return <Tag color={statusColors[status] || 'default'}>{statusLabels[status] || status}</Tag>;
      },
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => dayjs(date).format('YYYY-MM-DD'),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Tooltip title="View Details">
            <Button icon={<EyeOutlined />} size="small" onClick={() => handleView(record)} />
          </Tooltip>
          <Tooltip title="Edit">
            <Button icon={<EditOutlined />} size="small" onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm
            title="Delete this building?"
            description="This will also delete all associated data."
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
        title="Buildings / Tenants"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchTenants}>
              Refresh
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              Add Building
            </Button>
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={tenants}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Modal
        title={editingTenant ? 'Edit Building' : 'Add Building'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            name="name"
            label="Building Name"
            rules={[{ required: true, message: 'Please enter building name' }]}
          >
            <Input placeholder="e.g., Sunset Apartments" />
          </Form.Item>

          <Form.Item
            name="slug"
            label="Slug (URL-friendly identifier)"
            rules={[
              { required: true, message: 'Please enter slug' },
              { pattern: /^[a-z0-9-]+$/, message: 'Only lowercase letters, numbers, and hyphens' },
            ]}
          >
            <Input placeholder="e.g., sunset-apartments" />
          </Form.Item>

          <Form.Item name="address" label="Address">
            <Input.TextArea placeholder="Full address" rows={2} />
          </Form.Item>

          <Form.Item
            name="contactEmail"
            label="Contact Email"
            rules={[{ type: 'email', message: 'Please enter a valid email' }]}
          >
            <Input placeholder="contact@example.com" />
          </Form.Item>

          <Form.Item name="contactPhone" label="Contact Phone">
            <Input placeholder="+1 234 567 8900" />
          </Form.Item>

          <Form.Item className="mb-0 text-right">
            <Space>
              <Button onClick={() => setModalVisible(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit">
                {editingTenant ? 'Update' : 'Create'}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Building Details"
        open={detailModalVisible}
        onCancel={() => setDetailModalVisible(false)}
        footer={[
          <Button key="close" onClick={() => setDetailModalVisible(false)}>
            Close
          </Button>,
        ]}
      >
        {selectedTenant && (
          <Descriptions column={1} bordered>
            <Descriptions.Item label="Name">{selectedTenant.name}</Descriptions.Item>
            <Descriptions.Item label="Slug">{selectedTenant.slug}</Descriptions.Item>
            <Descriptions.Item label="Address">
              {selectedTenant.address || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Contact Email">
              {selectedTenant.contactEmail || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Contact Phone">
              {selectedTenant.contactPhone || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag color={
                selectedTenant.status === 'active' ? 'success' :
                selectedTenant.status === 'trial' ? 'warning' : 'error'
              }>
                {selectedTenant.status === 'active' ? 'Active' :
                 selectedTenant.status === 'trial' ? 'Trial' : 'Suspended'}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Created">
              {dayjs(selectedTenant.createdAt).format('YYYY-MM-DD HH:mm')}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  );
}

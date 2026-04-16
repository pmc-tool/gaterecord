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
  Divider,
  message,
  Popconfirm,
  Tooltip,
  Descriptions,
  Row,
  Col,
  DatePicker,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  HomeOutlined,
  EyeOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import api from '../../services/api';

interface SubscriptionPlan {
  id: string;
  name: string;
  description?: string;
  monthlyPrice: number;
  maxGates: number;
  maxUsers: number;
}

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
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [plansLoading, setPlansLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [form] = Form.useForm();
  const [searchText, setSearchText] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [startDate, setStartDate] = useState<dayjs.Dayjs | null>(null);
  const [endDate, setEndDate] = useState<dayjs.Dayjs | null>(null);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0 });

  const fetchTenants = async (page = 1, limit = 10, search?: string, status?: string, start?: string, end?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('page', String(page));
      params.append('limit', String(limit));
      if (search) params.append('search', search);
      if (status) params.append('status', status);
      if (start) params.append('startDate', start);
      if (end) params.append('endDate', end);
      const response = await api.get(`/admin/tenants?${params.toString()}`);
      setTenants(response.data.data);
      setPagination({ page: response.data.page, limit: response.data.limit, total: response.data.total });
    } catch (error) {
      message.error('Failed to fetch tenants');
    } finally {
      setLoading(false);
    }
  };

  const fetchPlans = async () => {
    setPlansLoading(true);
    try {
      const response = await api.get('/auth/plans');
      setPlans(response.data);
    } catch (error) {
      message.error('Failed to fetch subscription plans');
    } finally {
      setPlansLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
    fetchPlans();
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
      fetchTenants(pagination.page, pagination.limit, searchText, statusFilter, startDate?.format('YYYY-MM-DD'), endDate?.format('YYYY-MM-DD'));
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
      fetchTenants(pagination.page, pagination.limit, searchText, statusFilter, startDate?.format('YYYY-MM-DD'), endDate?.format('YYYY-MM-DD'));
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
            <Button icon={<ReloadOutlined />} onClick={() => fetchTenants(pagination.page, pagination.limit, searchText, statusFilter, startDate?.format('YYYY-MM-DD'), endDate?.format('YYYY-MM-DD'))}>
              Refresh
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              Add Building
            </Button>
          </Space>
        }
      >
        <div className="mb-4 p-4 bg-gray-50 rounded-lg">
          <Row gutter={16} align="middle">
            <Col>
              <Input
                placeholder="Search name, slug, email"
                allowClear
                className="w-52"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
            </Col>
            <Col>
              <Select
                placeholder="Status"
                allowClear
                className="w-36"
                value={statusFilter}
                onChange={(value) => setStatusFilter(value)}
                options={[
                  { label: 'Active', value: 'active' },
                  { label: 'Suspended', value: 'suspended' },
                  { label: 'Trial', value: 'trial' },
                ]}
              />
            </Col>
            <Col>
              <DatePicker
                placeholder="Start Date"
                value={startDate}
                onChange={(date) => setStartDate(date)}
                allowClear
              />
            </Col>
            <Col>
              <DatePicker
                placeholder="End Date"
                value={endDate}
                onChange={(date) => setEndDate(date)}
                allowClear
              />
            </Col>
            <Col>
              <Space>
                <Button type="primary" onClick={() => fetchTenants(1, pagination.limit, searchText, statusFilter, startDate?.format('YYYY-MM-DD'), endDate?.format('YYYY-MM-DD'))}>
                  Apply
                </Button>
                <Button onClick={() => {
                  setSearchText('');
                  setStatusFilter(undefined);
                  setStartDate(null);
                  setEndDate(null);
                  fetchTenants(1, pagination.limit, undefined, undefined, undefined, undefined);
                }}>
                  Reset
                </Button>
              </Space>
            </Col>
          </Row>
        </div>
        <Table
          columns={columns}
          dataSource={tenants}
          rowKey="id"
          loading={loading}
          scroll={{ x: 900 }}
          pagination={{
            current: pagination.page,
            pageSize: pagination.limit,
            total: pagination.total,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} tenants`,
            onChange: (page, pageSize) => fetchTenants(page, pageSize, searchText, statusFilter, startDate?.format('YYYY-MM-DD'), endDate?.format('YYYY-MM-DD')),
          }}
        />
      </Card>

      <Modal
        title={editingTenant ? 'Edit Building' : 'Add Building'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        width={600}
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

          {/* Subscription Plan - only for creating new buildings */}
          {!editingTenant && (
            <>
              <Divider orientation="left">Subscription Plan</Divider>
              <Form.Item
                name="subscriptionPlanId"
                label="Select Plan"
                rules={[{ required: true, message: 'Please select a subscription plan' }]}
              >
                <Select
                  placeholder="Choose a subscription plan"
                  loading={plansLoading}
                  optionFilterProp="children"
                  showSearch
                >
                  {plans.map((plan) => (
                    <Select.Option key={plan.id} value={plan.id}>
                      {plan.name} - ${plan.monthlyPrice}/mo (Max {plan.maxGates} gates, {plan.maxUsers} users)
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>

              <Divider orientation="left">
                <Space>
                  <UserOutlined />
                  Building Admin Account
                </Space>
              </Divider>
              <Form.Item
                name="adminEmail"
                label="Admin Email"
                rules={[
                  { required: true, message: 'Please enter admin email' },
                  { type: 'email', message: 'Please enter a valid email' },
                ]}
              >
                <Input placeholder="admin@example.com" />
              </Form.Item>

              <Form.Item
                name="adminFirstName"
                label="Admin First Name"
                rules={[{ required: true, message: 'Please enter admin first name' }]}
              >
                <Input placeholder="John" />
              </Form.Item>

              <Form.Item
                name="adminLastName"
                label="Admin Last Name"
                rules={[{ required: true, message: 'Please enter admin last name' }]}
              >
                <Input placeholder="Doe" />
              </Form.Item>
            </>
          )}

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

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
  InputNumber,
  Switch,
  Select,
  Checkbox,
  DatePicker,
  message,
  Popconfirm,
  Tooltip,
  Tabs,
  Row,
  Col,
  Typography,
  Divider,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CrownOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  StarOutlined,
  GiftOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import api from '../../services/api';

const { Title, Text } = Typography;
const { TextArea } = Input;

interface SubscriptionPlan {
  id: string;
  name: string;
  description?: string;
  monthlyPrice: number;
  yearlyPrice: number;
  discountPercent: number;
  discountLabel?: string;
  discountValidUntil?: string;
  trialDays: number;
  trialRequiresCard: boolean;
  maxGates: number;
  maxUsers: number;
  maxVehicles: number;
  maxVisitorPassesPerMonth: number;
  logRetentionDays: number;
  features: {
    simulator_access?: boolean;
    csv_export?: boolean;
    api_access?: boolean;
    custom_branding?: boolean;
    priority_support?: boolean;
    advanced_analytics?: boolean;
    multi_building?: boolean;
    webhook_notifications?: boolean;
  };
  displayOrder: number;
  badge?: string;
  badgeColor?: string;
  isFeatured: boolean;
  isActive: boolean;
  isPublic: boolean;
  tenants?: { id: string }[];
  createdAt: string;
}

const badgeColors = [
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'gold', label: 'Gold' },
  { value: 'red', label: 'Red' },
  { value: 'purple', label: 'Purple' },
  { value: 'cyan', label: 'Cyan' },
];

export default function PlansManagementPage() {
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingPlan, setEditingPlan] = useState<SubscriptionPlan | null>(null);
  const [form] = Form.useForm();
  const [searchText, setSearchText] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0 });

  const fetchPlans = async (page = 1, limit = 10, status?: string, search?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('page', String(page));
      params.append('limit', String(limit));
      if (status) params.append('status', status);
      if (search) params.append('search', search);
      const response = await api.get(`/admin/plans?${params.toString()}`);
      setPlans(response.data.data);
      setPagination({ page: response.data.page, limit: response.data.limit, total: response.data.total });
    } catch (error) {
      message.error('Failed to fetch subscription plans');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlans();
  }, []);

  const handleCreate = () => {
    setEditingPlan(null);
    form.resetFields();
    form.setFieldsValue({
      isActive: true,
      isPublic: true,
      isFeatured: false,
      trialRequiresCard: false,
      discountPercent: 0,
      trialDays: 0,
      displayOrder: plans.length,
      maxVehicles: 100,
      maxVisitorPassesPerMonth: 50,
      features: {},
    });
    setModalVisible(true);
  };

  const handleEdit = (plan: SubscriptionPlan) => {
    setEditingPlan(plan);
    form.setFieldsValue({
      ...plan,
      discountValidUntil: plan.discountValidUntil ? dayjs(plan.discountValidUntil) : null,
    });
    setModalVisible(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/admin/plans/${id}`);
      message.success('Subscription plan deleted successfully');
      fetchPlans(pagination.page, pagination.limit, statusFilter, searchText);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      message.error(err.response?.data?.message || 'Failed to delete plan');
    }
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    try {
      const payload = {
        ...values,
        discountValidUntil: values.discountValidUntil
          ? (values.discountValidUntil as { toISOString: () => string }).toISOString()
          : null,
      };

      if (editingPlan) {
        await api.patch(`/admin/plans/${editingPlan.id}`, payload);
        message.success('Subscription plan updated successfully');
      } else {
        await api.post('/admin/plans', payload);
        message.success('Subscription plan created successfully');
      }
      setModalVisible(false);
      fetchPlans(pagination.page, pagination.limit, statusFilter, searchText);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      message.error(err.response?.data?.message || 'Failed to save plan');
    }
  };

  const handleToggleActive = async (plan: SubscriptionPlan) => {
    try {
      await api.patch(`/admin/plans/${plan.id}`, { isActive: !plan.isActive });
      message.success(`Plan ${plan.isActive ? 'deactivated' : 'activated'} successfully`);
      fetchPlans(pagination.page, pagination.limit, statusFilter, searchText);
    } catch (error) {
      message.error('Failed to update plan status');
    }
  };

  const columns: ColumnsType<SubscriptionPlan> = [
    {
      title: 'Order',
      dataIndex: 'displayOrder',
      key: 'displayOrder',
      width: 60,
      sorter: (a, b) => a.displayOrder - b.displayOrder,
    },
    {
      title: 'Plan',
      key: 'plan',
      render: (_, record) => (
        <Space direction="vertical" size="small">
          <Space>
            <CrownOutlined style={{ color: '#faad14' }} />
            <Text strong>{record.name}</Text>
            {record.badge && (
              <Tag color={record.badgeColor || 'blue'}>{record.badge}</Tag>
            )}
            {record.isFeatured && (
              <Tag color="gold" icon={<StarOutlined />}>Featured</Tag>
            )}
          </Space>
          {record.description && (
            <Text type="secondary" className="text-xs">{record.description}</Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Pricing',
      key: 'pricing',
      render: (_, record) => (
        <Space direction="vertical" size="small">
          <Text>${Number(record.monthlyPrice).toFixed(2)}/mo</Text>
          <Text type="secondary" className="text-xs">
            ${Number(record.yearlyPrice).toFixed(2)}/yr
          </Text>
          {record.discountPercent > 0 && (
            <Tag color="red" icon={<GiftOutlined />}>
              {record.discountPercent}% OFF
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Trial',
      key: 'trial',
      render: (_, record) => (
        record.trialDays > 0 ? (
          <Space direction="vertical" size="small">
            <Text>{record.trialDays} days</Text>
            <Text type="secondary" className="text-xs">
              {record.trialRequiresCard ? 'Card required' : 'No card needed'}
            </Text>
          </Space>
        ) : (
          <Text type="secondary">No trial</Text>
        )
      ),
    },
    {
      title: 'Limits',
      key: 'limits',
      render: (_, record) => (
        <Space direction="vertical" size="small" className="text-xs">
          <Text>{record.maxGates} gates</Text>
          <Text>{record.maxUsers} users</Text>
          <Text>{record.maxVehicles} vehicles</Text>
        </Space>
      ),
    },
    {
      title: 'Subscribers',
      key: 'subscribers',
      render: (_, record) => (
        <Tag color={record.tenants?.length ? 'blue' : 'default'}>
          {record.tenants?.length || 0} subscribers
        </Tag>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      render: (_, record) => (
        <Space direction="vertical" size="small">
          <Switch
            checked={record.isActive}
            onChange={() => handleToggleActive(record)}
            checkedChildren="Active"
            unCheckedChildren="Inactive"
          />
          {record.isPublic ? (
            <Tag color="green" icon={<CheckCircleOutlined />}>Public</Tag>
          ) : (
            <Tag icon={<CloseCircleOutlined />}>Hidden</Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Tooltip title="Edit">
            <Button
              icon={<EditOutlined />}
              size="small"
              onClick={() => handleEdit(record)}
            />
          </Tooltip>
          <Popconfirm
            title="Delete this plan?"
            description={
              record.tenants?.length
                ? `${record.tenants.length} subscribers will be affected!`
                : 'This action cannot be undone.'
            }
            onConfirm={() => handleDelete(record.id)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
            disabled={!!record.tenants?.length}
          >
            <Tooltip title={record.tenants?.length ? 'Cannot delete - has subscribers' : 'Delete'}>
              <Button
                icon={<DeleteOutlined />}
                size="small"
                danger
                disabled={!!record.tenants?.length}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <Title level={3}>Subscription Plans</Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => fetchPlans(pagination.page, pagination.limit, statusFilter, searchText)}>
            Refresh
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            Create Plan
          </Button>
        </Space>
      </div>

      <Card>
        <div className="mb-4 p-4 bg-gray-50 rounded-lg">
          <Row gutter={16} align="middle">
            <Col>
              <Input
                placeholder="Search plan name"
                allowClear
                className="w-48"
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
                  { label: 'Inactive', value: 'inactive' },
                ]}
              />
            </Col>
            <Col>
              <Space>
                <Button type="primary" onClick={() => fetchPlans(1, pagination.limit, statusFilter, searchText)}>
                  Apply
                </Button>
                <Button onClick={() => {
                  setSearchText('');
                  setStatusFilter(undefined);
                  fetchPlans(1, pagination.limit, undefined, undefined);
                }}>
                  Reset
                </Button>
              </Space>
            </Col>
          </Row>
        </div>
        <Table
          columns={columns}
          dataSource={plans}
          rowKey="id"
          loading={loading}
          scroll={{ x: 1000 }}
          pagination={{
            current: pagination.page,
            pageSize: pagination.limit,
            total: pagination.total,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} plans`,
            onChange: (page, pageSize) => fetchPlans(page, pageSize, statusFilter, searchText),
          }}
        />
      </Card>

      {/* Create/Edit Modal */}
      <Modal
        title={editingPlan ? 'Edit Subscription Plan' : 'Create Subscription Plan'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        width={800}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Tabs
            items={[
              {
                key: 'basic',
                label: 'Basic Info',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name="name"
                          label="Plan Name"
                          rules={[{ required: true, message: 'Please enter plan name' }]}
                        >
                          <Input placeholder="e.g., Professional" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="displayOrder" label="Display Order">
                          <InputNumber min={0} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>

                    <Form.Item name="description" label="Description">
                      <TextArea rows={2} placeholder="Brief description of this plan" />
                    </Form.Item>

                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="badge" label="Badge Text">
                          <Input placeholder="e.g., Popular" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="badgeColor" label="Badge Color">
                          <Select placeholder="Select color" options={badgeColors} allowClear />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="isFeatured" label="Featured" valuePropName="checked">
                          <Switch />
                        </Form.Item>
                      </Col>
                    </Row>

                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="isActive" label="Active" valuePropName="checked">
                          <Switch />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="isPublic" label="Show on Pricing Page" valuePropName="checked">
                          <Switch />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'pricing',
                label: 'Pricing & Discount',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name="monthlyPrice"
                          label="Monthly Price ($)"
                          rules={[{ required: true, message: 'Please enter monthly price' }]}
                        >
                          <InputNumber min={0} precision={2} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="yearlyPrice"
                          label="Yearly Price ($)"
                          rules={[{ required: true, message: 'Please enter yearly price' }]}
                        >
                          <InputNumber min={0} precision={2} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>

                    <Divider>Discount Settings</Divider>

                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="discountPercent" label="Discount (%)">
                          <InputNumber min={0} max={100} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="discountLabel" label="Discount Label">
                          <Input placeholder="e.g., Save 20%" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="discountValidUntil" label="Discount Valid Until">
                          <DatePicker style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'trial',
                label: 'Trial Settings',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="trialDays" label="Trial Period (days)">
                          <InputNumber min={0} max={90} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      {/* <Col span={12}>
                        <Form.Item
                          name="trialRequiresCard"
                          label="Require Card for Trial"
                          valuePropName="checked"
                        >
                          <Switch />
                        </Form.Item>
                      </Col> */}
                    </Row>
                    <Text type="secondary">
                      Set trial days to 0 to disable trial for this plan.
                    </Text>
                  </>
                ),
              },
              {
                key: 'limits',
                label: 'Limits',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name="maxGates"
                          label="Max Gates"
                          rules={[{ required: true, message: 'Please enter max gates' }]}
                        >
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="maxUsers"
                          label="Max Users"
                          rules={[{ required: true, message: 'Please enter max users' }]}
                        >
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>

                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="maxVehicles" label="Max Vehicles">
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="maxVisitorPassesPerMonth" label="Max Visitor Passes/Month">
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>

                    <Form.Item
                      name="logRetentionDays"
                      label="Log Retention (days)"
                      rules={[{ required: true, message: 'Please enter log retention days' }]}
                    >
                      <InputNumber min={1} max={365} style={{ width: '100%' }} />
                    </Form.Item>
                  </>
                ),
              },
              // {
              //   key: 'features',
              //   label: 'Features',
              //   children: (
              //     <>
              //       <Form.Item name={['features', 'simulator_access']} valuePropName="checked">
              //         <Checkbox>Gate Simulator Access</Checkbox>
              //       </Form.Item>
              //       <Form.Item name={['features', 'csv_export']} valuePropName="checked">
              //         <Checkbox>CSV Export</Checkbox>
              //       </Form.Item>
              //       <Form.Item name={['features', 'api_access']} valuePropName="checked">
              //         <Checkbox>API Access</Checkbox>
              //       </Form.Item>
              //       {/* <Form.Item name={['features', 'custom_branding']} valuePropName="checked">
              //         <Checkbox>Custom Branding</Checkbox>
              //       </Form.Item>
              //       <Form.Item name={['features', 'priority_support']} valuePropName="checked">
              //         <Checkbox>Priority Support</Checkbox>
              //       </Form.Item>
              //       <Form.Item name={['features', 'advanced_analytics']} valuePropName="checked">
              //         <Checkbox>Advanced Analytics</Checkbox>
              //       </Form.Item>
              //       <Form.Item name={['features', 'multi_building']} valuePropName="checked">
              //         <Checkbox>Multi-Building Support</Checkbox>
              //       </Form.Item> */}
              //       <Form.Item name={['features', 'webhook_notifications']} valuePropName="checked">
              //         <Checkbox>Webhook Notifications</Checkbox>
              //       </Form.Item>
              //     </>
              //   ),
              // },
            ]}
          />

          <div className="text-right mt-4">
            <Space>
              <Button onClick={() => setModalVisible(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit">
                {editingPlan ? 'Update Plan' : 'Create Plan'}
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>
    </div>
  );
}

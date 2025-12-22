import { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Space,
  Modal,
  Form,
  Input,
  Select,
  DatePicker,
  Radio,
  Checkbox,
  message,
  Popconfirm,
  Tooltip,
  Row,
  Col,
  Statistic,
  Typography,
} from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
  QrcodeOutlined,
  SendOutlined,
  StopOutlined,
  DeleteOutlined,
  UserOutlined,
  PhoneOutlined,
  MailOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import api from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { UserRole } from '../../types';

const { RangePicker } = DatePicker;
const { Text } = Typography;

enum VisitorPassStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  USED = 'used',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

enum ValidityType {
  SINGLE_USE = 'single_use',
  TWENTY_FOUR_HOURS = '24_hours',
  ONE_WEEK = '1_week',
  CUSTOM = 'custom',
}

enum RegistrationType {
  SELF_SERVICE = 'self_service',
  ON_PREMISE = 'on_premise',
}

interface Resident {
  id: string;
  firstName: string;
  lastName: string;
  unit: string;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
}

interface VisitorPass {
  id: string;
  qrToken: string;
  visitorName: string;
  visitorPhone?: string;
  visitorEmail?: string;
  purpose?: string;
  hostUnit?: string;
  status: VisitorPassStatus;
  validFrom: string;
  validUntil: string;
  maxUses: number;
  useCount: number;
  createdById: string;
  createdBy?: { firstName: string; lastName: string };
  tenantId: string;
  createdAt: string;
  registrationType?: RegistrationType;
  residentConfirmed?: boolean;
  confirmationNotes?: string;
  residentId?: string;
  resident?: { firstName: string; lastName: string; unit: string };
}

interface Stats {
  total: number;
  active: number;
  expired: number;
  cancelled: number;
  used: number;
}

const statusColors: Record<VisitorPassStatus, string> = {
  [VisitorPassStatus.PENDING]: 'orange',
  [VisitorPassStatus.ACTIVE]: 'green',
  [VisitorPassStatus.USED]: 'blue',
  [VisitorPassStatus.EXPIRED]: 'default',
  [VisitorPassStatus.CANCELLED]: 'red',
};

const purposeOptions = [
  { value: 'business', label: 'Business Meeting' },
  { value: 'social', label: 'Social Visit' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'other', label: 'Other' },
];

export default function MyVisitorsPage() {
  const { user } = useAuthStore();
  const isStaff = user?.role && [UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY].includes(user.role);
  const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;

  const [passes, setPasses] = useState<VisitorPass[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, active: 0, expired: 0, cancelled: 0, used: 0 });
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [qrModalVisible, setQrModalVisible] = useState(false);
  const [selectedPass, setSelectedPass] = useState<VisitorPass | null>(null);
  const [qrCode, setQrCode] = useState<string>('');
  const [form] = Form.useForm();
  const [validityType, setValidityType] = useState<ValidityType>(ValidityType.SINGLE_USE);
  const [filters, setFilters] = useState({
    status: undefined as VisitorPassStatus | undefined,
  });

  // For staff on-premise registration
  const [residents, setResidents] = useState<Resident[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string | undefined>(undefined);

  const fetchPasses = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.status) params.append('status', filters.status);

      const [passesRes, statsRes] = await Promise.all([
        api.get(`/visitor-passes?${params.toString()}`),
        api.get('/visitor-passes/stats'),
      ]);

      setPasses(passesRes.data);
      setStats(statsRes.data);
    } catch (error) {
      message.error('Failed to fetch visitor passes');
    } finally {
      setLoading(false);
    }
  };

  const fetchTenants = async () => {
    if (!isSuperAdmin) return;
    try {
      const response = await api.get('/admin/tenants');
      setTenants(response.data);
    } catch (error) {
      console.error('Failed to fetch tenants');
    }
  };

  const fetchResidents = async (tenantId?: string) => {
    if (!isStaff) return;
    try {
      // For super admin, need tenant ID to fetch residents
      if (isSuperAdmin && !tenantId) {
        setResidents([]);
        return;
      }
      const url = isSuperAdmin && tenantId ? `/residents?tenantId=${tenantId}` : '/residents';
      const response = await api.get(url);
      setResidents(response.data);
    } catch (error) {
      console.error('Failed to fetch residents');
    }
  };

  useEffect(() => {
    fetchPasses();
    if (isSuperAdmin) {
      fetchTenants();
    } else if (isStaff) {
      fetchResidents();
    }
  }, [isStaff, isSuperAdmin]);

  // When tenant changes, fetch residents for that tenant
  useEffect(() => {
    if (isSuperAdmin && selectedTenantId) {
      fetchResidents(selectedTenantId);
    }
  }, [selectedTenantId, isSuperAdmin]);

  const handleCreate = () => {
    form.resetFields();
    setValidityType(ValidityType.SINGLE_USE);
    setSelectedTenantId(undefined);
    // Only clear residents for super admin (they need to select tenant first)
    // Building admins already have residents loaded for their tenant
    if (isSuperAdmin) {
      setResidents([]);
    }
    setModalVisible(true);
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    try {
      const customDates = values.customDates as Array<{ toISOString: () => string }> | undefined;
      const payload: Record<string, unknown> = {
        visitorName: values.visitorName,
        visitorPhone: values.visitorPhone,
        visitorEmail: values.visitorEmail,
        purpose: values.purpose,
        hostUnit: values.hostUnit,
        validityType: values.validityType,
        customValidFrom: customDates?.[0]?.toISOString(),
        customValidUntil: customDates?.[1]?.toISOString(),
        customMaxUses: values.customMaxUses,
        sendEmail: values.sendEmail,
        sendWhatsApp: values.sendWhatsApp,
      };

      // Add on-premise registration fields for staff
      if (isStaff) {
        payload.registrationType = values.registrationType || RegistrationType.ON_PREMISE;
        payload.residentConfirmed = values.residentConfirmed;
        payload.confirmationNotes = values.confirmationNotes;
        payload.residentId = values.residentId;

        // Super admin must specify tenant
        if (isSuperAdmin) {
          payload.tenantId = values.tenantId;
        }
      }

      const response = await api.post('/visitor-passes', payload);
      message.success('Visitor pass created successfully');
      setModalVisible(false);
      fetchPasses();

      // Show QR code after creation
      setSelectedPass(response.data);
      const qrRes = await api.get(`/visitor-passes/${response.data.id}/qr`);
      setQrCode(qrRes.data.qrCode);
      setQrModalVisible(true);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      message.error(err.response?.data?.message || 'Failed to create visitor pass');
    }
  };

  const handleViewQR = async (pass: VisitorPass) => {
    try {
      setSelectedPass(pass);
      const response = await api.get(`/visitor-passes/${pass.id}/qr`);
      setQrCode(response.data.qrCode);
      setQrModalVisible(true);
    } catch (error) {
      message.error('Failed to load QR code');
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await api.post(`/visitor-passes/${id}/cancel`);
      message.success('Visitor pass cancelled');
      fetchPasses();
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      message.error(err.response?.data?.message || 'Failed to cancel pass');
    }
  };

  const handleResend = async (id: string) => {
    try {
      await api.post(`/visitor-passes/${id}/resend`);
      message.success('Notification resent');
    } catch (error) {
      message.error('Failed to resend notification');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/visitor-passes/${id}`);
      message.success('Visitor pass deleted');
      fetchPasses();
    } catch (error) {
      message.error('Failed to delete pass');
    }
  };

  const copyLink = (qrToken: string) => {
    const link = `${window.location.origin}/visitor-pass/${qrToken}`;
    navigator.clipboard.writeText(link);
    message.success('Link copied to clipboard');
  };

  const columns: ColumnsType<VisitorPass> = [
    {
      title: 'Visitor',
      key: 'visitor',
      render: (_, record) => (
        <div>
          <div className="font-medium flex items-center gap-1">
            <UserOutlined />
            {record.visitorName}
          </div>
          {record.visitorPhone && (
            <div className="text-xs text-gray-500 flex items-center gap-1">
              <PhoneOutlined /> {record.visitorPhone}
            </div>
          )}
          {record.visitorEmail && (
            <div className="text-xs text-gray-500 flex items-center gap-1">
              <MailOutlined /> {record.visitorEmail}
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'Purpose',
      dataIndex: 'purpose',
      key: 'purpose',
      render: (purpose: string) => purpose ? <Tag>{purpose}</Tag> : <span className="text-gray-400">-</span>,
    },
    {
      title: 'Valid Period',
      key: 'validity',
      render: (_, record) => (
        <div className="text-xs">
          <div>{dayjs(record.validFrom).format('MMM D, YYYY HH:mm')}</div>
          <div className="text-gray-500">to</div>
          <div>{dayjs(record.validUntil).format('MMM D, YYYY HH:mm')}</div>
        </div>
      ),
    },
    {
      title: 'Uses',
      key: 'uses',
      render: (_, record) => (
        <span>
          {record.useCount} / {record.maxUses}
        </span>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: VisitorPassStatus) => (
        <Tag color={statusColors[status]}>{status.toUpperCase()}</Tag>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => dayjs(date).format('MMM D, YYYY'),
    },
    // Show registration info only for staff
    ...(isStaff ? [{
      title: 'Registration',
      key: 'registration',
      render: (_: unknown, record: VisitorPass) => (
        <div className="text-xs">
          <Tag color={record.registrationType === RegistrationType.ON_PREMISE ? 'purple' : 'blue'}>
            {record.registrationType === RegistrationType.ON_PREMISE ? 'On-Premise' : 'Self-Service'}
          </Tag>
          {record.registrationType === RegistrationType.ON_PREMISE && (
            <div className="mt-1">
              {record.residentConfirmed ? (
                <span className="text-green-600">
                  <CheckCircleOutlined /> Confirmed
                </span>
              ) : (
                <span className="text-orange-500">
                  <CloseCircleOutlined /> Not Confirmed
                </span>
              )}
            </div>
          )}
          {record.resident && (
            <div className="text-gray-500 mt-1">
              Host: {record.resident.firstName} {record.resident.lastName}
            </div>
          )}
        </div>
      ),
    }] : []),
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View QR Code">
            <Button
              icon={<QrcodeOutlined />}
              size="small"
              onClick={() => handleViewQR(record)}
            />
          </Tooltip>
          {(record.visitorEmail || record.visitorPhone) && (
            <Tooltip title="Resend Notification">
              <Button
                icon={<SendOutlined />}
                size="small"
                onClick={() => handleResend(record.id)}
              />
            </Tooltip>
          )}
          {record.status === VisitorPassStatus.ACTIVE && (
            <Popconfirm
              title="Cancel this visitor pass?"
              onConfirm={() => handleCancel(record.id)}
              okText="Yes"
              cancelText="No"
            >
              <Tooltip title="Cancel Pass">
                <Button icon={<StopOutlined />} size="small" danger />
              </Tooltip>
            </Popconfirm>
          )}
          <Popconfirm
            title="Delete this visitor pass?"
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
    <div className="space-y-4">
      {/* Statistics */}
      <Row gutter={16}>
        <Col span={4}>
          <Card>
            <Statistic title="Total Passes" value={stats.total} />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic
              title="Active"
              value={stats.active}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic
              title="Used"
              value={stats.used}
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic
              title="Expired"
              value={stats.expired}
              valueStyle={{ color: '#8c8c8c' }}
            />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic
              title="Cancelled"
              value={stats.cancelled}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Card>
        </Col>
      </Row>

      {/* Main Table */}
      <Card
        title={isStaff ? "Visitor Pass Management" : "My Visitor Passes"}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchPasses}>
              Refresh
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              {isStaff ? "Register Visitor" : "Create Visitor Pass"}
            </Button>
          </Space>
        }
      >
        <div className="mb-4">
          <Space>
            <Select
              placeholder="Filter by status"
              allowClear
              style={{ width: 150 }}
              value={filters.status}
              onChange={(value) => setFilters({ ...filters, status: value })}
            >
              <Select.Option value={VisitorPassStatus.ACTIVE}>Active</Select.Option>
              <Select.Option value={VisitorPassStatus.USED}>Used</Select.Option>
              <Select.Option value={VisitorPassStatus.EXPIRED}>Expired</Select.Option>
              <Select.Option value={VisitorPassStatus.CANCELLED}>Cancelled</Select.Option>
            </Select>
            <Button type="primary" onClick={fetchPasses}>
              Apply
            </Button>
          </Space>
        </div>

        <Table
          columns={columns}
          dataSource={passes}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      {/* Create Visitor Pass Modal */}
      <Modal
        title={isStaff ? "Register Visitor (On-Premise)" : "Create Visitor Pass"}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        width={650}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          {/* On-Premise Registration Section for Staff */}
          {isStaff && (
            <div className="bg-purple-50 p-4 rounded-lg mb-4 border border-purple-200">
              <div className="flex items-center gap-2 mb-3">
                <SafetyCertificateOutlined className="text-purple-600" />
                <Text strong>On-Premise Registration</Text>
              </div>

              {/* Tenant selector for Super Admin */}
              {isSuperAdmin && (
                <Form.Item
                  name="tenantId"
                  label="Building"
                  rules={[{ required: true, message: 'Please select a building' }]}
                >
                  <Select
                    placeholder="Select building first"
                    showSearch
                    optionFilterProp="children"
                    filterOption={(input, option) =>
                      (option?.children as unknown as string)?.toLowerCase().includes(input.toLowerCase())
                    }
                    onChange={(value) => {
                      setSelectedTenantId(value);
                      form.setFieldValue('residentId', undefined);
                    }}
                  >
                    {tenants.map((t) => (
                      <Select.Option key={t.id} value={t.id}>
                        {t.name}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              )}

              <Form.Item
                name="residentId"
                label="Resident Being Visited"
                rules={[{ required: true, message: 'Please select the resident' }]}
              >
                <Select
                  placeholder={isSuperAdmin && !selectedTenantId ? "Select building first" : "Select resident"}
                  showSearch
                  disabled={isSuperAdmin && !selectedTenantId}
                  optionFilterProp="children"
                  filterOption={(input, option) =>
                    (option?.children as unknown as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                >
                  {residents.map((r) => (
                    <Select.Option key={r.id} value={r.id}>
                      {r.firstName} {r.lastName} - Unit {r.unit}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>

              <Form.Item
                name="residentConfirmed"
                valuePropName="checked"
                className="mb-2"
              >
                <Checkbox>
                  <span className="flex items-center gap-1">
                    <CheckCircleOutlined className="text-green-600" />
                    Resident has confirmed this visitor (via call/text)
                  </span>
                </Checkbox>
              </Form.Item>

              <Form.Item name="confirmationNotes" label="Confirmation Notes">
                <Input.TextArea
                  placeholder="e.g., Confirmed via phone call at 2:30 PM"
                  rows={2}
                />
              </Form.Item>

              <Form.Item name="registrationType" hidden initialValue={RegistrationType.ON_PREMISE}>
                <Input />
              </Form.Item>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Form.Item
              name="visitorName"
              label="Visitor Name"
              rules={[{ required: true, message: 'Please enter visitor name' }]}
            >
              <Input prefix={<UserOutlined />} placeholder="John Smith" />
            </Form.Item>

            <Form.Item name="purpose" label="Purpose">
              <Select placeholder="Select purpose" options={purposeOptions} />
            </Form.Item>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="visitorEmail" label="Visitor Email">
              <Input prefix={<MailOutlined />} placeholder="visitor@example.com" />
            </Form.Item>

            <Form.Item name="visitorPhone" label="Visitor Phone">
              <Input prefix={<PhoneOutlined />} placeholder="+1234567890" />
            </Form.Item>
          </div>

          <Form.Item name="hostUnit" label="Host Unit (optional)">
            <Input placeholder="e.g., A-101" />
          </Form.Item>

          <Form.Item
            name="validityType"
            label="Pass Validity"
            initialValue={ValidityType.SINGLE_USE}
            rules={[{ required: true }]}
          >
            <Radio.Group onChange={(e) => setValidityType(e.target.value)}>
              <Space direction="vertical">
                <Radio value={ValidityType.SINGLE_USE}>
                  <span className="font-medium">Single Use</span>
                  <span className="text-gray-500 text-sm ml-2">Valid for 24 hours, 1 entry</span>
                </Radio>
                <Radio value={ValidityType.TWENTY_FOUR_HOURS}>
                  <span className="font-medium">24 Hours</span>
                  <span className="text-gray-500 text-sm ml-2">Unlimited entries for 24 hours</span>
                </Radio>
                <Radio value={ValidityType.ONE_WEEK}>
                  <span className="font-medium">1 Week</span>
                  <span className="text-gray-500 text-sm ml-2">Unlimited entries for 7 days</span>
                </Radio>
                <Radio value={ValidityType.CUSTOM}>
                  <span className="font-medium">Custom</span>
                  <span className="text-gray-500 text-sm ml-2">Specify custom date range</span>
                </Radio>
              </Space>
            </Radio.Group>
          </Form.Item>

          {validityType === ValidityType.CUSTOM && (
            <div className="grid grid-cols-2 gap-4">
              <Form.Item
                name="customDates"
                label="Valid Date Range"
                rules={[{ required: true, message: 'Please select date range' }]}
              >
                <RangePicker showTime />
              </Form.Item>
              <Form.Item name="customMaxUses" label="Max Uses" initialValue={10}>
                <Input type="number" min={1} max={100} />
              </Form.Item>
            </div>
          )}

          <div className="bg-blue-50 p-4 rounded-lg mb-4">
            <Text strong>Send Notification</Text>
            <div className="mt-2 space-y-2">
              <Form.Item name="sendEmail" valuePropName="checked" noStyle>
                <Checkbox>
                  <MailOutlined className="mr-1" /> Send via Email
                </Checkbox>
              </Form.Item>
              <br />
              <Form.Item name="sendWhatsApp" valuePropName="checked" noStyle>
                <Checkbox>
                  <PhoneOutlined className="mr-1" /> Send via WhatsApp
                </Checkbox>
              </Form.Item>
            </div>
          </div>

          <Form.Item className="mb-0 text-right">
            <Space>
              <Button onClick={() => setModalVisible(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit">
                Create Pass
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* QR Code Modal */}
      <Modal
        title="Visitor Pass QR Code"
        open={qrModalVisible}
        onCancel={() => setQrModalVisible(false)}
        footer={[
          <Button key="copy" onClick={() => selectedPass && copyLink(selectedPass.qrToken)}>
            Copy Link
          </Button>,
          <Button
            key="download"
            type="primary"
            onClick={() => {
              if (qrCode) {
                const link = document.createElement('a');
                link.href = qrCode;
                link.download = `visitor-pass-${selectedPass?.visitorName || 'qr'}.png`;
                link.click();
              }
            }}
          >
            Download QR
          </Button>,
        ]}
        width={400}
      >
        {selectedPass && (
          <div className="text-center">
            <div className="mb-4">
              <Text strong className="text-lg">{selectedPass.visitorName}</Text>
              {selectedPass.purpose && (
                <div className="text-gray-500">{selectedPass.purpose}</div>
              )}
            </div>
            {qrCode && (
              <img src={qrCode} alt="QR Code" className="mx-auto mb-4" style={{ width: 250, height: 250 }} />
            )}
            <div className="text-sm text-gray-500">
              <div>Valid from: {dayjs(selectedPass.validFrom).format('MMM D, YYYY HH:mm')}</div>
              <div>Valid until: {dayjs(selectedPass.validUntil).format('MMM D, YYYY HH:mm')}</div>
              <div className="mt-2">
                Uses remaining: {Math.max(0, selectedPass.maxUses - selectedPass.useCount)}
              </div>
            </div>
            <div className="mt-4 p-3 bg-gray-50 rounded text-xs">
              Share this QR code with your visitor. They can scan it at the gate to gain entry.
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

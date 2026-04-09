/**
 * Payments Admin Page
 * 
 * For Super Admin to manage all payments across tenants:
 * - View financial overview (MRR, ARR, churn rate, etc.)
 * - View all payments with filters
 * - Issue refunds
 * - Issue credits
 * - View revenue trends
 */

import { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Typography,
  Table,
  Tag,
  Space,
  Spin,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Statistic,
  DatePicker,
  message,
  Empty,
  Tooltip,
  Descriptions,
  Progress,
} from 'antd';
import {
  DollarOutlined,
  RiseOutlined,
  FallOutlined,
  UserOutlined,
  ReloadOutlined,
  UndoOutlined,
  GiftOutlined,
  BarChartOutlined,
  SearchOutlined,
  FilterOutlined,
} from '@ant-design/icons';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  adminBillingService,
  Payment,
  FinancialOverview,
  RefundCalculation,
} from '../../services/billing.service';

const { Title, Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

export default function PaymentsAdminPage() {
  const [loading, setLoading] = useState(true);
  const [financialOverview, setFinancialOverview] = useState<FinancialOverview | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20 });
  const [filters, setFilters] = useState<{
    tenantId?: string;
    status?: string;
    dateRange?: [dayjs.Dayjs, dayjs.Dayjs];
  }>({});
  const [revenueData, setRevenueData] = useState<{ month: string; revenue: number }[]>([]);

  // Modal states
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundLoading, setRefundLoading] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string>('');
  const [refundCalculation, setRefundCalculation] = useState<RefundCalculation | null>(null);
  const [refundForm] = Form.useForm();

  const [creditModalOpen, setCreditModalOpen] = useState(false);
  const [creditLoading, setCreditLoading] = useState(false);
  const [creditForm] = Form.useForm();

  const fetchFinancialOverview = async () => {
    try {
      const data = await adminBillingService.getFinancialOverview();
      setFinancialOverview(data);
    } catch {
      message.error('Failed to load financial overview');
    }
  };

  const fetchPayments = async (page = 1, pageSize = 20) => {
    setLoading(true);
    try {
      const data = await adminBillingService.getAllPayments({
        page,
        limit: pageSize,
        tenantId: filters.tenantId,
        status: filters.status,
        startDate: filters.dateRange?.[0]?.toISOString(),
        endDate: filters.dateRange?.[1]?.toISOString(),
      });
      setPayments(data.payments);
      setPaymentsTotal(data.total);
      setPagination({ current: page, pageSize });
    } catch {
      message.error('Failed to load payments');
    } finally {
      setLoading(false);
    }
  };

  const fetchRevenueData = async () => {
    try {
      const data = await adminBillingService.getRevenueByMonth(12);
      setRevenueData(data.months || []);
    } catch {
      console.error('Failed to load revenue data');
    }
  };

  useEffect(() => {
    Promise.all([fetchFinancialOverview(), fetchPayments(), fetchRevenueData()]);
  }, []);

  useEffect(() => {
    fetchPayments(1, pagination.pageSize);
  }, [filters]);

  const handleTableChange = (newPagination: TablePaginationConfig) => {
    fetchPayments(newPagination.current || 1, newPagination.pageSize || 20);
  };

  const openRefundModal = async (tenantId: string) => {
    setSelectedTenantId(tenantId);
    setRefundModalOpen(true);
    refundForm.resetFields();
    setRefundCalculation(null);

    try {
      const calc = await adminBillingService.calculateRefund(tenantId);
      setRefundCalculation(calc);
    } catch {
      message.error('Failed to calculate refund');
    }
  };

  const handleCreateRefund = async (values: { amount?: number; reason?: string }) => {
    setRefundLoading(true);
    try {
      await adminBillingService.createRefund(selectedTenantId, {
        amount: values.amount,
        reason: values.reason || 'requested_by_customer',
      });
      message.success('Refund issued successfully');
      setRefundModalOpen(false);
      refundForm.resetFields();
      fetchPayments(pagination.current, pagination.pageSize);
      fetchFinancialOverview();
    } catch {
      message.error('Failed to issue refund');
    } finally {
      setRefundLoading(false);
    }
  };

  const openCreditModal = (tenantId: string) => {
    setSelectedTenantId(tenantId);
    setCreditModalOpen(true);
    creditForm.resetFields();
  };

  const handleIssueCredit = async (values: { amount: number; description?: string }) => {
    setCreditLoading(true);
    try {
      await adminBillingService.issueCredit(selectedTenantId, {
        amount: values.amount,
        description: values.description || 'Account credit',
      });
      message.success('Credit issued successfully');
      setCreditModalOpen(false);
      creditForm.resetFields();
    } catch {
      message.error('Failed to issue credit');
    } finally {
      setCreditLoading(false);
    }
  };

  const columns: ColumnsType<Payment> = [
    {
      title: 'Date',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => dayjs(date).format('MMM D, YYYY HH:mm'),
      width: 160,
      sorter: (a, b) => dayjs(a.createdAt).unix() - dayjs(b.createdAt).unix(),
    },
    {
      title: 'Tenant',
      dataIndex: 'tenantId',
      key: 'tenantId',
      width: 120,
      ellipsis: true,
      render: (tenantId: string) => (
        <Tooltip title={tenantId}>
          <Text code className="text-xs">{tenantId.slice(0, 8)}...</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'transactionType',
      key: 'transactionType',
      width: 100,
      render: (type: string) => {
        const colors: Record<string, string> = {
          charge: 'blue',
          refund: 'red',
          credit: 'green',
          chargeback: 'orange',
          adjustment: 'purple',
        };
        return <Tag color={colors[type] || 'default'}>{type}</Tag>;
      },
      filters: [
        { text: 'Charge', value: 'charge' },
        { text: 'Refund', value: 'refund' },
        { text: 'Credit', value: 'credit' },
      ],
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      width: 100,
      align: 'right',
      render: (amount: number, record: Payment) => (
        <Text
          strong
          style={{
            color: record.transactionType === 'refund' ? '#ff4d4f' : '#52c41a',
          }}
        >
          {record.transactionType === 'refund' ? '-' : '+'}${amount.toFixed(2)}
        </Text>
      ),
      sorter: (a, b) => a.amount - b.amount,
    },
    {
      title: 'Net',
      key: 'netAmount',
      width: 100,
      align: 'right',
      render: (_, record: Payment) => (
        <Text type="secondary">
          ${(record.netAmount || record.amount - (record.feeAmount || 0)).toFixed(2)}
        </Text>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => {
        const colors: Record<string, string> = {
          succeeded: 'green',
          pending: 'orange',
          failed: 'red',
          refunded: 'purple',
          partially_refunded: 'gold',
        };
        return <Tag color={colors[status] || 'default'}>{status.replace('_', ' ')}</Tag>;
      },
      filters: [
        { text: 'Succeeded', value: 'succeeded' },
        { text: 'Pending', value: 'pending' },
        { text: 'Failed', value: 'failed' },
        { text: 'Refunded', value: 'refunded' },
      ],
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 150,
      render: (_, record: Payment) => (
        <Space>
          <Tooltip title="Issue Refund">
            <Button
              size="small"
              icon={<UndoOutlined />}
              onClick={() => openRefundModal(record.tenantId)}
              disabled={record.transactionType !== 'charge' || record.status !== 'succeeded'}
            />
          </Tooltip>
          <Tooltip title="Issue Credit">
            <Button
              size="small"
              icon={<GiftOutlined />}
              onClick={() => openCreditModal(record.tenantId)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const renderRevenueChart = () => {
    if (revenueData.length === 0) return <Empty description="No revenue data" />;

    const maxRevenue = Math.max(...revenueData.map((d) => d.revenue));

    return (
      <div className="space-y-2">
        {revenueData.slice(-6).map((item) => (
          <div key={item.month} className="flex items-center gap-4">
            <Text className="w-20 text-xs">{dayjs(item.month).format('MMM YYYY')}</Text>
            <Progress
              percent={(item.revenue / maxRevenue) * 100}
              showInfo={false}
              strokeColor="#1890ff"
              className="flex-1"
            />
            <Text className="w-20 text-right text-xs">
              {formatCurrency(item.revenue)}
            </Text>
          </div>
        ))}
      </div>
    );
  };

  if (loading && !financialOverview) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <Title level={2}>
            <DollarOutlined className="mr-2" />
            Payments & Revenue
          </Title>
          <Text type="secondary">Monitor financial metrics and manage payments</Text>
        </div>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => {
            fetchFinancialOverview();
            fetchPayments(pagination.current, pagination.pageSize);
          }}
        >
          Refresh
        </Button>
      </div>

      {/* Financial Overview Cards */}
      <Row gutter={[16, 16]} className="mb-6">
        <Col xs={12} sm={8} lg={4}>
          <Card>
            <Statistic
              title="MRR"
              value={financialOverview?.mrr || 0}
              precision={0}
              prefix="$"
              valueStyle={{ color: '#1890ff' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card>
            <Statistic
              title="ARR"
              value={financialOverview?.arr || 0}
              precision={0}
              prefix="$"
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card>
            <Statistic
              title="Total Revenue"
              value={financialOverview?.totalRevenue || 0}
              precision={0}
              prefix="$"
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card>
            <Statistic
              title="Active Subscriptions"
              value={financialOverview?.activeSubscriptions || 0}
              prefix={<UserOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card>
            <Statistic
              title="Churn Rate"
              value={financialOverview?.churnRate || 0}
              precision={1}
              suffix="%"
              valueStyle={{
                color: (financialOverview?.churnRate || 0) > 5 ? '#ff4d4f' : '#52c41a',
              }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card>
            <Statistic
              title="ARPU"
              value={financialOverview?.arpu || 0}
              precision={2}
              prefix="$"
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="mb-6">
        {/* Revenue Growth */}
        <Col xs={24} lg={8}>
          <Card size="small">
            <div className="flex items-center justify-between">
              <div>
                <Text type="secondary">Revenue Growth</Text>
                <div className="flex items-center gap-2">
                  <Title level={4} className="mb-0">
                    {((financialOverview?.revenueGrowth || 0) * 100).toFixed(1)}%
                  </Title>
                  {(financialOverview?.revenueGrowth || 0) >= 0 ? (
                    <RiseOutlined style={{ color: '#52c41a' }} />
                  ) : (
                    <FallOutlined style={{ color: '#ff4d4f' }} />
                  )}
                </div>
              </div>
              <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center">
                <BarChartOutlined className="text-2xl text-blue-600" />
              </div>
            </div>
          </Card>
        </Col>

        {/* Revenue Trend */}
        <Col xs={24} lg={16}>
          <Card title="Revenue Trend (Last 6 Months)" size="small">
            {renderRevenueChart()}
          </Card>
        </Col>
      </Row>

      {/* Filters */}
      <Card className="mb-4">
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex items-center gap-2">
            <FilterOutlined />
            <Text strong>Filters:</Text>
          </div>
          <Input
            placeholder="Tenant ID"
            prefix={<SearchOutlined />}
            className="w-48"
            allowClear
            onChange={(e) => setFilters((f) => ({ ...f, tenantId: e.target.value || undefined }))}
          />
          <Select
            placeholder="Status"
            className="w-36"
            allowClear
            onChange={(value) => setFilters((f) => ({ ...f, status: value }))}
            options={[
              { label: 'Succeeded', value: 'succeeded' },
              { label: 'Pending', value: 'pending' },
              { label: 'Failed', value: 'failed' },
              { label: 'Refunded', value: 'refunded' },
            ]}
          />
          <RangePicker
            onChange={(dates) =>
              setFilters((f) => ({
                ...f,
                dateRange: dates as [dayjs.Dayjs, dayjs.Dayjs] | undefined,
              }))
            }
          />
          <Button
            onClick={() => {
              setFilters({});
            }}
          >
            Clear Filters
          </Button>
        </div>
      </Card>

      {/* Payments Table */}
      <Card title="All Payments">
        <Table
          columns={columns}
          dataSource={payments}
          rowKey="id"
          loading={loading}
          pagination={{
            ...pagination,
            total: paymentsTotal,
            showSizeChanger: true,
            showTotal: (total) => `Total ${total} payments`,
          }}
          onChange={handleTableChange}
          scroll={{ x: 1000 }}
          locale={{
            emptyText: <Empty description="No payments found" />,
          }}
        />
      </Card>

      {/* Refund Modal */}
      <Modal
        title={
          <Space>
            <UndoOutlined />
            <span>Issue Refund</span>
          </Space>
        }
        open={refundModalOpen}
        onCancel={() => setRefundModalOpen(false)}
        footer={null}
        width={500}
      >
        {refundCalculation && (
          <Descriptions bordered column={1} size="small" className="mb-4">
            <Descriptions.Item label="Eligible Amount">
              ${refundCalculation.refundableAmount?.toFixed(2) || '0.00'}
            </Descriptions.Item>
            <Descriptions.Item label="Days Used">
              {refundCalculation.daysUsed || 0} of {refundCalculation.totalDays || 0}
            </Descriptions.Item>
            <Descriptions.Item label="Prorate">
              {refundCalculation.proratedPercentage?.toFixed(0) || 0}%
            </Descriptions.Item>
          </Descriptions>
        )}

        <Form form={refundForm} layout="vertical" onFinish={handleCreateRefund}>
          <Form.Item
            name="amount"
            label="Refund Amount (leave empty for full refund)"
          >
            <InputNumber
              prefix="$"
              min={0}
              max={refundCalculation?.refundableAmount || 999999}
              precision={2}
              className="w-full"
              placeholder={`Max: $${refundCalculation?.refundableAmount?.toFixed(2) || '0.00'}`}
            />
          </Form.Item>

          <Form.Item name="reason" label="Reason">
            <Select
              placeholder="Select reason"
              options={[
                { label: 'Requested by customer', value: 'requested_by_customer' },
                { label: 'Duplicate charge', value: 'duplicate' },
                { label: 'Fraudulent', value: 'fraudulent' },
                { label: 'Other', value: 'other' },
              ]}
            />
          </Form.Item>

          <div className="flex justify-end gap-2">
            <Button onClick={() => setRefundModalOpen(false)}>Cancel</Button>
            <Button type="primary" danger htmlType="submit" loading={refundLoading}>
              Issue Refund
            </Button>
          </div>
        </Form>
      </Modal>

      {/* Credit Modal */}
      <Modal
        title={
          <Space>
            <GiftOutlined />
            <span>Issue Credit</span>
          </Space>
        }
        open={creditModalOpen}
        onCancel={() => setCreditModalOpen(false)}
        footer={null}
      >
        <Paragraph type="secondary" className="mb-4">
          Credits will be automatically applied to the customer's next invoice.
        </Paragraph>

        <Form form={creditForm} layout="vertical" onFinish={handleIssueCredit}>
          <Form.Item
            name="amount"
            label="Credit Amount"
            rules={[{ required: true, message: 'Please enter amount' }]}
          >
            <InputNumber
              prefix="$"
              min={0.01}
              precision={2}
              className="w-full"
              placeholder="Enter amount"
            />
          </Form.Item>

          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Reason for credit (visible to customer)" />
          </Form.Item>

          <div className="flex justify-end gap-2">
            <Button onClick={() => setCreditModalOpen(false)}>Cancel</Button>
            <Button type="primary" htmlType="submit" loading={creditLoading}>
              Issue Credit
            </Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
}

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
  Result,
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
} from '@ant-design/icons';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import dayjs from 'dayjs';
import api from '../../services/api';
import {
  adminBillingService,
  Payment,
  FinancialOverview,
  RefundCalculation,
} from '../../services/billing.service';
import { useAuthStore } from '../../store/authStore';
import { UserRole } from '../../types';

const { Title, Text, Paragraph } = Typography;

// Types for tenant and plan dropdowns
interface TenantOption {
  id: string;
  name: string;
  status: string;
  subscriptionStatus: string;
}

interface PlanOption {
  id: string;
  name: string;
}

export default function PaymentsAdminPage() {
  const { user, isLoading: authLoading } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [financialOverview, setFinancialOverview] = useState<FinancialOverview | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20 });
  const [filters, setFilters] = useState<{
    tenantId?: string;
    planId?: string;
    status?: string;
    type?: string;
    billingCycle?: string;
    startDate?: dayjs.Dayjs;
    endDate?: dayjs.Dayjs;
  }>({});
  const [revenueData, setRevenueData] = useState<{ month: string; revenue: number }[]>([]);
  
  // Dropdown options
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [plans, setPlans] = useState<PlanOption[]>([]);

  // Modal states
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundLoading, setRefundLoading] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string>('');
  const [refundCalculation, setRefundCalculation] = useState<RefundCalculation | null>(null);
  const [refundForm] = Form.useForm();

  const [creditModalOpen, setCreditModalOpen] = useState(false);
  const [creditLoading, setCreditLoading] = useState(false);
  const [creditForm] = Form.useForm();

  // Check for super admin role
  const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;

  const fetchFinancialOverview = async () => {
    try {
      const data = await adminBillingService.getFinancialOverview();
      setFinancialOverview(data);
    } catch (err) {
      console.error('Failed to load financial overview:', err);
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
        planId: filters.planId,
        status: filters.status,
        type: filters.type,
        billingCycle: filters.billingCycle,
        startDate: filters.startDate?.startOf('day').toISOString(),
        endDate: filters.endDate?.endOf('day').toISOString(),
      });
      setPayments(data.payments || []);
      setPaymentsTotal(data.total || 0);
      setPagination({ current: page, pageSize });
    } catch (err) {
      console.error('Failed to load payments:', err);
      message.error('Failed to load payments');
      setPayments([]);
      setPaymentsTotal(0);
    } finally {
      setLoading(false);
    }
  };

  const fetchTenants = async () => {
    try {
      const response = await api.get('/admin/tenants');
      const data = response.data.data || response.data || [];
      // Filter to only show tenants with active subscriptions
      const activeTenants = data.filter(
        (t: TenantOption) => t.subscriptionStatus === 'active'
      );
      setTenants(activeTenants);
    } catch (err) {
      console.error('Failed to fetch tenants:', err);
    }
  };

  const fetchPlans = async () => {
    try {
      const response = await api.get('/admin/plans');
      const data = response.data.data || response.data || [];
      setPlans(data);
    } catch (err) {
      console.error('Failed to fetch plans:', err);
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
    if (!isSuperAdmin) return;
    Promise.all([fetchFinancialOverview(), fetchPayments(), fetchRevenueData(), fetchTenants(), fetchPlans()]);
  }, [isSuperAdmin]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    fetchPayments(1, pagination.pageSize);
  }, [filters, isSuperAdmin]);

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
      render: (date: string) => (
        <div>
          <div className="font-medium">{dayjs(date).format('MMM D, YYYY')}</div>
          <div className="text-xs text-gray-500">{dayjs(date).format('HH:mm')}</div>
        </div>
      ),
      width: 120,
      sorter: (a, b) => dayjs(a.createdAt).unix() - dayjs(b.createdAt).unix(),
      defaultSortOrder: 'descend',
    },
    {
      title: 'Tenant',
      key: 'tenant',
      width: 180,
      render: (_, record: Payment) => (
        <div>
          <div className="font-medium">{record.tenant?.name || 'Unknown'}</div>
          <Text type="secondary" className="text-xs">{record.tenantId?.slice(0, 8)}...</Text>
        </div>
      ),
    },
    {
      title: 'Plan',
      key: 'plan',
      width: 140,
      render: (_, record: Payment) => (
        <div>
          <div>{record.subscriptionPlan?.name || '-'}</div>
          {record.billingCycle && (
            <Tag color={record.billingCycle === 'yearly' ? 'purple' : 'blue'} className="text-xs">
              {record.billingCycle}
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'transactionType',
      key: 'transactionType',
      width: 100,
      render: (type: string) => {
        const colors: Record<string, string> = {
          charge: 'green',
          refund: 'red',
          credit: 'blue',
          chargeback: 'orange',
          adjustment: 'purple',
        };
        const icons: Record<string, string> = {
          charge: '+',
          refund: '−',
          credit: '★',
          chargeback: '!',
          adjustment: '↔',
        };
        return (
          <Tag color={colors[type] || 'default'}>
            {icons[type]} {type.toUpperCase()}
          </Tag>
        );
      },
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      width: 200,
      render: (desc: string, record: Payment) => (
        <div>
          <div className="truncate">{desc || `${record.paymentType || 'Payment'}`}</div>
          {record.paymentMethodLast4 && (
            <Text type="secondary" className="text-xs">
              {record.paymentMethodBrand} •••• {record.paymentMethodLast4}
            </Text>
          )}
        </div>
      ),
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      width: 110,
      align: 'right',
      render: (amount: number | string, record: Payment) => (
        <div className="text-right">
          <div
            className="font-bold"
            style={{
              color: record.transactionType === 'refund' || record.transactionType === 'chargeback' ? '#ff4d4f' : '#52c41a',
            }}
          >
            {record.transactionType === 'refund' || record.transactionType === 'chargeback' ? '-' : '+'}
            ${Number(amount || 0).toFixed(2)}
          </div>
          {record.feeAmount && Number(record.feeAmount) > 0 && (
            <Text type="secondary" className="text-xs">
              Fee: ${Number(record.feeAmount).toFixed(2)}
            </Text>
          )}
        </div>
      ),
      sorter: (a, b) => Number(a.amount || 0) - Number(b.amount || 0),
    },
    {
      title: 'Net',
      key: 'netAmount',
      width: 90,
      align: 'right',
      render: (_, record: Payment) => {
        const net = Number(record.netAmount || 0) || (Number(record.amount || 0) - Number(record.feeAmount || 0));
        return (
          <Text type="secondary" className="font-medium">
            ${net.toFixed(2)}
          </Text>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (status: string) => {
        const config: Record<string, { color: string; text: string }> = {
          succeeded: { color: 'green', text: 'Succeeded' },
          pending: { color: 'orange', text: 'Pending' },
          failed: { color: 'red', text: 'Failed' },
          refunded: { color: 'purple', text: 'Refunded' },
          partially_refunded: { color: 'gold', text: 'Partial Refund' },
          canceled: { color: 'default', text: 'Canceled' },
          disputed: { color: 'red', text: 'Disputed' },
        };
        const { color, text } = config[status] || { color: 'default', text: status };
        return <Tag color={color}>{text}</Tag>;
      },
    },
    // {
    //   title: 'Actions',
    //   key: 'actions',
    //   width: 100,
    //   render: (_, record: Payment) => (
    //     <Space wrap={false} size="small">
    //       <Tooltip title="Issue Refund">
    //         <Button
    //           size="small"
    //           icon={<UndoOutlined />}
    //           onClick={() => openRefundModal(record.tenantId)}
    //           disabled={record.transactionType !== 'charge' || record.status !== 'succeeded'}
    //         />
    //       </Tooltip>
    //       <Tooltip title="Issue Credit">
    //         <Button
    //           size="small"
    //           icon={<GiftOutlined />}
    //           onClick={() => openCreditModal(record.tenantId)}
    //         />
    //       </Tooltip>
    //     </Space>
    //   ),
    // },
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

  // Show loading while auth is being determined
  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spin size="large" />
      </div>
    );
  }

  // If no user after auth loaded, something is wrong - show access denied
  if (!user) {
    return (
      <div className="p-6">
        <Result
          status="warning"
          title="Authentication Required"
          subTitle="Please log in to access this page."
          extra={
            <Button type="primary" href="/login">
              Go to Login
            </Button>
          }
        />
      </div>
    );
  }

  // Role check - only SUPER_ADMIN can access this page
  if (!isSuperAdmin) {
    return (
      <div className="p-6">
        <Result
          status="403"
          title="Access Denied"
          subTitle="This page is only accessible to Super Administrators."
          extra={
            <Button type="primary" href="/dashboard">
              Go to Dashboard
            </Button>
          }
        />
      </div>
    );
  }

  if (loading && !financialOverview && payments.length === 0) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      {/* Headline */}
      <div className="flex justify-between items-center">
        <Title level={3}>Payments & Revenue</Title>
      </div>


      {/* Filters */}
      <Card className="mb-4"

      extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => fetchPayments()} loading={loading}>
              Refresh
            </Button>
          </Space>
        }
      
      >
        <div className="flex flex-wrap gap-4 items-center">
          <Select
            placeholder="Select Tenant"
            className="w-52"
            allowClear
            showSearch
            optionFilterProp="label"
            value={filters.tenantId}
            onChange={(value) => setFilters((f) => ({ ...f, tenantId: value }))}
            options={tenants.map((t) => ({
              label: t.name,
              value: t.id,
            }))}
          />
          <Select
            placeholder="Select Plan"
            className="w-40"
            allowClear
            showSearch
            optionFilterProp="label"
            value={filters.planId}
            onChange={(value) => setFilters((f) => ({ ...f, planId: value }))}
            options={plans.map((p) => ({
              label: p.name,
              value: p.id,
            }))}
          />
          <Select
            placeholder="Transaction Type"
            className="w-40"
            allowClear
            value={filters.type}
            onChange={(value) => setFilters((f) => ({ ...f, type: value }))}
            options={[
              { label: 'Charge', value: 'charge' },
              { label: 'Refund', value: 'refund' },
              { label: 'Credit', value: 'credit' },
              { label: 'Chargeback', value: 'chargeback' },
            ]}
          />
          <Select
            placeholder="Status"
            className="w-36"
            allowClear
            value={filters.status}
            onChange={(value) => setFilters((f) => ({ ...f, status: value }))}
            options={[
              { label: 'Succeeded', value: 'succeeded' },
              { label: 'Pending', value: 'pending' },
              { label: 'Failed', value: 'failed' },
              { label: 'Refunded', value: 'refunded' },
              { label: 'Disputed', value: 'disputed' },
            ]}
          />
          <Select
            placeholder="Billing Cycle"
            className="w-32"
            allowClear
            value={filters.billingCycle}
            onChange={(value) => setFilters((f) => ({ ...f, billingCycle: value }))}
            options={[
              { label: 'Monthly', value: 'monthly' },
              { label: 'Yearly', value: 'yearly' },
            ]}
          />
          <DatePicker
            placeholder="Start Date"
            value={filters.startDate}
            onChange={(date) => setFilters((f) => ({ ...f, startDate: date || undefined }))}
            allowClear
          />
          <DatePicker
            placeholder="End Date"
            value={filters.endDate}
            onChange={(date) => setFilters((f) => ({ ...f, endDate: date || undefined }))}
            allowClear
          />
          <Space>
            <Button
              type="primary"
              onClick={() => fetchPayments(1, pagination.pageSize)}
            >
              Apply
            </Button>
            <Button
              onClick={() => {
                setFilters({});
                setPagination((p) => ({ ...p, current: 1 }));
              }}
            >
              Reset
            </Button>
          </Space>
        </div>
      </Card>

      {/* Payments Table */}
      <Card 
        title={
          <div className="flex items-center justify-between">
            <Space>
              <DollarOutlined />
              <span>All Payments</span>
              {/* <Tag color="blue">{paymentsTotal} total</Tag> */}
            </Space>
          </div>
        }
        // extra={
        //   <Button
        //     size="small"
        //     icon={<ReloadOutlined />}
        //     onClick={() => fetchPayments(pagination.current, pagination.pageSize)}
        //     loading={loading}
        //   >
        //     Refresh
        //   </Button>
        // }
      >
        <Table
          columns={columns}
          dataSource={payments}
          rowKey="id"
          loading={loading}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: paymentsTotal,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            // showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} payments`,
            // selectProps: { listHeight: 256 },
          }}
          onChange={handleTableChange}
          scroll={{ x: 1200 }}
          size="middle"
          locale={{
            emptyText: (
              <Empty 
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <div className="py-4">
                    <p className="text-gray-500 mb-2">No payments found</p>
                    <p className="text-xs text-gray-400">
                      Payments are recorded automatically when Stripe webhooks are received.
                      <br />
                      Make sure your Stripe webhook endpoint is configured correctly.
                    </p>
                  </div>
                }
              />
            ),
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

/**
 * Billing Settings Page
 * 
 * For Building Admins to manage their subscription:
 * - View subscription details
 * - View payment history
 * - Pause/unpause subscription
 * - View refund history
 * - Access Stripe Customer Portal
 */

import { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Typography,
  Button,
  Table,
  Tag,
  Space,
  Spin,
  Alert,
  Modal,
  Form,
  Input,
  DatePicker,
  Statistic,
  message,
  Empty,
  Tooltip,
} from 'antd';
import {
  CreditCardOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  HistoryOutlined,
  DollarOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  SettingOutlined,
  ExportOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  billingService,
  SubscriptionDetails,
  PauseStatus,
  Payment,
  RefundResult,
  RefundCalculation,
} from '../../services/billing.service';

dayjs.extend(relativeTime);

const { Title, Text, Paragraph } = Typography;

export default function BillingSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionDetails | null>(null);
  const [pauseStatus, setPauseStatus] = useState<PauseStatus | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [paymentsPage, setPaymentsPage] = useState(1);
  const [refunds, setRefunds] = useState<RefundResult[]>([]);
  
  // Modal states
  const [pauseModalOpen, setPauseModalOpen] = useState(false);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelEndLoading, setCancelEndLoading] = useState(false);
  const [cancelImmediateLoading, setCancelImmediateLoading] = useState(false);
  
  // Refund modal states
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundCalculation, setRefundCalculation] = useState<RefundCalculation | null>(null);
  const [refundLoading, setRefundLoading] = useState(false);
  const [refundCalculating, setRefundCalculating] = useState(false);
  const [refundReason, setRefundReason] = useState('');

  const [pauseForm] = Form.useForm();

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [subData, pauseData, paymentsData, refundsData] = await Promise.all([
        billingService.getSubscriptionDetails().catch((e) => { console.log('getSubscriptionDetails error:', e); return null; }),
        billingService.getPauseStatus().catch((e) => { console.log('getPauseStatus error:', e); return null; }),
        billingService.getPaymentHistory(1, 10).catch((e) => { console.log('getPaymentHistory error:', e); return { payments: [], total: 0 }; }),
        billingService.getRefundHistory().catch((e) => { console.log('getRefundHistory error:', e); return { refunds: [] }; }),
      ]);

      console.log('Billing data loaded:', { subData, pauseData, paymentsData, refundsData });
      
      setSubscription(subData);
      setPauseStatus(pauseData);
      setPayments(paymentsData.payments);
      setPaymentsTotal(paymentsData.total);
      setRefunds(refundsData.refunds || []);
    } catch (err) {
      console.error('Failed to load billing information:', err);
      setError(err instanceof Error ? err.message : 'Failed to load billing information');
      message.error('Failed to load billing information');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    console.log('BillingSettingsPage mounted');
    fetchData();
    return () => console.log('BillingSettingsPage unmounted');
  }, []);

  const fetchPayments = async (page: number) => {
    try {
      const data = await billingService.getPaymentHistory(page, 10);
      setPayments(data.payments);
      setPaymentsTotal(data.total);
      setPaymentsPage(page);
    } catch {
      message.error('Failed to load payments');
    }
  };

  const handleOpenPortal = async () => {
    try {
      const data = await billingService.createPortalSession(window.location.href);
      window.open(data.url, '_blank');
    } catch {
      message.error('Failed to open billing portal');
    }
  };

  const handlePauseSubscription = async (values: { resumesAt?: dayjs.Dayjs; reason?: string }) => {
    setPauseLoading(true);
    try {
      await billingService.pauseSubscription({
        resumesAt: values.resumesAt?.toISOString(),
        reason: values.reason,
      });
      message.success('Subscription paused successfully');
      setPauseModalOpen(false);
      pauseForm.resetFields();
      fetchData();
    } catch {
      message.error('Failed to pause subscription');
    } finally {
      setPauseLoading(false);
    }
  };

  const handleUnpauseSubscription = async () => {
    try {
      await billingService.unpauseSubscription();
      message.success('Subscription resumed successfully');
      fetchData();
    } catch {
      message.error('Failed to resume subscription');
    }
  };

  const handleCancelSubscription = async (immediately: boolean) => {
    if (immediately) {
      setCancelImmediateLoading(true);
    } else {
      setCancelEndLoading(true);
    }
    try {
      await billingService.cancelSubscription(immediately);
      message.success(
        immediately
          ? 'Subscription cancelled immediately'
          : 'Subscription will be cancelled at end of billing period'
      );
      setCancelModalOpen(false);
      fetchData();
    } catch {
      message.error('Failed to cancel subscription');
    } finally {
      setCancelEndLoading(false);
      setCancelImmediateLoading(false);
    }
  };

  const handleResumeSubscription = async () => {
    try {
      await billingService.resumeSubscription();
      message.success('Subscription resumed');
      fetchData();
    } catch {
      message.error('Failed to resume subscription');
    }
  };

  const handleOpenRefundModal = async () => {
    setRefundCalculating(true);
    setRefundModalOpen(true);
    try {
      const calc = await billingService.calculateRefund();
      setRefundCalculation(calc);
    } catch {
      message.error('Failed to calculate refund');
      setRefundModalOpen(false);
    } finally {
      setRefundCalculating(false);
    }
  };

  const handleRequestRefund = async () => {
    setRefundLoading(true);
    try {
      const result = await billingService.requestRefund(refundReason);
      message.success(result.message);
      setRefundModalOpen(false);
      setRefundReason('');
      setRefundCalculation(null);
      fetchData();
    } catch {
      message.error('Failed to process refund');
    } finally {
      setRefundLoading(false);
    }
  };

  const getStatusTag = (status: string) => {
    const statusConfig: Record<string, { color: string; icon: React.ReactNode }> = {
      active: { color: 'green', icon: <CheckCircleOutlined /> },
      trialing: { color: 'blue', icon: <ClockCircleOutlined /> },
      past_due: { color: 'orange', icon: <ExclamationCircleOutlined /> },
      canceled: { color: 'red', icon: <ExclamationCircleOutlined /> },
      paused: { color: 'purple', icon: <PauseCircleOutlined /> },
      incomplete: { color: 'default', icon: <ClockCircleOutlined /> },
    };

    const config = statusConfig[status] || { color: 'default', icon: null };
    return (
      <Tag color={config.color} icon={config.icon}>
        {status.toUpperCase().replace('_', ' ')}
      </Tag>
    );
  };

  const paymentColumns: ColumnsType<Payment> = [
    {
      title: 'Date',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => dayjs(date).format('MMM D, YYYY'),
      width: 120,
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
      width: 100,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const colors: Record<string, string> = {
          succeeded: 'green',
          pending: 'orange',
          failed: 'red',
          refunded: 'purple',
        };
        return <Tag color={colors[status] || 'default'}>{status}</Tag>;
      },
      width: 100,
    },
    {
      title: 'Payment Method',
      key: 'paymentMethod',
      render: (_, record: Payment) =>
        record.paymentMethodBrand && record.paymentMethodLast4 ? (
          <Space>
            <CreditCardOutlined />
            <Text>
              {record.paymentMethodBrand} •••• {record.paymentMethodLast4}
            </Text>
          </Space>
        ) : (
          '-'
        ),
      width: 150,
    },
  ];

  const refundColumns: ColumnsType<RefundResult> = [
    {
      title: 'Date',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => dayjs(date).format('MMM D, YYYY'),
    },
    {
      title: 'Amount',
      dataIndex: 'amountFormatted',
      key: 'amount',
      render: (amount: string) => <Text type="danger">{amount}</Text>,
    },
    {
      title: 'Reason',
      dataIndex: 'reason',
      key: 'reason',
      render: (reason: string) => reason?.replace(/_/g, ' ') || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={status === 'succeeded' ? 'green' : 'orange'}>{status}</Tag>
      ),
    },
  ];

  if (error) {
    return (
      <div className="p-6">
        <Alert
          type="error"
          message="Error Loading Billing"
          description={error}
          showIcon
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spin size="large" />
      </div>
    );
  }

  if (!subscription) {
    return (
      <div className="p-6">
        <Alert
          type="warning"
          message="No Active Subscription"
          description="You don't have an active subscription. Please contact support."
          showIcon
        />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Title level={2}>
          <SettingOutlined className="mr-2" />
          Billing Settings
        </Title>
        <Text type="secondary">Manage your subscription and view payment history</Text>
      </div>

      {/* Subscription Overview */}
      <Card className="mb-6">
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} md={16}>
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center">
                <CreditCardOutlined className="text-2xl text-blue-600" />
              </div>
              <div>
                <Title level={4} className="mb-0">
                  {subscription.planName}
                </Title>
                <Text type="secondary" className="capitalize">
                  {subscription.billingCycle} billing
                </Text>
              </div>
              {getStatusTag(pauseStatus?.isPaused ? 'paused' : subscription.status)}
            </div>

            <Row gutter={[16, 16]}>
              <Col span={8}>
                <Statistic
                  title="Amount"
                  value={subscription.monthlyAmount}
                  prefix="$"
                  suffix={subscription.billingCycle === 'yearly' ? '/year' : '/month'}
                />
              </Col>
              <Col span={8}>
                <Statistic
                  title="Next Billing"
                  value={dayjs(subscription.nextBillingDate).format('MMM D, YYYY')}
                  prefix={<CalendarOutlined />}
                />
              </Col>
              <Col span={8}>
                <Statistic
                  title="Status"
                  valueRender={() => getStatusTag(pauseStatus?.isPaused ? 'paused' : subscription.status)}
                />
              </Col>
            </Row>

            {/* Pause Info */}
            {pauseStatus?.isPaused && (
              <Alert
                type="info"
                className="mt-4"
                message="Subscription Paused"
                description={
                  <div>
                    <p>
                      {pauseStatus.reason && <><strong>Reason:</strong> {pauseStatus.reason}<br /></>}
                      {pauseStatus.resumesAt && (
                        <>
                          <strong>Resumes:</strong> {dayjs(pauseStatus.resumesAt).format('MMM D, YYYY')}
                          {pauseStatus.daysRemaining !== undefined && ` (${pauseStatus.daysRemaining} days)`}
                        </>
                      )}
                    </p>
                  </div>
                }
                showIcon
                icon={<PauseCircleOutlined />}
              />
            )}

            {/* Cancel at period end info */}
            {subscription.cancelAtPeriodEnd && (
              <Alert
                type="warning"
                className="mt-4"
                message="Subscription Ending"
                description={`Your subscription will end on ${dayjs(subscription.currentPeriodEnd).format('MMM D, YYYY')}`}
                showIcon
                action={
                  <Button size="small" onClick={handleResumeSubscription}>
                    Keep Subscription
                  </Button>
                }
              />
            )}
          </Col>

          <Col xs={24} md={8}>
            <Space direction="vertical" className="w-full">
              <Button
                type="primary"
                icon={<ExportOutlined />}
                block
                onClick={handleOpenPortal}
              >
                Manage in Stripe
              </Button>

              {pauseStatus?.isPaused ? (
                <Button
                  icon={<PlayCircleOutlined />}
                  block
                  onClick={handleUnpauseSubscription}
                >
                  Resume Subscription
                </Button>
              ) : pauseStatus?.canPause ? (
                <Button
                  icon={<PauseCircleOutlined />}
                  block
                  onClick={() => setPauseModalOpen(true)}
                >
                  Pause Subscription
                </Button>
              ) : null}

              {!subscription.cancelAtPeriodEnd && subscription.status === 'active' && (
                <Button
                  danger
                  block
                  onClick={() => setCancelModalOpen(true)}
                >
                  Cancel Subscription
                </Button>
              )}

              {/* Refund Request button temporarily disabled
              {subscription.status === 'active' && (
                <Button
                  type="default"
                  block
                  onClick={handleOpenRefundModal}
                >
                  Request Refund
                </Button>
              )}
              */}
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Payment History */}
      <Card
        title={
          <Space>
            <HistoryOutlined />
            <span>Payment History</span>
          </Space>
        }
        className="mb-6"
      >
        <Table
          columns={paymentColumns}
          dataSource={payments}
          rowKey="id"
          pagination={{
            current: paymentsPage,
            total: paymentsTotal,
            pageSize: 10,
            onChange: fetchPayments,
            showSizeChanger: false,
          }}
          locale={{
            emptyText: <Empty description="No payments yet" />,
          }}
        />
      </Card>

      {/* Refund History */}
      {refunds.length > 0 && (
        <Card
          title={
            <Space>
              <DollarOutlined />
              <span>Refund History</span>
            </Space>
          }
        >
          <Table
            columns={refundColumns}
            dataSource={refunds}
            rowKey="refundId"
            pagination={false}
          />
        </Card>
      )}

      {/* Pause Subscription Modal */}
      <Modal
        title={
          <Space>
            <PauseCircleOutlined />
            <span>Pause Subscription</span>
          </Space>
        }
        open={pauseModalOpen}
        onCancel={() => setPauseModalOpen(false)}
        footer={null}
      >
        <Paragraph type="secondary" className="mb-4">
          Pausing your subscription will stop billing while keeping your account active with limited access.
          You can set an auto-resume date or manually resume anytime.
        </Paragraph>

        <Form form={pauseForm} layout="vertical" onFinish={handlePauseSubscription}>
          <Form.Item
            name="resumesAt"
            label={
              <Space>
                <span>Auto-Resume Date</span>
                <Tooltip title="Optional. Your subscription will automatically resume on this date.">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
          >
            <DatePicker
              className="w-full"
              disabledDate={(current) =>
                current && (current < dayjs().endOf('day') || current > dayjs().add(1, 'year'))
              }
              placeholder="Select date (optional)"
            />
          </Form.Item>

          <Form.Item name="reason" label="Reason (optional)">
            <Input.TextArea
              rows={3}
              placeholder="Help us understand why you're pausing..."
            />
          </Form.Item>

          <div className="flex justify-end gap-2">
            <Button onClick={() => setPauseModalOpen(false)}>Cancel</Button>
            <Button type="primary" htmlType="submit" loading={pauseLoading}>
              Pause Subscription
            </Button>
          </div>
        </Form>
      </Modal>

      {/* Cancel Subscription Modal */}
      <Modal
        title={
          <Space>
            <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />
            <span>Cancel Subscription</span>
          </Space>
        }
        open={cancelModalOpen}
        onCancel={() => setCancelModalOpen(false)}
        footer={null}
      >
        <Alert
          type="warning"
          message="Are you sure?"
          description="Cancelling your subscription will disable access to premium features."
          showIcon
          className="mb-4"
        />

        <div className="space-y-3">
          <Button
            block
            onClick={() => handleCancelSubscription(false)}
            loading={cancelEndLoading}
            disabled={cancelImmediateLoading}
          >
            Cancel at End of Period
            <br />
            <Text type="secondary" className="text-xs">
              Keep access until {dayjs(subscription.currentPeriodEnd).format('MMM D, YYYY')}
            </Text>
          </Button>

          <Button
            danger
            block
            onClick={() => handleCancelSubscription(true)}
            loading={cancelImmediateLoading}
            disabled={cancelEndLoading}
          >
            Cancel Immediately
            <br />
            <Text type="secondary" className="text-xs">
              Lose access now (may be eligible for prorated refund)
            </Text>
          </Button>

          <Button block onClick={() => setCancelModalOpen(false)}>
            Keep My Subscription
          </Button>
        </div>
      </Modal>

      {/* Refund Request Modal */}
      <Modal
        title={
          <Space>
            <DollarOutlined />
            <span>Request Refund</span>
          </Space>
        }
        open={refundModalOpen}
        onCancel={() => {
          setRefundModalOpen(false);
          setRefundReason('');
          setRefundCalculation(null);
        }}
        footer={null}
      >
        {refundCalculating ? (
          <div className="text-center py-8">
            <Spin size="large" />
            <Text className="block mt-4">Calculating refund amount...</Text>
          </div>
        ) : refundCalculation ? (
          <>
            <Alert
              message="Refund Details"
              description={
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <Text>Original Amount:</Text>
                    <Text strong>${(refundCalculation.originalAmount / 100).toFixed(2)} {refundCalculation.currency.toUpperCase()}</Text>
                  </div>
                  <div className="flex justify-between">
                    <Text>Days Remaining:</Text>
                    <Text strong>{refundCalculation.daysRemaining} of {refundCalculation.totalDays} days</Text>
                  </div>
                  <div className="flex justify-between">
                    <Text>Refund Amount:</Text>
                    <Text strong className="text-green-600">${(refundCalculation.refundableAmount / 100).toFixed(2)} {refundCalculation.currency.toUpperCase()}</Text>
                  </div>
                </div>
              }
              type="info"
              showIcon
              className="mb-4"
            />

            <div className="mb-4">
              <Text className="block mb-2">Reason for refund (optional):</Text>
              <Input.TextArea
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                placeholder="Please tell us why you're requesting a refund..."
                rows={3}
              />
            </div>

            <div className="space-y-3">
              <Button
                type="primary"
                block
                onClick={handleRequestRefund}
                loading={refundLoading}
              >
                Confirm Refund of ${(refundCalculation.refundableAmount / 100).toFixed(2)}
              </Button>

              <Button
                block
                onClick={() => {
                  setRefundModalOpen(false);
                  setRefundReason('');
                  setRefundCalculation(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <Alert
            message="Unable to calculate refund"
            description="Please try again later or contact support."
            type="error"
            showIcon
          />
        )}
      </Modal>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Row,
  Col,
  Table,
  Tag,
  Space,
  Spin,
  message,
  Progress,
  Typography,
  Tooltip,
  Badge,
  Alert,
  DatePicker,
  Button,
} from 'antd';
import {
  DollarOutlined,
  TeamOutlined,
  RiseOutlined,
  FallOutlined,
  CrownOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  UserAddOutlined,
  UserDeleteOutlined,
  ClockCircleOutlined,
  PercentageOutlined,
  TrophyOutlined,
  ThunderboltOutlined,
  SafetyCertificateOutlined,
  FilterOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import api from '../../services/api';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

const { Title, Text } = Typography;

interface ProfessionalMetrics {
  // Revenue Metrics
  mrr: number;
  arr: number;
  netRevenue: number;
  revenueGrowth: number;
  // Subscription Metrics
  activeSubscriptions: number;
  newThisMonth: number;
  churnedThisMonth: number;
  churnRate: number;
  // Customer Value Metrics
  arpu: number;
  ltv: number;
  trialConversionRate: number;
  // Billing Split
  monthlySubscribers: number;
  yearlySubscribers: number;
  // Health Indicators
  paymentSuccessRate: number;
  failedPayments: number;
  pastDueCount: number;
  expiringTrials: number;
  // Revenue Trend
  revenueTrend: { month: string; revenue: number; subscriptions: number }[];
  // Plan Performance
  planPerformance: {
    planName: string;
    subscribers: number;
    mrr: number;
    churnRate: number;
    growth: number;
  }[];
}

interface RecentSubscription {
  id: string;
  tenantName: string;
  planName: string;
  billingCycle: string;
  amount: number;
  subscribedAt: string;
  status: string;
}

interface SubscriptionStats {
  totalSubscriptions: number;
  activeSubscriptions: number;
  trialSubscriptions: number;
  monthlyRevenue: number;
  yearlyRevenue: number;
  totalRevenue: number;
  planBreakdown: {
    planId: string;
    planName: string;
    monthlyPrice: number;
    yearlyPrice: number;
    subscriberCount: number;
    monthlySubscribers: number;
    yearlySubscribers: number;
    revenue: number;
  }[];
  recentSubscriptions: RecentSubscription[];
}

// KPI Card Component
interface KPICardProps {
  title: string;
  value: number | string;
  prefix?: React.ReactNode;
  suffix?: string;
  trend?: number;
  trendLabel?: string;
  description?: string;
  color: string;
  bgColor: string;
  precision?: number;
  isCurrency?: boolean;
  isPercentage?: boolean;
}

function KPICard({
  title,
  value,
  prefix,
  suffix,
  trend,
  trendLabel,
  description,
  color,
  bgColor,
  precision = 0,
  isCurrency = false,
  isPercentage = false,
}: KPICardProps) {
  const formatValue = () => {
    if (typeof value === 'string') return value;
    if (isCurrency) return `$${value.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
    if (isPercentage) return `${value.toFixed(precision)}%`;
    return value.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision });
  };

  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 hover:shadow-md transition-all duration-200 h-full">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-gray-500 text-sm font-medium mb-1">{title}</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-gray-900">{formatValue()}</span>
            {suffix && <span className="text-gray-500 text-sm">{suffix}</span>}
          </div>
          {trend !== undefined && (
            <div className={`flex items-center gap-1 mt-2 text-xs font-medium ${trend >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {trend >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
              <span>{Math.abs(trend).toFixed(1)}%</span>
              {trendLabel && <span className="text-gray-400 ml-1">{trendLabel}</span>}
            </div>
          )}
          {description && (
            <p className="text-gray-400 text-xs mt-1">{description}</p>
          )}
        </div>
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${bgColor}`}>
          <span className={`text-xl ${color}`}>{prefix}</span>
        </div>
      </div>
    </div>
  );
}

// Section Header Component
function SectionHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white">
        {icon}
      </div>
      <div>
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
      </div>
    </div>
  );
}

// Health Indicator Component
function HealthIndicator({
  label,
  value,
  status,
  icon,
}: {
  label: string;
  value: number | string;
  status: 'success' | 'warning' | 'error';
  icon: React.ReactNode;
}) {
  const statusColors = {
    success: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700', icon: 'text-green-500' },
    warning: { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-700', icon: 'text-yellow-500' },
    error: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', icon: 'text-red-500' },
  };
  const colors = statusColors[status];

  return (
    <div className={`rounded-lg p-4 ${colors.bg} border ${colors.border}`}>
      <div className="flex items-center gap-3">
        <span className={`text-lg ${colors.icon}`}>{icon}</span>
        <div>
          <p className="text-gray-600 text-xs font-medium">{label}</p>
          <p className={`text-lg font-bold ${colors.text}`}>{value}</p>
        </div>
      </div>
    </div>
  );
}

const COLORS = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899'];

interface SubscriptionListItem {
  id: string;
  tenantName: string;
  planName: string;
  billingCycle: string;
  amount: number;
  subscribedAt: string;
  status: string;
}

interface SubscriptionsListResponse {
  data: SubscriptionListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export default function SubscriptionsPage() {
  const [metrics, setMetrics] = useState<ProfessionalMetrics | null>(null);
  const [stats, setStats] = useState<SubscriptionStats | null>(null);
  const [loading, setLoading] = useState(true);
  
  // Subscriptions List State
  const [subscriptions, setSubscriptions] = useState<SubscriptionListItem[]>([]);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10, total: 0 });
  const [startDate, setStartDate] = useState<Dayjs | null>(null);
  const [endDate, setEndDate] = useState<Dayjs | null>(null);

  const fetchSubscriptions = useCallback(async (page = 1, pageSize = 10) => {
    setSubscriptionsLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('page', page.toString());
      params.append('limit', pageSize.toString());
      if (startDate) {
        params.append('startDate', startDate.format('YYYY-MM-DD'));
      }
      if (endDate) {
        params.append('endDate', endDate.format('YYYY-MM-DD'));
      }
      
      const response = await api.get<SubscriptionsListResponse>(`/admin/subscriptions-list?${params.toString()}`);
      setSubscriptions(response.data.data);
      setPagination({
        current: response.data.page,
        pageSize: response.data.limit,
        total: response.data.total,
      });
    } catch (error) {
      message.error('Failed to fetch subscriptions list');
    } finally {
      setSubscriptionsLoading(false);
    }
  }, [startDate, endDate]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [metricsRes, statsRes] = await Promise.all([
        api.get('/admin/professional-metrics'),
        api.get('/admin/subscription-stats'),
      ]);
      setMetrics(metricsRes.data);
      setStats(statsRes.data);
    } catch (error) {
      message.error('Failed to fetch subscription metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    fetchSubscriptions();
  }, []);

  // Handle table pagination change
  const handleTableChange = (newPagination: { current?: number; pageSize?: number }) => {
    fetchSubscriptions(newPagination.current || 1, newPagination.pageSize || 10);
  };

  // Handle filter apply
  const handleFilterApply = () => {
    fetchSubscriptions(1, pagination.pageSize);
  };

  // Handle filter reset
  const handleFilterReset = () => {
    setStartDate(null);
    setEndDate(null);
    // Fetch with no filters after reset
    setSubscriptionsLoading(true);
    api.get<SubscriptionsListResponse>('/admin/subscriptions-list?page=1&limit=10')
      .then((response) => {
        setSubscriptions(response.data.data);
        setPagination({
          current: response.data.page,
          pageSize: response.data.limit,
          total: response.data.total,
        });
      })
      .catch(() => message.error('Failed to fetch subscriptions'))
      .finally(() => setSubscriptionsLoading(false));
  };

  const planColumns: ColumnsType<ProfessionalMetrics['planPerformance'][0]> = [
    {
      title: 'Plan',
      dataIndex: 'planName',
      key: 'planName',
      render: (name: string) => (
        <Space>
          <CrownOutlined style={{ color: '#faad14' }} />
          <Text strong>{name}</Text>
        </Space>
      ),
    },
    {
      title: 'Subscribers',
      dataIndex: 'subscribers',
      key: 'subscribers',
      render: (count: number) => (
        <span className="font-semibold">{count}</span>
      ),
      sorter: (a, b) => a.subscribers - b.subscribers,
    },
    {
      title: 'MRR',
      dataIndex: 'mrr',
      key: 'mrr',
      render: (mrr: number) => (
        <Text strong style={{ color: '#52c41a' }}>
          ${mrr.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </Text>
      ),
      sorter: (a, b) => a.mrr - b.mrr,
    },
    {
      title: 'Growth',
      dataIndex: 'growth',
      key: 'growth',
      render: (growth: number) => (
        <Tag color={growth >= 0 ? 'green' : 'red'} className="flex items-center gap-1 w-fit">
          {growth >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
          {Math.abs(growth).toFixed(1)}%
        </Tag>
      ),
      sorter: (a, b) => a.growth - b.growth,
    },
    {
      title: 'Churn Rate',
      dataIndex: 'churnRate',
      key: 'churnRate',
      render: (rate: number) => (
        <Tag color={rate <= 2 ? 'green' : rate <= 5 ? 'orange' : 'red'}>
          {rate.toFixed(1)}%
        </Tag>
      ),
      sorter: (a, b) => a.churnRate - b.churnRate,
    },
  ];

  const subscriptionColumns: ColumnsType<SubscriptionListItem> = [
    {
      title: 'Building',
      dataIndex: 'tenantName',
      key: 'tenantName',
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Plan',
      dataIndex: 'planName',
      key: 'planName',
      render: (plan: string) => <Tag color="blue">{plan}</Tag>,
    },
    {
      title: 'Billing',
      dataIndex: 'billingCycle',
      key: 'billingCycle',
      render: (cycle: string) => (
        <Tag color={cycle === 'yearly' ? 'green' : 'default'}>
          {cycle === 'yearly' ? 'Yearly' : 'Monthly'}
        </Tag>
      ),
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => (
        <Text strong style={{ color: '#52c41a' }}>${amount.toFixed(2)}</Text>
      ),
    },
    {
      title: 'Subscribed',
      dataIndex: 'subscribedAt',
      key: 'subscribedAt',
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const colors: Record<string, string> = {
          active: 'success',
          trial: 'warning',
          suspended: 'error',
        };
        return <Tag color={colors[status] || 'default'}>{status.toUpperCase()}</Tag>;
      },
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spin size="large" />
      </div>
    );
  }

  if (!metrics || !stats) {
    return <Alert type="error" message="Failed to load metrics" />;
  }

  // Prepare pie chart data for billing split
  const billingPieData = [
    { name: 'Monthly', value: metrics.monthlySubscribers },
    { name: 'Yearly', value: metrics.yearlySubscribers },
  ];

  // Determine health status
  const getPaymentHealthStatus = () => {
    if (metrics.paymentSuccessRate >= 98) return 'success';
    if (metrics.paymentSuccessRate >= 95) return 'warning';
    return 'error';
  };

  const getChurnHealthStatus = () => {
    if (metrics.churnRate <= 2) return 'success';
    if (metrics.churnRate <= 5) return 'warning';
    return 'error';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Title level={3} className="mb-0">Subscription & Earnings Dashboard</Title>
        {/* <Tag color="blue" className="text-sm">
          <CalendarOutlined className="mr-1" />
          Updated: {new Date().toLocaleDateString()}
        </Tag> */}
      </div>

      {/* Alerts Section */}
      {(metrics.expiringTrials > 0 || metrics.failedPayments > 0 || metrics.pastDueCount > 0) && (
        <div className="space-y-2">
          {metrics.expiringTrials > 0 && (
            <Alert
              type="warning"
              showIcon
              icon={<ClockCircleOutlined />}
              message={`${metrics.expiringTrials} trial(s) expiring in the next 7 days`}
              className="border border-yellow-200"
            />
          )}
          {metrics.failedPayments > 0 && (
            <Alert
              type="error"
              showIcon
              icon={<CloseCircleOutlined />}
              message={`${metrics.failedPayments} failed payment(s) this month`}
              className="border border-red-200"
            />
          )}
          {metrics.pastDueCount > 0 && (
            <Alert
              type="warning"
              showIcon
              icon={<WarningOutlined />}
              message={`${metrics.pastDueCount} subscription(s) past due`}
              className="border border-yellow-200"
            />
          )}
        </div>
      )}

      {/* Primary Revenue KPIs */}
      <div className="mb-6">
        <SectionHeader
          icon={<DollarOutlined />}
          title="Revenue Metrics"
          subtitle="Key financial indicators"
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="Monthly Recurring Revenue"
              value={metrics.mrr}
              prefix={<DollarOutlined />}
              trend={metrics.revenueGrowth}
              trendLabel="vs last month"
              color="text-green-600"
              bgColor="bg-green-100"
              precision={2}
              isCurrency
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="Annual Recurring Revenue"
              value={metrics.arr}
              prefix={<CalendarOutlined />}
              description="Projected yearly revenue"
              color="text-blue-600"
              bgColor="bg-blue-100"
              precision={2}
              isCurrency
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="Net Revenue (This Month)"
              value={metrics.netRevenue}
              prefix={<TrophyOutlined />}
              description="After Stripe fees"
              color="text-purple-600"
              bgColor="bg-purple-100"
              precision={2}
              isCurrency
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="Revenue Growth"
              value={metrics.revenueGrowth}
              prefix={metrics.revenueGrowth >= 0 ? <RiseOutlined /> : <FallOutlined />}
              description="Month-over-month change"
              color={metrics.revenueGrowth >= 0 ? 'text-green-600' : 'text-red-600'}
              bgColor={metrics.revenueGrowth >= 0 ? 'bg-green-100' : 'bg-red-100'}
              precision={1}
              isPercentage
            />
          </Col>
        </Row>
      </div>

      {/* Customer Value Metrics */}
      <div className="mb-6">
        <SectionHeader
          icon={<TeamOutlined />}
          title="Customer Value Metrics"
          subtitle="Subscriber economics"
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="ARPU (Avg Revenue Per User)"
              value={metrics.arpu}
              prefix={<UserAddOutlined />}
              description="Monthly revenue per subscriber"
              color="text-indigo-600"
              bgColor="bg-indigo-100"
              precision={2}
              isCurrency
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="Customer Lifetime Value"
              value={metrics.ltv}
              prefix={<TrophyOutlined />}
              description="Predicted total revenue per customer"
              color="text-amber-600"
              bgColor="bg-amber-100"
              precision={2}
              isCurrency
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="Trial Conversion Rate"
              value={metrics.trialConversionRate}
              prefix={<PercentageOutlined />}
              description="Trials converting to paid"
              color="text-cyan-600"
              bgColor="bg-cyan-100"
              precision={1}
              isPercentage
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="Churn Rate"
              value={metrics.churnRate}
              prefix={<UserDeleteOutlined />}
              description="Monthly subscriber loss"
              color={metrics.churnRate <= 2 ? 'text-green-600' : metrics.churnRate <= 5 ? 'text-yellow-600' : 'text-red-600'}
              bgColor={metrics.churnRate <= 2 ? 'bg-green-100' : metrics.churnRate <= 5 ? 'bg-yellow-100' : 'bg-red-100'}
              precision={1}
              isPercentage
            />
          </Col>
        </Row>
      </div>

      {/* Subscription Metrics */}
      <div className="mb-6">
        <SectionHeader
          icon={<SafetyCertificateOutlined />}
          title="Subscription Metrics"
          subtitle="Current subscriber status"
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="Active Subscriptions"
              value={metrics.activeSubscriptions}
              prefix={<CheckCircleOutlined />}
              description="Currently paying customers"
              color="text-green-600"
              bgColor="bg-green-100"
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="New This Month"
              value={metrics.newThisMonth}
              prefix={<UserAddOutlined />}
              description="New subscribers"
              color="text-blue-600"
              bgColor="bg-blue-100"
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <KPICard
              title="Churned This Month"
              value={metrics.churnedThisMonth}
              prefix={<UserDeleteOutlined />}
              description="Lost subscribers"
              color="text-red-600"
              bgColor="bg-red-100"
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 h-full">
              <p className="text-gray-500 text-sm font-medium mb-3">Billing Cycle Split</p>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-600">Monthly</span>
                    <span className="font-semibold">{metrics.monthlySubscribers}</span>
                  </div>
                  <Progress
                    percent={metrics.activeSubscriptions > 0 ? (metrics.monthlySubscribers / metrics.activeSubscriptions) * 100 : 0}
                    size="small"
                    strokeColor="#6366f1"
                    showInfo={false}
                  />
                </div>
                <div className="flex-1">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-600">Yearly</span>
                    <span className="font-semibold">{metrics.yearlySubscribers}</span>
                  </div>
                  <Progress
                    percent={metrics.activeSubscriptions > 0 ? (metrics.yearlySubscribers / metrics.activeSubscriptions) * 100 : 0}
                    size="small"
                    strokeColor="#10b981"
                    showInfo={false}
                  />
                </div>
              </div>
            </div>
          </Col>
        </Row>
      </div>

      {/* Health Indicators */}
      <div className="mb-6">
        <SectionHeader
          icon={<ThunderboltOutlined />}
          title="Business Health Indicators"
          subtitle="Operational metrics requiring attention"
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <HealthIndicator
              label="Payment Success Rate"
              value={`${metrics.paymentSuccessRate.toFixed(1)}%`}
              status={getPaymentHealthStatus()}
              icon={<CheckCircleOutlined />}
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <HealthIndicator
              label="Failed Payments"
              value={metrics.failedPayments}
              status={metrics.failedPayments === 0 ? 'success' : metrics.failedPayments <= 2 ? 'warning' : 'error'}
              icon={<CloseCircleOutlined />}
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <HealthIndicator
              label="Past Due Accounts"
              value={metrics.pastDueCount}
              status={metrics.pastDueCount === 0 ? 'success' : metrics.pastDueCount <= 2 ? 'warning' : 'error'}
              icon={<WarningOutlined />}
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <HealthIndicator
              label="Expiring Trials (7 days)"
              value={metrics.expiringTrials}
              status={metrics.expiringTrials === 0 ? 'success' : 'warning'}
              icon={<ClockCircleOutlined />}
            />
          </Col>
        </Row>
      </div>

      {/* Charts Row */}
      <Row gutter={[24, 24]}>
        {/* Revenue Trend Chart */}
        <Col xs={24} lg={16}>
          <Card
            title={
              <div className="flex items-center gap-2">
                <RiseOutlined className="text-indigo-500" />
                <span>Revenue Trend (Last 12 Months)</span>
              </div>
            }
            className="h-full"
          >
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={metrics.revenueTrend}>
                <defs>
                  <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
                />
                <RechartsTooltip
                  formatter={(value: number) => [`$${value.toLocaleString()}`, 'Revenue']}
                  contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb' }}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="#6366f1"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorRevenue)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        </Col>

        {/* Billing Split Pie Chart */}
        <Col xs={24} lg={8}>
          <Card
            title={
              <div className="flex items-center gap-2">
                <CalendarOutlined className="text-green-500" />
                <span>Billing Cycle Distribution</span>
              </div>
            }
            className="h-full"
          >
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={billingPieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={5}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {billingPieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={index === 0 ? '#6366f1' : '#10b981'} />
                  ))}
                </Pie>
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>

      {/* Plan Performance Table */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <CrownOutlined className="text-yellow-500" />
            <span>Plan Performance</span>
          </div>
        }
      >
        <Table
          columns={planColumns}
          dataSource={metrics.planPerformance}
          rowKey="planName"
          pagination={false}
          className="[&_.ant-table-thead_th]:bg-gray-50"
        />
      </Card>

      {/* Subscribed Buildings List */}
      <Card
        title={
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <TeamOutlined className="text-blue-500" />
              <span>Subscribed Buildings</span>
              <Tag color="blue">{pagination.total} total</Tag>
            </div>
          </div>
        }
      >
        {/* Filters */}
        <div className="mb-4 p-4 bg-gray-50 rounded-lg">
          <div className="flex flex-wrap items-center gap-4">
            <DatePicker
              value={startDate}
              onChange={(date) => setStartDate(date)}
              placeholder="Start Date"
              allowClear
              className="w-36"
            />
            <DatePicker
              value={endDate}
              onChange={(date) => setEndDate(date)}
              placeholder="End Date"
              allowClear
              className="w-36"
            />
            <Space>
              <Button
                type="primary"
                onClick={handleFilterApply}
              >
                Apply
              </Button>
              <Button
                icon={<ReloadOutlined />}
                onClick={handleFilterReset}
              >
                Reset
              </Button>
            </Space>
          </div>
        </div>

        <Table
          columns={subscriptionColumns}
          dataSource={subscriptions}
          rowKey="id"
          loading={subscriptionsLoading}
          scroll={{ x: 1000 }}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} buildings`,
          }}
          onChange={(pag) => handleTableChange({ current: pag.current, pageSize: pag.pageSize })}
          className="[&_.ant-table-thead_th]:bg-gray-50"
        />
      </Card>
    </div>
  );
}

import { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Statistic,
  Table,
  Tag,
  Space,
  Spin,
  message,
  Progress,
  Typography,
} from 'antd';
import {
  DollarOutlined,
  TeamOutlined,
  RiseOutlined,
  CrownOutlined,
  CalendarOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import api from '../../services/api';

const { Title, Text } = Typography;

interface PlanBreakdown {
  planId: string;
  planName: string;
  monthlyPrice: number;
  yearlyPrice: number;
  subscriberCount: number;
  monthlySubscribers: number;
  yearlySubscribers: number;
  revenue: number;
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
  planBreakdown: PlanBreakdown[];
  recentSubscriptions: RecentSubscription[];
}

export default function SubscriptionsPage() {
  const [stats, setStats] = useState<SubscriptionStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const response = await api.get('/admin/subscription-stats');
      setStats(response.data);
    } catch (error) {
      message.error('Failed to fetch subscription statistics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const planColumns: ColumnsType<PlanBreakdown> = [
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
      title: 'Monthly Price',
      dataIndex: 'monthlyPrice',
      key: 'monthlyPrice',
      render: (price: number) => `$${price.toFixed(2)}/mo`,
    },
    {
      title: 'Yearly Price',
      dataIndex: 'yearlyPrice',
      key: 'yearlyPrice',
      render: (price: number) => `$${price.toFixed(2)}/yr`,
    },
    {
      title: 'Subscribers',
      key: 'subscribers',
      render: (_, record) => (
        <Space direction="vertical" size="small">
          <Text>{record.subscriberCount} total</Text>
          <Text type="secondary" className="text-xs">
            {record.monthlySubscribers} monthly, {record.yearlySubscribers} yearly
          </Text>
        </Space>
      ),
    },
    {
      title: 'Monthly Revenue',
      dataIndex: 'revenue',
      key: 'revenue',
      render: (revenue: number) => (
        <Text strong style={{ color: '#52c41a' }}>
          ${revenue.toFixed(2)}
        </Text>
      ),
      sorter: (a, b) => a.revenue - b.revenue,
    },
  ];

  const recentColumns: ColumnsType<RecentSubscription> = [
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
      render: (amount: number) => `$${amount.toFixed(2)}`,
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

  if (!stats) {
    return <div>Failed to load statistics</div>;
  }

  const activeRate = stats.totalSubscriptions > 0
    ? Math.round((stats.activeSubscriptions / stats.totalSubscriptions) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <Title level={3}>Subscription & Earnings Dashboard</Title>

      {/* Revenue Stats */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Monthly Revenue"
              value={stats.monthlyRevenue}
              precision={2}
              prefix={<DollarOutlined />}
              valueStyle={{ color: '#3f8600' }}
            />
            <Text type="secondary" className="text-xs">
              From monthly subscriptions
            </Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Yearly Revenue"
              value={stats.yearlyRevenue}
              precision={2}
              prefix={<DollarOutlined />}
              valueStyle={{ color: '#1890ff' }}
            />
            <Text type="secondary" className="text-xs">
              From yearly subscriptions
            </Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Total Revenue"
              value={stats.totalRevenue}
              precision={2}
              prefix={<RiseOutlined />}
              valueStyle={{ color: '#722ed1' }}
            />
            <Text type="secondary" className="text-xs">
              Combined revenue
            </Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="ARR (Annual Run Rate)"
              value={stats.monthlyRevenue * 12 + stats.yearlyRevenue}
              precision={2}
              prefix={<CalendarOutlined />}
              valueStyle={{ color: '#fa8c16' }}
            />
            <Text type="secondary" className="text-xs">
              Projected annual revenue
            </Text>
          </Card>
        </Col>
      </Row>

      {/* Subscription Stats */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="Total Subscriptions"
              value={stats.totalSubscriptions}
              prefix={<TeamOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="Active Subscriptions"
              value={stats.activeSubscriptions}
              valueStyle={{ color: '#52c41a' }}
            />
            <Progress
              percent={activeRate}
              size="small"
              status="active"
              showInfo={false}
            />
            <Text type="secondary" className="text-xs">
              {activeRate}% of total
            </Text>
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="Trial Users"
              value={stats.trialSubscriptions}
              valueStyle={{ color: '#faad14' }}
            />
            <Text type="secondary" className="text-xs">
              Potential conversions
            </Text>
          </Card>
        </Col>
      </Row>

      {/* Plan Breakdown */}
      <Card title="Revenue by Plan">
        <Table
          columns={planColumns}
          dataSource={stats.planBreakdown}
          rowKey="planId"
          pagination={false}
        />
      </Card>

      {/* Recent Subscriptions */}
      <Card title="Recent Subscriptions">
        <Table
          columns={recentColumns}
          dataSource={stats.recentSubscriptions}
          rowKey="id"
          pagination={false}
        />
      </Card>
    </div>
  );
}

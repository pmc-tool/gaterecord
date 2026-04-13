import { useEffect, useState, useCallback } from 'react';
import {
  Row,
  Col,
  Table,
  Tag,
  Spin,
  Progress,
  Alert,
  List,
  Badge,
  Tooltip,
  Button,
  notification,
  Card,
} from 'antd';
import {
  GatewayOutlined,
  CheckCircleOutlined,
  HistoryOutlined,
  DollarOutlined,
  RiseOutlined,
  FallOutlined,
  TeamOutlined,
  BuildOutlined,
  WarningOutlined,
  ClockCircleOutlined,
  UserOutlined,
  ThunderboltOutlined,
  AlertOutlined,
  SoundOutlined,
  ExclamationCircleOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  SafetyCertificateOutlined,
  CloudOutlined,
  CalendarOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useGateStore } from '../../store/gateStore';
import { eventsService, EventsStats } from '../../services/events.service';
import { GateState, AccessEvent, AccessResult, UserRole } from '../../types';
import { useAuthStore } from '../../store/authStore';
import { socketService } from '../../services/socket.service';
import api from '../../services/api';
import dayjs from 'dayjs';

// Security Alert types
interface SecurityAlert {
  id: string;
  type: string;
  status: string;
  priority: string;
  title: string;
  description: string;
  visitorName: string | null;
  gateName: string | null;
  buzzerTriggered: boolean;
  createdAt: string;
}

interface AlertStats {
  active: number;
  acknowledged: number;
  resolved: number;
  falseAlarms: number;
  today: number;
}


const priorityColors: Record<string, string> = {
  low: 'blue',
  medium: 'orange',
  high: 'red',
  critical: 'magenta',
};

// Stat Card Component
interface StatCardProps {
  title: string;
  value: number | string;
  prefix?: React.ReactNode;
  suffix?: string;
  trend?: number;
  trendLabel?: string;
  color: string;
  bgColor: string;
  precision?: number;
}

function StatCard({ title, value, prefix, suffix, trend, trendLabel, color, bgColor, precision = 0 }: StatCardProps) {
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 hover:shadow-md transition-all duration-200">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-gray-500 text-sm font-medium mb-1">{title}</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-gray-900">
              {typeof value === 'number' ? value.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision }) : value}
            </span>
            {suffix && <span className="text-gray-500 text-sm">{suffix}</span>}
          </div>
          {trend !== undefined && (
            <div className={`flex items-center gap-1 mt-2 text-xs font-medium ${trend >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {trend >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
              <span>{Math.abs(trend)}%</span>
              {trendLabel && <span className="text-gray-400 ml-1">{trendLabel}</span>}
            </div>
          )}
        </div>
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${bgColor}`}>
          <span className={`text-xl ${color}`}>{prefix}</span>
        </div>
      </div>
    </div>
  );
}

// Security Alerts Dashboard Section Component
function SecurityAlertsDashboard() {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [stats, setStats] = useState<AlertStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [buzzerActive, setBuzzerActive] = useState(false);

  const fetchAlerts = useCallback(async () => {
    try {
      const response = await api.get('/security-alerts/active');
      setAlerts(response.data);
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const response = await api.get('/security-alerts/stats');
      setStats(response.data);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([fetchAlerts(), fetchStats()]);
      setLoading(false);
    };

    loadData();

    const unsubNew = socketService.on<SecurityAlert>('security:alert:new', (data) => {
      notification.error({
        message: (
          <span className="flex items-center gap-2">
            <SoundOutlined className="animate-pulse" style={{ color: '#ff4d4f' }} />
            SECURITY ALERT
          </span>
        ),
        description: (
          <div>
            <strong>{data.title}</strong>
            <br />
            <span>{data.description}</span>
            <br />
            <Button
              type="primary"
              danger
              size="small"
              className="mt-2"
              onClick={() => navigate('/security-alerts')}
            >
              View Details
            </Button>
          </div>
        ),
        icon: <AlertOutlined style={{ color: '#ff4d4f' }} className="animate-bounce" />,
        duration: 0,
        placement: 'topRight',
      });

      setAlerts((prev) => [data, ...prev]);
      fetchStats();

      if (data.buzzerTriggered) {
        setBuzzerActive(true);
        playAlarmSound();
      }
    });

    const unsubUpdate = socketService.on<Partial<SecurityAlert>>('security:alert:update', (data) => {
      setAlerts((prev) =>
        prev.map((alert) =>
          alert.id === data.id ? { ...alert, ...data } : alert
        ).filter((alert) => alert.status === 'active')
      );
      fetchStats();
    });

    const unsubBuzzerStop = socketService.on<{ alertId: string }>('security:buzzer:stop', () => {
      setBuzzerActive(false);
      stopAlarmSound();
    });

    return () => {
      unsubNew();
      unsubUpdate();
      unsubBuzzerStop();
    };
  }, [fetchAlerts, fetchStats, navigate]);

  const playAlarmSound = () => {
    try {
      const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = 800;
      oscillator.type = 'square';
      gainNode.gain.value = 0.2;

      oscillator.start();

      (window as unknown as { alarmOscillator?: OscillatorNode }).alarmOscillator = oscillator;
      (window as unknown as { alarmAudioContext?: AudioContext }).alarmAudioContext = audioContext;
    } catch (e) {
      console.error('Failed to play alarm sound:', e);
    }
  };

  const stopAlarmSound = () => {
    const oscillator = (window as unknown as { alarmOscillator?: OscillatorNode }).alarmOscillator;
    const audioContext = (window as unknown as { alarmAudioContext?: AudioContext }).alarmAudioContext;

    if (oscillator) {
      oscillator.stop();
      delete (window as unknown as { alarmOscillator?: OscillatorNode }).alarmOscillator;
    }
    if (audioContext) {
      audioContext.close();
      delete (window as unknown as { alarmAudioContext?: AudioContext }).alarmAudioContext;
    }
  };

  const handleAcknowledge = async (id: string) => {
    try {
      await api.patch(`/security-alerts/${id}/acknowledge`);
      fetchAlerts();
      fetchStats();
      setBuzzerActive(false);
      stopAlarmSound();
    } catch (error) {
      console.error('Failed to acknowledge alert:', error);
    }
  };

  if (loading) {
    return null;
  }

  const hasActiveAlerts = alerts.length > 0;

  return (
    <div className="mb-8">
      {buzzerActive && (
        <Alert
          type="error"
          showIcon
          icon={<SoundOutlined className="animate-pulse" />}
          message={
            <span className="flex items-center gap-2 font-bold">
              <span className="animate-pulse">ALARM ACTIVE - UNAUTHORIZED VISITOR DETECTED</span>
            </span>
          }
          className="mb-4 animate-pulse border-2 border-red-500"
          style={{ backgroundColor: '#fff2f0' }}
        />
      )}

      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${hasActiveAlerts ? 'bg-red-100' : 'bg-gray-100'}`}>
            <AlertOutlined className={`text-lg ${hasActiveAlerts ? 'text-red-600' : 'text-gray-600'}`} />
          </div>
          <div>
            <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
              Security Alerts
              {hasActiveAlerts && (
                <Badge count={alerts.length} style={{ backgroundColor: '#ff4d4f' }} />
              )}
            </h3>
            <p className="text-xs text-gray-500">Real-time security monitoring</p>
          </div>
        </div>
        <Button onClick={() => navigate('/security-alerts')}>View All</Button>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <StatCard
            title="Active"
            value={stats?.active || 0}
            prefix={<ExclamationCircleOutlined />}
            color={(stats?.active || 0) > 0 ? 'text-red-600' : 'text-green-600'}
            bgColor={(stats?.active || 0) > 0 ? 'bg-red-100' : 'bg-green-100'}
          />
        </Col>
        <Col xs={12} sm={6}>
          <StatCard
            title="Acknowledged"
            value={stats?.acknowledged || 0}
            prefix={<ClockCircleOutlined />}
            color="text-amber-600"
            bgColor="bg-amber-100"
          />
        </Col>
        <Col xs={12} sm={6}>
          <StatCard
            title="Resolved Today"
            value={stats?.resolved || 0}
            prefix={<CheckCircleOutlined />}
            color="text-green-600"
            bgColor="bg-green-100"
          />
        </Col>
        <Col xs={12} sm={6}>
          <StatCard
            title="Total Today"
            value={stats?.today || 0}
            prefix={<HistoryOutlined />}
            color="text-blue-600"
            bgColor="bg-blue-100"
          />
        </Col>

        {hasActiveAlerts && (
          <Col span={24}>
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <div className="flex items-center gap-2 text-red-700 font-semibold mb-3">
                <WarningOutlined className="animate-pulse" />
                Active Alerts - Immediate Attention Required
              </div>
              <List
                size="small"
                dataSource={alerts.slice(0, 5)}
                renderItem={(alert) => (
                  <List.Item
                    className="!border-red-100"
                    actions={[
                      <Button
                        key="ack"
                        type="primary"
                        size="small"
                        onClick={() => handleAcknowledge(alert.id)}
                      >
                        Acknowledge
                      </Button>
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<Badge status="processing" color="red" />}
                      title={
                        <span className="flex items-center gap-2">
                          <Tag color={priorityColors[alert.priority]}>{alert.priority.toUpperCase()}</Tag>
                          {alert.title}
                        </span>
                      }
                      description={
                        <span className="text-xs text-gray-500">
                          {alert.gateName} - {dayjs(alert.createdAt).format('HH:mm:ss')}
                        </span>
                      }
                    />
                  </List.Item>
                )}
              />
            </div>
          </Col>
        )}
      </Row>
    </div>
  );
}

const stateColors: Record<GateState, string> = {
  [GateState.CLOSED]: 'default',
  [GateState.OPENING]: 'processing',
  [GateState.OPEN]: 'success',
  [GateState.CLOSING]: 'processing',
  [GateState.OBSTACLE_HOLD]: 'warning',
  [GateState.FAULT]: 'error',
  [GateState.MANUAL_OVERRIDE]: 'purple',
};

interface SuperAdminDashboardData {
  mrr: number;
  arr: number;
  totalRevenue: number;
  monthlySubscriptionsRevenue: number;
  yearlySubscriptionsRevenue: number;
  revenueGrowth: number;
  totalTenants: number;
  activeTenants: number;
  trialTenants: number;
  suspendedTenants: number;
  newTenantsThisMonth: number;
  totalUsers: number;
  totalResidents: number;
  totalGates: number;
  onlineGates: number;
  totalEventsToday: number;
  totalEventsThisMonth: number;
  planDistribution: { planName: string; count: number; revenue: number }[];
  recentTenants: { id: string; name: string; planName: string; status: string; createdAt: string }[];
  expiringTrials: { id: string; name: string; expiresAt: string; daysLeft: number }[];
  tenantsAtLimit: { id: string; name: string; limitType: string; current: number; max: number }[];
}

interface SubscriptionStatsData {
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
    // Lifetime revenue from actual payments
    lifetimeMonthlyRevenue: number;
    lifetimeYearlyRevenue: number;
    lifetimeTotalRevenue: number;
    monthlyPaymentCount: number;
    yearlyPaymentCount: number;
  }[];
}

// Dashboard Header Component
function DashboardHeader({ userName, role }: { userName: string; role: string }) {
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <div className="mb-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {getGreeting()}, {userName}
          </h1>
          <p className="text-gray-500 mt-1 flex items-center gap-2">
            <CalendarOutlined />
            {dayjs().format('dddd, MMMM D, YYYY')}
            <span className="text-gray-300">|</span>
            <span className="capitalize">{role.replace('_', ' ')}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 rounded-full">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
            System Online
          </div>
        </div>
      </div>
    </div>
  );
}

// Section Header Component
function SectionHeader({ icon, title, subtitle, action }: { icon: React.ReactNode; title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center mb-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white">
          {icon}
        </div>
        <div>
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

// Super Admin Dashboard Component
function SuperAdminDashboard() {
  const { user } = useAuthStore();
  const [data, setData] = useState<SuperAdminDashboardData | null>(null);
  const [subscriptionStats, setSubscriptionStats] = useState<SubscriptionStatsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const [dashboardRes, statsRes] = await Promise.all([
        api.get('/admin/dashboard'),
        api.get('/admin/subscription-stats'),
      ]);
      setData(dashboardRes.data);
      setSubscriptionStats(statsRes.data);
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  if (!data) {
    return <Alert type="error" message="Failed to load dashboard data" />;
  }

  // Commented out - used by commented Recent Buildings section
  // const statusColors: Record<string, string> = {
  //   active: 'green',
  //   trial: 'blue',
  //   suspended: 'red',
  //   expired: 'default',
  // };

  return (
    <div>
      <DashboardHeader
        userName={user?.firstName || 'Admin'}
        role={user?.role || 'super_admin'}
      />

      <SecurityAlertsDashboard />

      {/* Financial Metrics */}
      <div className="mb-8">
        <SectionHeader
          icon={<DollarOutlined />}
          title="Financial Overview"
          subtitle="Revenue and growth metrics"
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <StatCard
              title="Monthly Subscriptions"
              value={data.monthlySubscriptionsRevenue}
              prefix={<DollarOutlined />}
              color="text-green-600"
              bgColor="bg-green-100"
              precision={2}
              suffix="/month"
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <StatCard
              title="Annual Subscriptions"
              value={data.yearlySubscriptionsRevenue}
              prefix={<DollarOutlined />}
              color="text-blue-600"
              bgColor="bg-blue-100"
              precision={2}
              suffix="/year"
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <StatCard
              title="Total Revenue"
              value={data.totalRevenue}
              prefix={<DollarOutlined />}
              color="text-indigo-600"
              bgColor="bg-indigo-100"
              precision={2}
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <StatCard
              title="Subscribed Buildings"
              value={data.activeTenants}
              prefix={<BuildOutlined />}
              color="text-green-600"
              bgColor="bg-green-100"
              suffix="active"
            />
          </Col>
        </Row>
      </div>

      {/* Platform Overview */}
      <div className="mb-8">
        <SectionHeader
          icon={<CloudOutlined />}
          title="Platform Overview"
          subtitle="System-wide statistics"
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p className="text-gray-500 text-sm font-medium">Total Buildings</p>
                  <span className="text-2xl font-bold text-gray-900">{data.totalTenants}</span>
                </div>
                <div className="w-12 h-12 rounded-xl bg-indigo-100 flex items-center justify-center">
                  <BuildOutlined className="text-xl text-indigo-600" />
                </div>
              </div>
              <div className="flex gap-3 text-xs">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-500"></span>
                  {data.activeTenants} Active
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                  {data.trialTenants} Trial
                </span>
                {data.suspendedTenants > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-red-500"></span>
                    {data.suspendedTenants} Suspended
                  </span>
                )}
              </div>
            </div>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p className="text-gray-500 text-sm font-medium">Total Users</p>
                  <span className="text-2xl font-bold text-gray-900">{data.totalUsers}</span>
                </div>
                <div className="w-12 h-12 rounded-xl bg-cyan-100 flex items-center justify-center">
                  <TeamOutlined className="text-xl text-cyan-600" />
                </div>
              </div>
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <UserOutlined />
                {data.totalResidents} residents registered
              </div>
            </div>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="text-gray-500 text-sm font-medium">Total Gates</p>
                  <span className="text-2xl font-bold text-gray-900">{data.totalGates}</span>
                </div>
                <div className="w-12 h-12 rounded-xl bg-orange-100 flex items-center justify-center">
                  <GatewayOutlined className="text-xl text-orange-600" />
                </div>
              </div>
              <Progress
                percent={data.totalGates > 0 ? Math.round((data.onlineGates / data.totalGates) * 100) : 0}
                size="small"
                format={() => <span className="text-xs">{data.onlineGates} online</span>}
                strokeColor={{ '0%': '#10b981', '100%': '#059669' }}
              />
            </div>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p className="text-gray-500 text-sm font-medium">Events Today</p>
                  <span className="text-2xl font-bold text-gray-900">{data.totalEventsToday.toLocaleString()}</span>
                </div>
                <div className="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center">
                  <ThunderboltOutlined className="text-xl text-amber-600" />
                </div>
              </div>
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <HistoryOutlined />
                {data.totalEventsThisMonth.toLocaleString()} this month
              </div>
            </div>
          </Col>
        </Row>
      </div>

      {/* Commented out: Revenue by Plan - Full Width with Detailed Table */}
      <Card
        className="shadow-sm"
        title={
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white">
              <DollarOutlined />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-gray-900 m-0">Revenue by Plan</h3>
                <Tag color="blue">{subscriptionStats?.planBreakdown?.length || 0} plans</Tag>
              </div>
              <p className="text-xs text-gray-500 m-0">Detailed subscription and revenue breakdown</p>
            </div>
          </div>
        }
      >
        <Table
          dataSource={subscriptionStats?.planBreakdown || []}
          rowKey="planId"
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showQuickJumper: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} plans`,
          }}
          size="middle"
          className="[&_.ant-table-thead_th]:bg-gray-50 [&_.ant-table-thead_th]:text-xs [&_.ant-table-thead_th]:font-semibold [&_.ant-table-thead_th]:text-gray-600"
          columns={[
            {
              title: 'Plan',
              dataIndex: 'planName',
              key: 'planName',
              render: (name: string) => (
                <div className="flex items-center gap-2">
                  <SafetyCertificateOutlined className="text-yellow-500" />
                  <span className="font-semibold text-gray-900">{name}</span>
                </div>
              ),
            },
            {
              title: 'Monthly Price',
              dataIndex: 'monthlyPrice',
              key: 'monthlyPrice',
              render: (price: number) => (
                <span className="text-gray-700">${price.toFixed(2)}/mo</span>
              ),
            },
            {
              title: 'Yearly Price',
              dataIndex: 'yearlyPrice',
              key: 'yearlyPrice',
              render: (price: number) => (
                <span className="text-gray-700">${price.toFixed(2)}/yr</span>
              ),
            },
            {
              title: 'Subscribers',
              key: 'subscribers',
              render: (_: unknown, record: SubscriptionStatsData['planBreakdown'][0]) => (
                <div>
                  <div className="font-medium text-gray-900">
                    <span className={record.subscriberCount > 0 ? 'text-green-600' : 'text-orange-500'}>
                      {record.subscriberCount} total
                    </span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {record.monthlySubscribers} monthly, {record.yearlySubscribers} yearly
                  </div>
                </div>
              ),
            },
            {
              title: 'Monthly Revenue',
              dataIndex: 'revenue',
              key: 'revenue',
              align: 'right',
              sorter: (a, b) => a.revenue - b.revenue,
              render: (revenue: number) => (
                <span className={`font-bold ${revenue > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                  ${revenue.toFixed(2)}
                </span>
              ),
            },
            {
              title: 'Lifetime Monthly',
              key: 'lifetimeMonthly',
              align: 'right',
              sorter: (a, b) => (a.lifetimeMonthlyRevenue || 0) - (b.lifetimeMonthlyRevenue || 0),
              render: (_: unknown, record: SubscriptionStatsData['planBreakdown'][0]) => (
                <div className="text-right">
                  <div className={`font-bold ${(record.lifetimeMonthlyRevenue || 0) > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
                    ${(record.lifetimeMonthlyRevenue || 0).toFixed(2)}
                  </div>
                  <div className="text-xs text-gray-500">
                    {record.monthlyPaymentCount || 0} payments
                  </div>
                </div>
              ),
            },
            {
              title: 'Lifetime Yearly',
              key: 'lifetimeYearly',
              align: 'right',
              sorter: (a, b) => (a.lifetimeYearlyRevenue || 0) - (b.lifetimeYearlyRevenue || 0),
              render: (_: unknown, record: SubscriptionStatsData['planBreakdown'][0]) => (
                <div className="text-right">
                  <div className={`font-bold ${(record.lifetimeYearlyRevenue || 0) > 0 ? 'text-purple-600' : 'text-gray-400'}`}>
                    ${(record.lifetimeYearlyRevenue || 0).toFixed(2)}
                  </div>
                  <div className="text-xs text-gray-500">
                    {record.yearlyPaymentCount || 0} payments
                  </div>
                </div>
              ),
            },
            {
              title: 'Total Lifetime',
              key: 'lifetimeTotal',
              align: 'right',
              sorter: (a, b) => (a.lifetimeTotalRevenue || 0) - (b.lifetimeTotalRevenue || 0),
              render: (_: unknown, record: SubscriptionStatsData['planBreakdown'][0]) => (
                <span className={`font-bold ${(record.lifetimeTotalRevenue || 0) > 0 ? 'text-green-700' : 'text-gray-400'}`}>
                  ${(record.lifetimeTotalRevenue || 0).toFixed(2)}
                </span>
              ),
            },
          ]}
        />
      </Card>
     

      {/* Commented out: Recent Tenants and simple Revenue by Plan sections
      <Row gutter={[24, 24]}>
        <Col xs={24} lg={12}>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 h-full">
            <div className="p-5 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white">
                  <BuildOutlined />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-900">Recent Buildings</h3>
                  <p className="text-xs text-gray-500">Newly registered properties</p>
                </div>
              </div>
            </div>
            <div className="p-5">
              <List
                size="small"
                dataSource={data.recentTenants}
                renderItem={(tenant) => (
                  <List.Item className="!px-0">
                    <div className="flex items-center gap-3 w-full">
                      <Avatar
                        size={40}
                        className="bg-gradient-to-br from-blue-500 to-indigo-600"
                        icon={<BuildOutlined />}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 truncate">{tenant.name}</span>
                          <Tag color={statusColors[tenant.status]} className="rounded-full text-xs">
                            {tenant.status}
                          </Tag>
                        </div>
                        <p className="text-xs text-gray-500">
                          {tenant.planName} · {dayjs(tenant.createdAt).format('MMM D, YYYY')}
                        </p>
                      </div>
                    </div>
                  </List.Item>
                )}
              />
            </div>
          </div>
        </Col>
      </Row>
      */}

      {/* Alerts Section */}
      {(data.expiringTrials.length > 0 || data.tenantsAtLimit.length > 0) && (
        <div className="mt-8">
          <SectionHeader
            icon={<WarningOutlined />}
            title="Alerts & Warnings"
            subtitle="Items requiring attention"
          />
          <Row gutter={[24, 24]}>
            {data.expiringTrials.length > 0 && (
              <Col xs={24} lg={12}>
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-amber-700 font-semibold mb-4">
                    <ClockCircleOutlined />
                    Expiring Trials
                  </div>
                  <List
                    size="small"
                    dataSource={data.expiringTrials}
                    renderItem={(trial) => (
                      <List.Item className="!border-amber-200 !px-0">
                        <div className="flex justify-between w-full items-center">
                          <span className="font-medium text-gray-700">{trial.name}</span>
                          <Tag color={trial.daysLeft <= 2 ? 'red' : 'orange'} className="rounded-full">
                            {trial.daysLeft} day{trial.daysLeft !== 1 ? 's' : ''} left
                          </Tag>
                        </div>
                      </List.Item>
                    )}
                  />
                </div>
              </Col>
            )}

            {data.tenantsAtLimit.length > 0 && (
              <Col xs={24} lg={12}>
                <div className="bg-red-50 border border-red-200 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-red-700 font-semibold mb-4">
                    <WarningOutlined />
                    Approaching Limits
                  </div>
                  <List
                    size="small"
                    dataSource={data.tenantsAtLimit}
                    renderItem={(tenant) => (
                      <List.Item className="!border-red-200 !px-0">
                        <div className="flex justify-between w-full items-center gap-4">
                          <div>
                            <span className="font-medium text-gray-700">{tenant.name}</span>
                            <span className="text-gray-400 text-xs ml-2">({tenant.limitType})</span>
                          </div>
                          <Tooltip title={`${tenant.current} of ${tenant.max} used`}>
                            <Progress
                              percent={Math.round((tenant.current / tenant.max) * 100)}
                              size="small"
                              style={{ width: 100 }}
                              strokeColor={tenant.current >= tenant.max ? '#ef4444' : '#f59e0b'}
                            />
                          </Tooltip>
                        </div>
                      </List.Item>
                    )}
                  />
                </div>
              </Col>
            )}
          </Row>
        </div>
      )}
    </div>
  );
}

// Regular Dashboard Component
function RegularDashboard() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const { gates, fetchGates, isLoading } = useGateStore();
  const showSecurityAlerts = [UserRole.BUILDING_ADMIN, UserRole.SECURITY].includes(user?.role as UserRole);
  const [stats, setStats] = useState<EventsStats | null>(null);
  const [recentEvents, setRecentEvents] = useState<AccessEvent[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    fetchGates();
    loadStats();
    loadRecentEvents();
  }, []);

  const loadStats = async () => {
    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const data = await eventsService.getStats(
        startOfDay.toISOString(),
        now.toISOString()
      );
      setStats(data);
    } catch (error) {
      console.error('Failed to load stats:', error);
    } finally {
      setStatsLoading(false);
    }
  };

  const loadRecentEvents = async () => {
    try {
      const events = await eventsService.getLive(undefined, 10);
      setRecentEvents(events);
    } catch (error) {
      console.error('Failed to load recent events:', error);
    }
  };

  const onlineGates = gates.filter((g) => g.isOnline).length;
  const successRate = stats?.totalEvents ? Math.round((stats.allowedCount / stats.totalEvents) * 100) : 0;

  const eventColumns = [
    {
      title: 'TIME',
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 100,
      render: (ts: string) => (
        <span className="text-gray-600 font-mono text-xs">
          {new Date(ts).toLocaleTimeString()}
        </span>
      ),
    },
    {
      title: 'GATE',
      dataIndex: 'gateName',
      key: 'gateName',
      render: (name: string) => <span className="font-medium">{name}</span>,
    },
    {
      title: 'METHOD',
      dataIndex: 'method',
      key: 'method',
      render: (method: string) => (
        <Tag className="rounded-full text-xs">{method.replace('_', ' ').toUpperCase()}</Tag>
      ),
    },
    {
      title: 'SUBJECT',
      dataIndex: 'subjectName',
      key: 'subjectName',
      render: (name: string) => name || <span className="text-gray-400">—</span>,
    },
    {
      title: 'RESULT',
      dataIndex: 'result',
      key: 'result',
      width: 100,
      render: (result: AccessResult) => (
        <Tag
          color={result === AccessResult.ALLOWED ? 'success' : 'error'}
          className="rounded-full"
        >
          {result.toUpperCase()}
        </Tag>
      ),
    },
  ];

  const gateColumns = [
    {
      title: 'NAME',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <span className="font-medium">{name}</span>,
    },
    {
      title: 'TYPE',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => (
        <Tag className="rounded-full text-xs">{type.toUpperCase()}</Tag>
      ),
    },
    {
      title: 'STATE',
      dataIndex: 'state',
      key: 'state',
      render: (state: GateState) => (
        <Tag color={stateColors[state]} className="rounded-full">{state}</Tag>
      ),
    },
    {
      title: 'STATUS',
      dataIndex: 'isOnline',
      key: 'isOnline',
      width: 100,
      render: (online: boolean) => (
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${online ? 'bg-green-500' : 'bg-red-500'}`}></span>
          <span className={online ? 'text-green-600' : 'text-red-600'}>
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
      ),
    },
  ];

  if (isLoading || statsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      <DashboardHeader
        userName={user?.firstName || 'User'}
        role={user?.role || 'user'}
      />

      {showSecurityAlerts && <SecurityAlertsDashboard />}

      {/* Stats Cards */}
      <Row gutter={[16, 16]} className="mb-8">
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            title="Total Gates"
            value={gates.length}
            prefix={<GatewayOutlined />}
            color="text-blue-600"
            bgColor="bg-blue-100"
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            title="Online Gates"
            value={onlineGates}
            prefix={<CheckCircleOutlined />}
            color="text-green-600"
            bgColor="bg-green-100"
            suffix={`of ${gates.length}`}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            title="Today's Events"
            value={stats?.totalEvents || 0}
            prefix={<HistoryOutlined />}
            color="text-purple-600"
            bgColor="bg-purple-100"
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-gray-500 text-sm font-medium">Success Rate</p>
                <span className="text-2xl font-bold text-gray-900">{successRate}%</span>
              </div>
              <div className="w-12 h-12 rounded-xl bg-emerald-100 flex items-center justify-center">
                <SafetyCertificateOutlined className="text-xl text-emerald-600" />
              </div>
            </div>
            <Progress
              percent={successRate}
              size="small"
              showInfo={false}
              strokeColor={{ '0%': '#10b981', '100%': '#059669' }}
            />
            <div className="flex justify-between text-xs text-gray-500 mt-2">
              <span>{stats?.allowedCount || 0} allowed</span>
              <span>{stats?.deniedCount || 0} denied</span>
            </div>
          </div>
        </Col>
      </Row>

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={12}>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 h-full">
            <div className="p-5 border-b border-gray-100 flex justify-between items-center">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white">
                  <GatewayOutlined />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-900">Gates Overview</h3>
                  <p className="text-xs text-gray-500">All registered gates</p>
                </div>
              </div>
              <Button size="small" onClick={() => navigate('/gates')}>View All</Button>
            </div>
            <div className="p-5">
              <Table
                dataSource={gates}
                columns={gateColumns}
                rowKey="id"
                pagination={false}
                size="small"
                className="[&_.ant-table-thead_th]:bg-gray-50 [&_.ant-table-thead_th]:text-xs [&_.ant-table-thead_th]:font-semibold [&_.ant-table-thead_th]:text-gray-600"
              />
            </div>
          </div>
        </Col>
        <Col xs={24} lg={12}>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 h-full">
            <div className="p-5 border-b border-gray-100 flex justify-between items-center">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center text-white">
                  <HistoryOutlined />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-900">Recent Access Events</h3>
                  <p className="text-xs text-gray-500">Latest gate activity</p>
                </div>
              </div>
              <Button size="small" onClick={() => navigate('/events')}>View All</Button>
            </div>
            <div className="p-5">
              <Table
                dataSource={recentEvents}
                columns={eventColumns}
                rowKey="id"
                pagination={false}
                size="small"
                className="[&_.ant-table-thead_th]:bg-gray-50 [&_.ant-table-thead_th]:text-xs [&_.ant-table-thead_th]:font-semibold [&_.ant-table-thead_th]:text-gray-600"
              />
            </div>
          </div>
        </Col>
      </Row>
    </div>
  );
}

// Main Dashboard Page
export function DashboardPage() {
  const { user } = useAuthStore();

  if (user?.role === UserRole.SUPER_ADMIN) {
    return <SuperAdminDashboard />;
  }

  return <RegularDashboard />;
}

export default DashboardPage;

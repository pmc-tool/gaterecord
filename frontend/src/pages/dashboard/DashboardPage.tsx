import { useEffect, useState, useCallback } from 'react';
import {
  Row,
  Col,
  Card,
  Statistic,
  Table,
  Tag,
  Typography,
  Spin,
  Progress,
  Alert,
  List,
  Badge,
  Tooltip,
  Button,
  notification,
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

const { Title, Text } = Typography;

const priorityColors: Record<string, string> = {
  low: 'blue',
  medium: 'orange',
  high: 'red',
  critical: 'magenta',
};

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

    // Subscribe to real-time security alerts
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
    <div className="mb-6">
      {/* Active Alert Banner */}
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

      <div className="flex justify-between items-center mb-3">
        <Text strong className="text-lg flex items-center gap-2">
          <AlertOutlined style={{ color: hasActiveAlerts ? '#ff4d4f' : undefined }} />
          Security Alerts
          {hasActiveAlerts && (
            <Badge count={alerts.length} style={{ backgroundColor: '#ff4d4f' }} />
          )}
        </Text>
        <Button size="small" onClick={() => navigate('/security-alerts')}>
          View All
        </Button>
      </div>

      <Row gutter={[16, 16]}>
        {/* Stats Cards */}
        <Col xs={12} sm={6}>
          <Card
            size="small"
            className={hasActiveAlerts ? 'border-red-400 bg-red-50' : ''}
            style={hasActiveAlerts ? { animation: 'pulse 2s infinite' } : {}}
          >
            <Statistic
              title="Active"
              value={stats?.active || 0}
              valueStyle={{ color: (stats?.active || 0) > 0 ? '#ff4d4f' : '#52c41a', fontSize: 24 }}
              prefix={<ExclamationCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic
              title="Acknowledged"
              value={stats?.acknowledged || 0}
              valueStyle={{ color: '#faad14', fontSize: 24 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic
              title="Resolved Today"
              value={stats?.resolved || 0}
              valueStyle={{ color: '#52c41a', fontSize: 24 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic
              title="Total Today"
              value={stats?.today || 0}
              valueStyle={{ fontSize: 24 }}
            />
          </Card>
        </Col>

        {/* Active Alerts List */}
        {hasActiveAlerts && (
          <Col span={24}>
            <Card
              size="small"
              className="border-red-400"
              title={
                <span className="flex items-center gap-2 text-red-600">
                  <WarningOutlined className="animate-pulse" />
                  Active Alerts - Immediate Attention Required
                </span>
              }
            >
              <List
                size="small"
                dataSource={alerts.slice(0, 5)}
                renderItem={(alert) => (
                  <List.Item
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
                      avatar={
                        <Badge
                          status="processing"
                          color="red"
                        />
                      }
                      title={
                        <span className="flex items-center gap-2">
                          <Tag color={priorityColors[alert.priority]}>{alert.priority.toUpperCase()}</Tag>
                          {alert.title}
                        </span>
                      }
                      description={
                        <span className="text-xs">
                          {alert.gateName} - {dayjs(alert.createdAt).format('HH:mm:ss')}
                        </span>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          </Col>
        )}
      </Row>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      `}</style>
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

interface SuperAdminDashboard {
  mrr: number;
  arr: number;
  totalRevenue: number;
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

// Super Admin Dashboard Component
function SuperAdminDashboard() {
  const [data, setData] = useState<SuperAdminDashboard | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const response = await api.get('/admin/dashboard');
      setData(response.data);
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

  const statusColors: Record<string, string> = {
    active: 'green',
    trial: 'blue',
    suspended: 'red',
    expired: 'default',
  };

  return (
    <div>
      <Title level={4} className="mb-6">
        Super Admin Dashboard
      </Title>

      {/* Security Alerts Section */}
      <SecurityAlertsDashboard />

      {/* Financial Metrics */}
      <div className="mb-6">
        <Text strong className="text-lg mb-3 block">Financial Overview</Text>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <Card className="h-full">
              <Statistic
                title="Monthly Recurring Revenue"
                value={data.mrr}
                prefix={<DollarOutlined />}
                precision={2}
                valueStyle={{ color: '#52c41a' }}
              />
              <div className="mt-2">
                <Text type="secondary">MRR</Text>
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card className="h-full">
              <Statistic
                title="Annual Recurring Revenue"
                value={data.arr}
                prefix={<DollarOutlined />}
                precision={2}
                valueStyle={{ color: '#1890ff' }}
              />
              <div className="mt-2">
                <Text type="secondary">ARR (MRR x 12)</Text>
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card className="h-full">
              <Statistic
                title="Revenue Growth"
                value={data.revenueGrowth}
                prefix={data.revenueGrowth >= 0 ? <RiseOutlined /> : <FallOutlined />}
                suffix="%"
                precision={1}
                valueStyle={{ color: data.revenueGrowth >= 0 ? '#52c41a' : '#ff4d4f' }}
              />
              <div className="mt-2">
                <Text type="secondary">vs last month</Text>
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card className="h-full">
              <Statistic
                title="New This Month"
                value={data.newTenantsThisMonth}
                prefix={<BuildOutlined />}
                valueStyle={{ color: '#722ed1' }}
              />
              <div className="mt-2">
                <Text type="secondary">New buildings</Text>
              </div>
            </Card>
          </Col>
        </Row>
      </div>

      {/* Platform Overview */}
      <div className="mb-6">
        <Text strong className="text-lg mb-3 block">Platform Overview</Text>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <Card className="h-full">
              <Statistic
                title="Total Buildings"
                value={data.totalTenants}
                prefix={<BuildOutlined />}
              />
              <div className="mt-3">
                <div className="flex justify-between text-xs">
                  <span><Badge color="green" /> Active: {data.activeTenants}</span>
                  <span><Badge color="blue" /> Trial: {data.trialTenants}</span>
                </div>
                {data.suspendedTenants > 0 && (
                  <div className="text-xs mt-1">
                    <Badge color="red" /> Suspended: {data.suspendedTenants}
                  </div>
                )}
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card className="h-full">
              <Statistic
                title="Total Users"
                value={data.totalUsers}
                prefix={<TeamOutlined />}
              />
              <div className="mt-3 text-xs">
                <UserOutlined /> {data.totalResidents} residents
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card className="h-full">
              <Statistic
                title="Total Gates"
                value={data.totalGates}
                prefix={<GatewayOutlined />}
              />
              <div className="mt-3">
                <Progress
                  percent={data.totalGates > 0 ? Math.round((data.onlineGates / data.totalGates) * 100) : 0}
                  size="small"
                  format={() => `${data.onlineGates} online`}
                  status={data.onlineGates === data.totalGates ? 'success' : 'normal'}
                />
              </div>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card className="h-full">
              <Statistic
                title="Access Events Today"
                value={data.totalEventsToday}
                prefix={<ThunderboltOutlined />}
                valueStyle={{ color: '#faad14' }}
              />
              <div className="mt-3 text-xs">
                <HistoryOutlined /> {data.totalEventsThisMonth.toLocaleString()} this month
              </div>
            </Card>
          </Col>
        </Row>
      </div>

      <Row gutter={[16, 16]}>
        {/* Plan Distribution */}
        <Col xs={24} lg={12}>
          <Card title="Revenue by Plan" className="h-full">
            <Table
              dataSource={data.planDistribution}
              rowKey="planName"
              pagination={false}
              size="small"
              columns={[
                {
                  title: 'Plan',
                  dataIndex: 'planName',
                  key: 'planName',
                  render: (name: string) => <Text strong>{name}</Text>,
                },
                {
                  title: 'Subscribers',
                  dataIndex: 'count',
                  key: 'count',
                  align: 'center',
                  render: (count: number) => <Tag color="blue">{count}</Tag>,
                },
                {
                  title: 'MRR',
                  dataIndex: 'revenue',
                  key: 'revenue',
                  align: 'right',
                  render: (revenue: number) => (
                    <Text strong style={{ color: '#52c41a' }}>
                      ${revenue.toFixed(2)}
                    </Text>
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        {/* Recent Tenants */}
        <Col xs={24} lg={12}>
          <Card title="Recent Buildings" className="h-full">
            <List
              size="small"
              dataSource={data.recentTenants}
              renderItem={(tenant) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <span className="flex items-center gap-2">
                        {tenant.name}
                        <Tag color={statusColors[tenant.status]}>{tenant.status}</Tag>
                      </span>
                    }
                    description={
                      <span className="text-xs">
                        {tenant.planName} - {dayjs(tenant.createdAt).format('MMM D, YYYY')}
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>

      {/* Alerts Section */}
      {(data.expiringTrials.length > 0 || data.tenantsAtLimit.length > 0) && (
        <div className="mt-6">
          <Text strong className="text-lg mb-3 block">Alerts & Warnings</Text>
          <Row gutter={[16, 16]}>
            {data.expiringTrials.length > 0 && (
              <Col xs={24} lg={12}>
                <Card
                  title={
                    <span className="flex items-center gap-2">
                      <ClockCircleOutlined style={{ color: '#faad14' }} />
                      Expiring Trials
                    </span>
                  }
                  className="border-yellow-300"
                >
                  <List
                    size="small"
                    dataSource={data.expiringTrials}
                    renderItem={(trial) => (
                      <List.Item>
                        <div className="flex justify-between w-full">
                          <Text>{trial.name}</Text>
                          <Tag color={trial.daysLeft <= 2 ? 'red' : 'orange'}>
                            {trial.daysLeft} day{trial.daysLeft !== 1 ? 's' : ''} left
                          </Tag>
                        </div>
                      </List.Item>
                    )}
                  />
                </Card>
              </Col>
            )}

            {data.tenantsAtLimit.length > 0 && (
              <Col xs={24} lg={12}>
                <Card
                  title={
                    <span className="flex items-center gap-2">
                      <WarningOutlined style={{ color: '#ff4d4f' }} />
                      Approaching Limits
                    </span>
                  }
                  className="border-red-300"
                >
                  <List
                    size="small"
                    dataSource={data.tenantsAtLimit}
                    renderItem={(tenant) => (
                      <List.Item>
                        <div className="flex justify-between w-full items-center">
                          <div>
                            <Text>{tenant.name}</Text>
                            <Text type="secondary" className="ml-2">({tenant.limitType})</Text>
                          </div>
                          <Tooltip title={`${tenant.current} of ${tenant.max} used`}>
                            <Progress
                              percent={Math.round((tenant.current / tenant.max) * 100)}
                              size="small"
                              style={{ width: 100 }}
                              status={tenant.current >= tenant.max ? 'exception' : 'normal'}
                            />
                          </Tooltip>
                        </div>
                      </List.Item>
                    )}
                  />
                </Card>
              </Col>
            )}
          </Row>
        </div>
      )}
    </div>
  );
}

// Regular Dashboard Component (for other users)
function RegularDashboard() {
  const { user } = useAuthStore();
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

  const eventColumns = [
    {
      title: 'Time',
      dataIndex: 'timestamp',
      key: 'timestamp',
      render: (ts: string) => new Date(ts).toLocaleTimeString(),
    },
    {
      title: 'Gate',
      dataIndex: 'gateName',
      key: 'gateName',
    },
    {
      title: 'Method',
      dataIndex: 'method',
      key: 'method',
      render: (method: string) => (
        <Tag>{method.replace('_', ' ').toUpperCase()}</Tag>
      ),
    },
    {
      title: 'Subject',
      dataIndex: 'subjectName',
      key: 'subjectName',
      render: (name: string) => name || '-',
    },
    {
      title: 'Result',
      dataIndex: 'result',
      key: 'result',
      render: (result: AccessResult) => (
        <Tag color={result === AccessResult.ALLOWED ? 'success' : 'error'}>
          {result.toUpperCase()}
        </Tag>
      ),
    },
  ];

  const gateColumns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => <Tag>{type.toUpperCase()}</Tag>,
    },
    {
      title: 'State',
      dataIndex: 'state',
      key: 'state',
      render: (state: GateState) => (
        <Tag color={stateColors[state]}>{state}</Tag>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'isOnline',
      key: 'isOnline',
      render: (online: boolean) => (
        <Tag color={online ? 'success' : 'error'}>
          {online ? 'Online' : 'Offline'}
        </Tag>
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
      <Title level={4} className="mb-6">
        Dashboard
      </Title>

      {/* Security Alerts Section - Only for admins and security */}
      {showSecurityAlerts && <SecurityAlertsDashboard />}

      <Row gutter={[16, 16]} className="mb-6">
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Total Gates"
              value={gates.length}
              prefix={<GatewayOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Online Gates"
              value={onlineGates}
              valueStyle={{ color: '#52c41a' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Today's Events"
              value={stats?.totalEvents || 0}
              prefix={<HistoryOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Access Granted"
              value={stats?.allowedCount || 0}
              valueStyle={{ color: '#52c41a' }}
              suffix={`/ ${stats?.deniedCount || 0} denied`}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="Gates Overview" className="h-full">
            <Table
              dataSource={gates}
              columns={gateColumns}
              rowKey="id"
              pagination={false}
              size="small"
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="Recent Access Events" className="h-full">
            <Table
              dataSource={recentEvents}
              columns={eventColumns}
              rowKey="id"
              pagination={false}
              size="small"
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

// Main Dashboard Page - shows different content based on user role
export function DashboardPage() {
  const { user } = useAuthStore();

  if (user?.role === UserRole.SUPER_ADMIN) {
    return <SuperAdminDashboard />;
  }

  return <RegularDashboard />;
}

export default DashboardPage;

import { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Table, Tag, Typography, Spin } from 'antd';
import { GatewayOutlined, CheckCircleOutlined, HistoryOutlined } from '@ant-design/icons';
import { useGateStore } from '../../store/gateStore';
import { eventsService, EventsStats } from '../../services/events.service';
import { GateState, AccessEvent, AccessResult } from '../../types';

const { Title } = Typography;

const stateColors: Record<GateState, string> = {
  [GateState.CLOSED]: 'default',
  [GateState.OPENING]: 'processing',
  [GateState.OPEN]: 'success',
  [GateState.CLOSING]: 'processing',
  [GateState.OBSTACLE_HOLD]: 'warning',
  [GateState.FAULT]: 'error',
  [GateState.MANUAL_OVERRIDE]: 'purple',
};

export function DashboardPage() {
  const { gates, fetchGates, isLoading } = useGateStore();
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

export default DashboardPage;

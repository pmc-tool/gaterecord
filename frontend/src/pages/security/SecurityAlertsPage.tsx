import { useEffect, useState, useCallback } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Space,
  Typography,
  Statistic,
  Row,
  Col,
  Modal,
  Input,
  Badge,
  Alert,
  notification,
} from 'antd';
import {
  WarningOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SoundOutlined,
  ExclamationCircleOutlined,
  BellOutlined,
} from '@ant-design/icons';
import { ColumnsType } from 'antd/es/table';
import api from '../../services/api';
import { socketService } from '../../services/socket.service';

const { Title, Text } = Typography;
const { TextArea } = Input;

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
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  tenant?: { name: string };
  resident?: { firstName: string; lastName: string };
  acknowledgedBy?: { firstName: string; lastName: string };
  resolvedBy?: { firstName: string; lastName: string };
}

interface AlertStats {
  active: number;
  acknowledged: number;
  resolved: number;
  falseAlarms: number;
  today: number;
}

const statusColors: Record<string, string> = {
  active: 'error',
  acknowledged: 'warning',
  resolved: 'success',
  false_alarm: 'default',
};

const priorityColors: Record<string, string> = {
  low: 'blue',
  medium: 'orange',
  high: 'red',
  critical: 'magenta',
};

export function SecurityAlertsPage() {
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [stats, setStats] = useState<AlertStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('active');
  const [buzzerActive, setBuzzerActive] = useState(false);

  const fetchAlerts = useCallback(async () => {
    try {
      const params = statusFilter ? { status: statusFilter } : {};
      const response = await api.get('/security-alerts', { params });
      setAlerts(response.data);
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
    }
  }, [statusFilter]);

  const fetchStats = async () => {
    try {
      const response = await api.get('/security-alerts/stats');
      setStats(response.data);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  };

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
        message: 'SECURITY ALERT',
        description: (
          <div>
            <strong>{data.title}</strong>
            <br />
            {data.description}
          </div>
        ),
        icon: <WarningOutlined style={{ color: '#ff4d4f' }} />,
        duration: 0,
        placement: 'topRight',
      });

      // Add to list if matching filter or showing all
      if (!statusFilter || statusFilter === 'active') {
        setAlerts((prev) => [data, ...prev]);
      }

      // Update stats
      fetchStats();

      // Check for buzzer
      if (data.buzzerTriggered) {
        setBuzzerActive(true);
        playAlarmSound();
      }
    });

    const unsubUpdate = socketService.on<SecurityAlert>('security:alert:update', (data) => {
      setAlerts((prev) =>
        prev.map((alert) =>
          alert.id === data.id ? { ...alert, ...data } : alert
        )
      );
      fetchStats();
    });

    const unsubBuzzerStart = socketService.on<{ alertId: string }>('security:buzzer:start', () => {
      setBuzzerActive(true);
      playAlarmSound();
    });

    const unsubBuzzerStop = socketService.on<{ alertId: string }>('security:buzzer:stop', () => {
      setBuzzerActive(false);
      stopAlarmSound();
    });

    return () => {
      unsubNew();
      unsubUpdate();
      unsubBuzzerStart();
      unsubBuzzerStop();
    };
  }, [statusFilter, fetchAlerts]);

  const playAlarmSound = () => {
    // Create alarm sound using Web Audio API
    const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 800;
    oscillator.type = 'square';
    gainNode.gain.value = 0.3;

    oscillator.start();

    // Store reference for stopping
    (window as unknown as { alarmOscillator?: OscillatorNode }).alarmOscillator = oscillator;
    (window as unknown as { alarmAudioContext?: AudioContext }).alarmAudioContext = audioContext;
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
      notification.success({ message: 'Alert acknowledged' });
    } catch (error) {
      notification.error({ message: 'Failed to acknowledge alert' });
    }
  };

  const handleResolve = async (id: string) => {
    let notes = '';

    Modal.confirm({
      title: 'Resolve Security Alert',
      icon: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
      content: (
        <div>
          <p>Add resolution notes (optional):</p>
          <TextArea
            rows={3}
            placeholder="Describe how the incident was resolved..."
            onChange={(e) => (notes = e.target.value)}
          />
        </div>
      ),
      okText: 'Resolve',
      onOk: async () => {
        try {
          await api.patch(`/security-alerts/${id}/resolve`, { notes });
          fetchAlerts();
          fetchStats();
          notification.success({ message: 'Alert resolved' });
        } catch (error) {
          notification.error({ message: 'Failed to resolve alert' });
        }
      },
    });
  };

  const handleFalseAlarm = async (id: string) => {
    let notes = '';

    Modal.confirm({
      title: 'Mark as False Alarm',
      icon: <CloseCircleOutlined style={{ color: '#faad14' }} />,
      content: (
        <div>
          <p>Are you sure this was a false alarm?</p>
          <TextArea
            rows={3}
            placeholder="Add notes about why this is a false alarm..."
            onChange={(e) => (notes = e.target.value)}
          />
        </div>
      ),
      okText: 'Mark as False Alarm',
      okType: 'default',
      onOk: async () => {
        try {
          await api.patch(`/security-alerts/${id}/false-alarm`, { notes });
          fetchAlerts();
          fetchStats();
          setBuzzerActive(false);
          stopAlarmSound();
          notification.success({ message: 'Marked as false alarm' });
        } catch (error) {
          notification.error({ message: 'Failed to mark as false alarm' });
        }
      },
    });
  };

  const columns: ColumnsType<SecurityAlert> = [
    {
      title: 'Priority',
      dataIndex: 'priority',
      key: 'priority',
      width: 100,
      render: (priority: string) => (
        <Tag color={priorityColors[priority]}>
          {priority.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Alert',
      key: 'alert',
      render: (_, record) => (
        <div>
          <Text strong>{record.title}</Text>
          <br />
          <Text type="secondary" className="text-sm">
            {record.description}
          </Text>
        </div>
      ),
    },
    {
      title: 'Location',
      key: 'location',
      render: (_, record) => (
        <div>
          <Text>{record.gateName || 'Unknown Gate'}</Text>
          {record.tenant && (
            <>
              <br />
              <Text type="secondary" className="text-xs">{record.tenant.name}</Text>
            </>
          )}
        </div>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string) => (
        <Badge
          status={status === 'active' ? 'processing' : status === 'acknowledged' ? 'warning' : 'success'}
          text={
            <Tag color={statusColors[status]}>
              {status.replace('_', ' ').toUpperCase()}
            </Tag>
          }
        />
      ),
    },
    {
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (date: string) => (
        <Text className="text-sm">
          {new Date(date).toLocaleString()}
        </Text>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_, record) => (
        <Space size="small">
          {record.status === 'active' && (
            <>
              <Button
                type="primary"
                size="small"
                onClick={() => handleAcknowledge(record.id)}
              >
                Acknowledge
              </Button>
              <Button
                size="small"
                onClick={() => handleFalseAlarm(record.id)}
              >
                False Alarm
              </Button>
            </>
          )}
          {record.status === 'acknowledged' && (
            <Button
              type="primary"
              size="small"
              onClick={() => handleResolve(record.id)}
            >
              Resolve
            </Button>
          )}
          {(record.status === 'resolved' || record.status === 'false_alarm') && (
            <Text type="secondary" className="text-xs">
              {record.resolvedBy && `By ${record.resolvedBy.firstName}`}
            </Text>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <Title level={4} className="mb-0">Security Alerts</Title>
        {buzzerActive && (
          <Alert
            type="error"
            showIcon
            icon={<SoundOutlined className="animate-pulse" />}
            message="ALARM ACTIVE"
            className="animate-pulse"
          />
        )}
      </div>

      {stats && (
        <Row gutter={16} className="mb-4">
          <Col xs={12} sm={6}>
            <Card
              hoverable
              onClick={() => setStatusFilter('active')}
              className={statusFilter === 'active' ? 'border-2 border-red-500' : ''}
            >
              <Statistic
                title="Active Alerts"
                value={stats.active}
                valueStyle={{ color: stats.active > 0 ? '#cf1322' : '#3f8600' }}
                prefix={<ExclamationCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card
              hoverable
              onClick={() => setStatusFilter('acknowledged')}
              className={statusFilter === 'acknowledged' ? 'border-2 border-orange-500' : ''}
            >
              <Statistic
                title="Acknowledged"
                value={stats.acknowledged}
                valueStyle={{ color: '#faad14' }}
                prefix={<BellOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card
              hoverable
              onClick={() => setStatusFilter('resolved')}
              className={statusFilter === 'resolved' ? 'border-2 border-green-500' : ''}
            >
              <Statistic
                title="Resolved"
                value={stats.resolved}
                valueStyle={{ color: '#3f8600' }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card
              hoverable
              onClick={() => setStatusFilter('')}
              className={statusFilter === '' ? 'border-2 border-blue-500' : ''}
            >
              <Statistic
                title="Today"
                value={stats.today}
                prefix={<WarningOutlined />}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Card>
        <Table
          columns={columns}
          dataSource={alerts}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
          rowClassName={(record) =>
            record.status === 'active' && record.priority === 'critical'
              ? 'bg-red-50'
              : record.status === 'active'
              ? 'bg-orange-50'
              : ''
          }
        />
      </Card>
    </div>
  );
}

export default SecurityAlertsPage;

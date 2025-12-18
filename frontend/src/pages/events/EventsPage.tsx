import { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Tag,
  DatePicker,
  Select,
  Space,
  Button,
  Row,
  Col,
  Statistic,
} from 'antd';
import {
  ReloadOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CarOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import api from '../../services/api';

const { RangePicker } = DatePicker;

interface AccessEvent {
  id: string;
  eventType: 'entry' | 'exit';
  accessMethod: 'rfid' | 'qr' | 'manual' | 'remote';
  wasSuccessful: boolean;
  denialReason?: string;
  timestamp: string;
  gate?: { name: string; location: string };
  resident?: { firstName: string; lastName: string; unit: string };
  vehicle?: { plateNumber: string; make: string; model: string };
  humanAccess?: { firstName: string; lastName: string };
}

const accessMethodColors: Record<string, string> = {
  rfid: 'blue',
  qr: 'purple',
  manual: 'orange',
  remote: 'cyan',
};

export default function EventsPage() {
  const [events, setEvents] = useState<AccessEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    startDate: dayjs().subtract(7, 'day').toISOString(),
    endDate: dayjs().toISOString(),
    eventType: undefined as string | undefined,
    wasSuccessful: undefined as boolean | undefined,
  });
  const [stats, setStats] = useState({
    total: 0,
    successful: 0,
    denied: 0,
    entries: 0,
    exits: 0,
  });

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.eventType) params.append('eventType', filters.eventType);
      if (filters.wasSuccessful !== undefined)
        params.append('wasSuccessful', String(filters.wasSuccessful));

      const response = await api.get(`/events?${params.toString()}`);
      setEvents(response.data);

      // Calculate stats
      const data = response.data;
      setStats({
        total: data.length,
        successful: data.filter((e: AccessEvent) => e.wasSuccessful).length,
        denied: data.filter((e: AccessEvent) => !e.wasSuccessful).length,
        entries: data.filter((e: AccessEvent) => e.eventType === 'entry').length,
        exits: data.filter((e: AccessEvent) => e.eventType === 'exit').length,
      });
    } catch (error) {
      console.error('Failed to fetch events');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, []);

  const handleExport = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);

      const response = await api.get(`/events/export?${params.toString()}`, {
        responseType: 'blob',
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `access-events-${dayjs().format('YYYY-MM-DD')}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      console.error('Failed to export events');
    }
  };

  const columns: ColumnsType<AccessEvent> = [
    {
      title: 'Time',
      dataIndex: 'timestamp',
      key: 'timestamp',
      render: (timestamp: string) => dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss'),
      sorter: (a, b) => dayjs(a.timestamp).unix() - dayjs(b.timestamp).unix(),
      defaultSortOrder: 'descend',
    },
    {
      title: 'Gate',
      dataIndex: ['gate', 'name'],
      key: 'gate',
    },
    {
      title: 'Type',
      dataIndex: 'eventType',
      key: 'eventType',
      render: (type: string) => (
        <Tag color={type === 'entry' ? 'green' : 'red'}>{type.toUpperCase()}</Tag>
      ),
    },
    {
      title: 'Method',
      dataIndex: 'accessMethod',
      key: 'accessMethod',
      render: (method: string) => (
        <Tag color={accessMethodColors[method]}>{method.toUpperCase()}</Tag>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'wasSuccessful',
      key: 'wasSuccessful',
      render: (wasSuccessful: boolean, record) => (
        <Space>
          {wasSuccessful ? (
            <Tag icon={<CheckCircleOutlined />} color="success">
              Granted
            </Tag>
          ) : (
            <Tag icon={<CloseCircleOutlined />} color="error">
              Denied
            </Tag>
          )}
          {record.denialReason && (
            <span className="text-gray-500 text-xs">({record.denialReason})</span>
          )}
        </Space>
      ),
    },
    {
      title: 'Person/Vehicle',
      key: 'accessor',
      render: (_, record) => {
        if (record.vehicle) {
          return (
            <Space>
              <CarOutlined />
              <span>
                {record.vehicle.plateNumber} ({record.vehicle.make} {record.vehicle.model})
              </span>
            </Space>
          );
        }
        if (record.humanAccess) {
          return (
            <Space>
              <UserOutlined />
              <span>
                {record.humanAccess.firstName} {record.humanAccess.lastName}
              </span>
            </Space>
          );
        }
        if (record.resident) {
          return (
            <Space>
              <UserOutlined />
              <span>
                {record.resident.firstName} {record.resident.lastName} (Unit {record.resident.unit})
              </span>
            </Space>
          );
        }
        return <span className="text-gray-400">Unknown</span>;
      },
    },
  ];

  return (
    <div className="space-y-4">
      <Row gutter={16}>
        <Col span={4}>
          <Card>
            <Statistic title="Total Events" value={stats.total} />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic
              title="Successful"
              value={stats.successful}
              valueStyle={{ color: '#3f8600' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic
              title="Denied"
              value={stats.denied}
              valueStyle={{ color: '#cf1322' }}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic title="Entries" value={stats.entries} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic title="Exits" value={stats.exits} valueStyle={{ color: '#1890ff' }} />
          </Card>
        </Col>
      </Row>

      <Card
        title="Access Event Logs"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchEvents}>
              Refresh
            </Button>
            <Button icon={<DownloadOutlined />} onClick={handleExport}>
              Export CSV
            </Button>
          </Space>
        }
      >
        <div className="mb-4">
          <Space wrap>
            <RangePicker
              value={[dayjs(filters.startDate), dayjs(filters.endDate)]}
              onChange={(dates) => {
                if (dates) {
                  setFilters({
                    ...filters,
                    startDate: dates[0]?.toISOString() || '',
                    endDate: dates[1]?.toISOString() || '',
                  });
                }
              }}
            />
            <Select
              placeholder="Event Type"
              allowClear
              style={{ width: 120 }}
              value={filters.eventType}
              onChange={(value) => setFilters({ ...filters, eventType: value })}
            >
              <Select.Option value="entry">Entry</Select.Option>
              <Select.Option value="exit">Exit</Select.Option>
            </Select>
            <Select
              placeholder="Status"
              allowClear
              style={{ width: 120 }}
              value={filters.wasSuccessful}
              onChange={(value) => setFilters({ ...filters, wasSuccessful: value })}
            >
              <Select.Option value={true}>Granted</Select.Option>
              <Select.Option value={false}>Denied</Select.Option>
            </Select>
            <Button type="primary" onClick={fetchEvents}>
              Apply Filters
            </Button>
          </Space>
        </div>

        <Table
          columns={columns}
          dataSource={events}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      </Card>
    </div>
  );
}

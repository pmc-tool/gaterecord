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
  gateId: string;
  timestamp: string;
  method: 'rfid' | 'qr_code' | 'pin' | 'manual' | 'remote';
  subjectType: 'resident' | 'vehicle' | 'visitor' | 'unknown';
  subjectId?: string;
  subjectIdentifier?: string;
  subjectName?: string;
  result: 'allowed' | 'denied';
  denialReason?: string;
  operatorName?: string;
  gate?: { id: string; name: string };
}

const accessMethodColors: Record<string, string> = {
  rfid: 'blue',
  qr_code: 'purple',
  pin: 'green',
  manual: 'orange',
  remote: 'cyan',
};

export default function EventsPage() {
  const [events, setEvents] = useState<AccessEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    startDate: dayjs().subtract(7, 'day').toISOString(),
    endDate: dayjs().toISOString(),
    method: undefined as string | undefined,
    result: undefined as string | undefined,
  });
  const [stats, setStats] = useState({
    total: 0,
    allowed: 0,
    denied: 0,
  });
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0 });

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.method) params.append('method', filters.method);
      if (filters.result) params.append('result', filters.result);
      params.append('page', String(pagination.page));
      params.append('limit', String(pagination.limit));

      const response = await api.get(`/events?${params.toString()}`);
      const { events: eventList, total } = response.data;
      setEvents(eventList || []);
      setPagination(prev => ({ ...prev, total }));

      // Calculate stats from current page data
      const data = eventList || [];
      setStats({
        total: total,
        allowed: data.filter((e: AccessEvent) => e.result === 'allowed').length,
        denied: data.filter((e: AccessEvent) => e.result === 'denied').length,
      });
    } catch (error) {
      console.error('Failed to fetch events:', error);
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
      render: (name: string) => name || '-',
    },
    {
      title: 'Method',
      dataIndex: 'method',
      key: 'method',
      render: (method: string) => (
        <Tag color={accessMethodColors[method] || 'default'}>
          {method?.replace('_', ' ').toUpperCase() || '-'}
        </Tag>
      ),
    },
    {
      title: 'Subject',
      key: 'subject',
      render: (_, record) => {
        const icon = record.subjectType === 'vehicle' ? <CarOutlined /> : <UserOutlined />;
        return (
          <Space>
            {icon}
            <span>{record.subjectName || record.subjectIdentifier || '-'}</span>
          </Space>
        );
      },
    },
    {
      title: 'Type',
      dataIndex: 'subjectType',
      key: 'subjectType',
      render: (type: string) => (
        <Tag>{type?.toUpperCase() || '-'}</Tag>
      ),
    },
    {
      title: 'Result',
      dataIndex: 'result',
      key: 'result',
      render: (result: string, record) => (
        <Space>
          {result === 'allowed' ? (
            <Tag icon={<CheckCircleOutlined />} color="success">
              Allowed
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
  ];

  return (
    <div className="space-y-4">
      <Row gutter={16}>
        <Col span={8}>
          <Card>
            <Statistic title="Total Events" value={stats.total} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="Allowed"
              value={stats.allowed}
              valueStyle={{ color: '#3f8600' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="Denied"
              value={stats.denied}
              valueStyle={{ color: '#cf1322' }}
              prefix={<CloseCircleOutlined />}
            />
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
              placeholder="Method"
              allowClear
              style={{ width: 120 }}
              value={filters.method}
              onChange={(value) => setFilters({ ...filters, method: value })}
            >
              <Select.Option value="rfid">RFID</Select.Option>
              <Select.Option value="qr_code">QR Code</Select.Option>
              <Select.Option value="pin">PIN</Select.Option>
              <Select.Option value="manual">Manual</Select.Option>
              <Select.Option value="remote">Remote</Select.Option>
            </Select>
            <Select
              placeholder="Result"
              allowClear
              style={{ width: 120 }}
              value={filters.result}
              onChange={(value) => setFilters({ ...filters, result: value })}
            >
              <Select.Option value="allowed">Allowed</Select.Option>
              <Select.Option value="denied">Denied</Select.Option>
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
          pagination={{
            current: pagination.page,
            pageSize: pagination.limit,
            total: pagination.total,
            showSizeChanger: true,
            showTotal: (total) => `Total ${total} events`,
            onChange: (page, pageSize) => {
              setPagination({ ...pagination, page, limit: pageSize });
              fetchEvents();
            },
          }}
        />
      </Card>
    </div>
  );
}

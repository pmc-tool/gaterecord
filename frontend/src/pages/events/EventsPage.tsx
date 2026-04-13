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
import { useAuthStore } from '../../store/authStore';
import { UserRole } from '../../types';

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
  const { user } = useAuthStore();
  const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;

  const [events, setEvents] = useState<AccessEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [gates, setGates] = useState<{ id: string; name: string }[]>([]);
  const [filters, setFilters] = useState({
    tenantId: undefined as string | undefined,
    gateId: undefined as string | undefined,
    startDate: undefined as string | undefined,
    endDate: undefined as string | undefined,
    method: undefined as string | undefined,
    subjectType: undefined as string | undefined,
    result: undefined as string | undefined,
  });
  const [stats, setStats] = useState({
    total: 0,
    allowed: 0,
    denied: 0,
  });
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0 });

  const fetchTenants = async () => {
    if (!isSuperAdmin) return;
    try {
      const response = await api.get('/admin/tenants');
      setTenants(response.data.data || response.data);
    } catch (error) {
      console.error('Failed to fetch tenants');
    }
  };

  const fetchGates = async (tenantId?: string) => {
    try {
      const params = new URLSearchParams();
      if (tenantId) params.append('tenantId', tenantId);
      const response = await api.get(`/gates?${params.toString()}`);
      setGates(response.data.map((g: { id: string; name: string }) => ({ id: g.id, name: g.name })));
    } catch (error) {
      console.error('Failed to fetch gates');
    }
  };

  // Refetch gates when tenant changes
  useEffect(() => {
    fetchGates(filters.tenantId);
  }, [filters.tenantId]);

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.tenantId) params.append('tenantId', filters.tenantId);
      if (filters.gateId) params.append('gateId', filters.gateId);
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.method) params.append('method', filters.method);
      if (filters.subjectType) params.append('subjectType', filters.subjectType);
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
    fetchTenants();
  }, []);

  const handleExport = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.tenantId) params.append('tenantId', filters.tenantId);
      if (filters.gateId) params.append('gateId', filters.gateId);
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.method) params.append('method', filters.method);
      if (filters.subjectType) params.append('subjectType', filters.subjectType);
      if (filters.result) params.append('result', filters.result);

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
          <Row gutter={[16, 16]} align="middle">
            {isSuperAdmin && (
              <Col>
                <Select
                  placeholder="Select Tenant"
                  allowClear
                  style={{ width: 200 }}
                  value={filters.tenantId}
                  onChange={(value) => setFilters({ ...filters, tenantId: value, gateId: undefined })}
                  options={tenants.map(t => ({ value: t.id, label: t.name }))}
                />
              </Col>
            )}
            <Col>
              <Select
                placeholder="Gate"
                allowClear
                style={{ width: 150 }}
                value={filters.gateId}
                onChange={(value) => setFilters({ ...filters, gateId: value })}
                options={gates.map(g => ({ value: g.id, label: g.name }))}
                notFoundContent="No gates found"
              />
            </Col>
            <Col>
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
            </Col>
            <Col>
              <Select
                placeholder="Type"
                allowClear
                style={{ width: 120 }}
                value={filters.subjectType}
                onChange={(value) => setFilters({ ...filters, subjectType: value })}
              >
                <Select.Option value="resident">Resident</Select.Option>
                <Select.Option value="vehicle">Vehicle</Select.Option>
                <Select.Option value="visitor">Visitor</Select.Option>
                <Select.Option value="unknown">Unknown</Select.Option>
              </Select>
            </Col>
            <Col>
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
            </Col>
            <Col>
              <DatePicker
                placeholder="Start Date"
                style={{ width: 150 }}
                value={filters.startDate ? dayjs(filters.startDate) : undefined}
                onChange={(date) => setFilters({ ...filters, startDate: date?.format('YYYY-MM-DD') })}
              />
            </Col>
            <Col>
              <DatePicker
                placeholder="End Date"
                style={{ width: 150 }}
                value={filters.endDate ? dayjs(filters.endDate) : undefined}
                onChange={(date) => setFilters({ ...filters, endDate: date?.format('YYYY-MM-DD') })}
              />
            </Col>
            <Col>
              <Space>
                <Button type="primary" onClick={fetchEvents}>
                  Apply
                </Button>
                <Button onClick={() => {
                  setFilters({
                    tenantId: undefined,
                    gateId: undefined,
                    startDate: undefined,
                    endDate: undefined,
                    method: undefined,
                    subjectType: undefined,
                    result: undefined,
                  });
                }}>
                  Reset
                </Button>
              </Space>
            </Col>
          </Row>
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
            pageSizeOptions: ['10', '20', '50', '100'],
            showQuickJumper: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} events`,
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

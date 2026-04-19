import { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  message,
  Popconfirm,
  Badge,
  Tooltip,
  Typography,
  Row,
  Col,
} from 'antd';
import { useAuthStore } from '../../store/authStore';
import { UserRole } from '../../types';

const { Text } = Typography;
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import api from '../../services/api';
import Title from 'antd/es/typography/Title';

interface GateDevice {
  id: string;
  deviceId: string;
  deviceName: string;
  status: string;
}

interface Gate {
  id: string;
  name: string;
  location: string;
  type: 'entry' | 'exit' | 'bidirectional';
  state: string;
  isOnline: boolean;
  hardwareId?: string;
  devices?: GateDevice[];
  tenantId: string;
  tenant?: { name: string };
  createdAt: string;
}

interface Device {
  id: string;
  deviceId: string;
  deviceName: string;
  gateId?: string;
  gateName?: string;
  status: string;
  tenantId: string;
}

const gateStatusColors: Record<string, string> = {
  CLOSED: 'default',
  OPENING: 'processing',
  OPEN: 'success',
  CLOSING: 'processing',
  OBSTACLE_HOLD: 'warning',
  FAULT: 'error',
  MANUAL_OVERRIDE: 'purple',
};

export default function GatesPage() {
  const [gates, setGates] = useState<Gate[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingGate, setEditingGate] = useState<Gate | null>(null);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [form] = Form.useForm();
  const { user } = useAuthStore();
  const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;
  const [filters, setFilters] = useState({
    tenantId: undefined as string | undefined,
    type: undefined as string | undefined,
    state: undefined as string | undefined,
  });

  const fetchGates = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.tenantId) params.append('tenantId', filters.tenantId);
      if (filters.type) params.append('type', filters.type);
      if (filters.state) params.append('state', filters.state);

      const response = await api.get(`/gates?${params.toString()}`);
      setGates(response.data);
    } catch (error) {
      message.error('Failed to fetch gates');
    } finally {
      setLoading(false);
    }
  };

  const fetchTenants = async () => {
    try {
      if (isSuperAdmin) {
        const response = await api.get('/admin/tenants');
        setTenants(response.data.data || response.data);
      } else if (user?.tenant) {
        // For building admin, use tenant from user profile
        setTenants([{ id: user.tenant.id, name: user.tenant.name }]);
      }
    } catch (error) {
      console.error('Failed to fetch tenants');
    }
  };

  const fetchDevices = async () => {
    try {
      const response = await api.get('/devices');
      setDevices(response.data.data || response.data);
    } catch (error) {
      console.error('Failed to fetch devices');
    }
  };

  useEffect(() => {
    fetchGates();
    fetchTenants();
    fetchDevices();
  }, []);

  const handleCreate = () => {
    setEditingGate(null);
    form.resetFields();
    fetchDevices(); // Refresh devices list
    setModalVisible(true);
  };

  const handleEdit = async (gate: Gate) => {
    setEditingGate(gate);
    // Refresh devices and get latest list
    try {
      const response = await api.get('/devices');
      const latestDevices = (response.data.data || response.data) as Device[];
      setDevices(latestDevices);
      // Find the first device linked to this gate (for the dropdown)
      const linkedDevice = latestDevices.find((d: Device) => d.gateId === gate.id);
      form.setFieldsValue({
        ...gate,
        deviceId: linkedDevice?.deviceId,
      });
    } catch {
      // Use the first device from gate's devices array if available
      const firstDevice = gate.devices?.[0];
      form.setFieldsValue({
        ...gate,
        deviceId: firstDevice?.deviceId,
      });
    }
    setModalVisible(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/gates/${id}`);
      message.success('Gate deleted successfully');
      fetchGates();
    } catch (error) {
      message.error('Failed to delete gate');
    }
  };

  const handleSubmit = async (values: Partial<Gate> & { deviceId?: string }) => {
    try {
      const { deviceId, ...gateValues } = values;

      // For Building Admin, auto-set tenantId from user
      if (!isSuperAdmin && user?.tenantId) {
        gateValues.tenantId = user.tenantId;
      }

      if (editingGate) {
        // Don't send tenantId on update - it's not allowed
        const { tenantId, ...updateValues } = gateValues;
        await api.patch(`/gates/${editingGate.id}`, updateValues);

        // Handle device linking - only link new device if selected
        if (deviceId) {
          // Find the device and link it to this gate
          const device = devices.find(d => d.deviceId === deviceId);
          if (device) {
            await api.patch(`/devices/${device.id}`, { gateId: editingGate.id });
          }
        }

        message.success('Gate updated successfully');
      } else {
        const newGate = await api.post('/gates', gateValues);

        // Link device to newly created gate
        if (deviceId) {
          const device = devices.find(d => d.deviceId === deviceId);
          if (device) {
            await api.patch(`/devices/${device.id}`, { gateId: newGate.data.id });
          }
        }

        message.success('Gate created successfully');
      }
      setModalVisible(false);
      fetchDevices(); // Refresh devices to get updated linkage
      fetchGates();
    } catch (error: unknown) {
      // API interceptor converts errors to plain Error with message
      const err = error as Error & { response?: { data?: { message?: string | string[] } } };
      const errorMsg = err.response?.data?.message || err.message || 'Failed to save gate';
      message.error(Array.isArray(errorMsg) ? errorMsg.join(', ') : String(errorMsg));
    }
  };

  const columns: ColumnsType<Gate> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
    },
    {
      title: 'Location',
      dataIndex: 'location',
      key: 'location',
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => (
        <Tag color={type === 'vehicle' ? 'green' : type === 'pedestrian' ? 'blue' : 'purple'}>
          {type?.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'state',
      key: 'state',
      render: (state: string) => (
        <Tag color={gateStatusColors[state] || 'default'}>{state || '—'}</Tag>
      ),
    },
    {
      title: 'Online',
      dataIndex: 'isOnline',
      key: 'isOnline',
      render: (_: boolean, record: Gate) => {
        const devs = record.devices || [];
        if (devs.length === 0) {
          return <span style={{ color: '#999' }}>—</span>;
        }
        const onlineCount = devs.filter((d) => d.status === 'online').length;
        const totalCount = devs.length;
        
        if (totalCount === 1) {
          // Single device - simple badge
          return (
            <Badge 
              status={onlineCount > 0 ? 'success' : 'error'} 
              text={onlineCount > 0 ? 'Online' : 'Offline'} 
            />
          );
        }
        
        // Multiple devices - show count
        const allOnline = onlineCount === totalCount;
        const allOffline = onlineCount === 0;
        return (
          <Tooltip title={`${onlineCount} of ${totalCount} devices online`}>
            <Tag color={allOnline ? 'green' : allOffline ? 'red' : 'orange'}>
              {onlineCount}/{totalCount} Online
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Device',
      dataIndex: 'devices',
      key: 'device',
      render: (_: unknown, record: Gate) => {
        const devs = record.devices || [];
        if (devs.length === 0) {
          return <Tag color="default">Not linked</Tag>;
        }
        return (
          <Space size={[0, 4]} wrap>
            {devs.map((d) => (
              <Tooltip key={d.id} title={`ID: ${d.deviceId} | Status: ${d.status}`}>
                <Tag color={d.status === 'online' ? 'green' : 'default'}>
                  {d.deviceName}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        );
      },
    },
    {
      title: 'Building',
      dataIndex: ['tenant', 'name'],
      key: 'tenant',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      className: 'actions-nowrap',
      render: (_, record) => (
        <Space wrap={false} size="small">
          <Tooltip title="Edit">
            <Button icon={<EditOutlined />} size="small" onClick={() => handleEdit(record)} />
          </Tooltip>
          <Tooltip title="Open Simulator">
            <Button
              icon={<ApiOutlined />}
              size="small"
              onClick={() => (window.location.href = `/simulator?gate=${record.id}`)}
            />
          </Tooltip>
          <Popconfirm
            title="Delete this gate?"
            onConfirm={() => handleDelete(record.id)}
            okText="Yes"
            cancelText="No"
          >
            <Tooltip title="Delete">
              <Button icon={<DeleteOutlined />} size="small" danger />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
       {/* Headline */}
      <div className="flex justify-between items-center">
        <Title level={3}>Gates Management</Title>
      </div>
    
      <Card
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchGates}>
              Refresh
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              Add Gate
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
                  onChange={(value) => setFilters({ ...filters, tenantId: value })}
                  options={tenants.map(t => ({ value: t.id, label: t.name }))}
                />
              </Col>
            )}
            <Col>
              <Select
                placeholder="Type"
                allowClear
                style={{ width: 150 }}
                value={filters.type}
                onChange={(value) => setFilters({ ...filters, type: value })}
              >
                <Select.Option value="vehicle">Vehicle</Select.Option>
                <Select.Option value="pedestrian">Pedestrian</Select.Option>
                <Select.Option value="mixed">Mixed</Select.Option>
              </Select>
            </Col>
            <Col>
              <Select
                placeholder="Status"
                allowClear
                style={{ width: 150 }}
                value={filters.state}
                onChange={(value) => setFilters({ ...filters, state: value })}
              >
                <Select.Option value="CLOSED">Closed</Select.Option>
                <Select.Option value="OPENING">Opening</Select.Option>
                <Select.Option value="OPEN">Open</Select.Option>
                <Select.Option value="CLOSING">Closing</Select.Option>
                <Select.Option value="OBSTACLE_HOLD">Obstacle Hold</Select.Option>
                <Select.Option value="FAULT">Fault</Select.Option>
                <Select.Option value="MANUAL_OVERRIDE">Manual Override</Select.Option>
              </Select>
            </Col>
            <Col>
              <Space>
                <Button type="primary" onClick={fetchGates}>
                  Apply
                </Button>
                <Button onClick={() => {
                  setFilters({
                    tenantId: undefined,
                    type: undefined,
                    state: undefined,
                  });
                  fetchGates();
                }}>
                  Reset
                </Button>
              </Space>
            </Col>
          </Row>
        </div>

        <Table
          columns={columns}
          dataSource={gates}
          rowKey="id"
          loading={loading}
          scroll={{ x: 700 }}
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} gates`,
          }}
        />
      </Card>

      <Modal
        title={editingGate ? 'Edit Gate' : 'Add Gate'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            name="name"
            label="Gate Name"
            rules={[{ required: true, message: 'Please enter gate name' }]}
          >
            <Input placeholder="e.g., Main Entrance Gate" />
          </Form.Item>

          <Form.Item
            name="location"
            label="Location"
            rules={[{ required: true, message: 'Please enter location' }]}
          >
            <Input placeholder="e.g., Building A - Front" />
          </Form.Item>

          <Form.Item
            name="type"
            label="Gate Type"
            rules={[{ required: true, message: 'Please select gate type' }]}
          >
            <Select placeholder="Select type">
              <Select.Option value="vehicle">Vehicle</Select.Option>
              <Select.Option value="pedestrian">Pedestrian</Select.Option>
              <Select.Option value="mixed">Mixed</Select.Option>
            </Select>
          </Form.Item>

          {isSuperAdmin ? (
            <Form.Item
              name="tenantId"
              label="Building"
              rules={[{ required: true, message: 'Please select building' }]}
            >
              <Select placeholder="Select building">
                {tenants.map((tenant) => (
                  <Select.Option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          ) : (
            <Form.Item label="Building">
              <Text strong>{user?.tenant?.name || tenants.find(t => t.id === user?.tenantId)?.name || '—'}</Text>
            </Form.Item>
          )}

          <Form.Item
            name="deviceId"
            label="Link Device"
            tooltip="Select a registered device to link to this gate"
          >
            <Select
              placeholder="Select a device to link"
              allowClear
              showSearch
              optionFilterProp="children"
            >
              {devices
                .filter(device => {
                  // Show devices that are either unlinked or linked to the current gate
                  return !device.gateId || device.gateId === editingGate?.id;
                })
                .map((device) => (
                  <Select.Option key={device.deviceId} value={device.deviceId}>
                    {device.deviceName} ({device.deviceId})
                    {device.gateId && device.gateId === editingGate?.id && ' - Currently linked'}
                  </Select.Option>
                ))}
            </Select>
          </Form.Item>

          <Form.Item className="mb-0 text-right">
            <Space>
              <Button onClick={() => setModalVisible(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit">
                {editingGate ? 'Update' : 'Create'}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

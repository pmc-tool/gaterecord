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
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import api from '../../services/api';

interface Gate {
  id: string;
  name: string;
  location: string;
  type: 'entry' | 'exit' | 'bidirectional';
  status: string;
  isOnline: boolean;
  hardwareId?: string;
  deviceName?: string;
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

  const fetchGates = async () => {
    setLoading(true);
    try {
      const response = await api.get('/gates');
      setGates(response.data);
    } catch (error) {
      message.error('Failed to fetch gates');
    } finally {
      setLoading(false);
    }
  };

  const fetchTenants = async () => {
    try {
      const response = await api.get('/admin/tenants');
      setTenants(response.data);
    } catch (error) {
      console.error('Failed to fetch tenants');
    }
  };

  const fetchDevices = async () => {
    try {
      const response = await api.get('/devices');
      setDevices(response.data);
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
      const latestDevices = response.data as Device[];
      setDevices(latestDevices);
      // Find the device linked to this gate
      const linkedDevice = latestDevices.find((d: Device) => d.gateId === gate.id);
      form.setFieldsValue({
        ...gate,
        deviceId: linkedDevice?.deviceId || gate.hardwareId,
      });
    } catch {
      form.setFieldsValue({
        ...gate,
        deviceId: gate.hardwareId,
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

      if (editingGate) {
        // Don't send tenantId on update - it's not allowed
        const { tenantId, ...updateValues } = gateValues;
        await api.patch(`/gates/${editingGate.id}`, updateValues);

        // Handle device linking/unlinking
        if (deviceId) {
          // Find the device and link it to this gate
          const device = devices.find(d => d.deviceId === deviceId);
          if (device) {
            await api.patch(`/devices/${device.id}`, { gateId: editingGate.id });
          }
        } else if (editingGate.hardwareId) {
          // Unlink the current device
          const linkedDevice = devices.find(d => d.deviceId === editingGate.hardwareId);
          if (linkedDevice) {
            await api.patch(`/devices/${linkedDevice.id}`, { gateId: null });
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
      const err = error as { response?: { data?: { message?: string } } };
      const errorMsg = err.response?.data?.message || 'Failed to save gate';
      message.error(Array.isArray(errorMsg) ? errorMsg.join(', ') : errorMsg);
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
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={gateStatusColors[status] || 'default'}>{status}</Tag>
      ),
    },
    {
      title: 'Online',
      dataIndex: 'isOnline',
      key: 'isOnline',
      render: (isOnline: boolean) => (
        <Badge status={isOnline ? 'success' : 'error'} text={isOnline ? 'Online' : 'Offline'} />
      ),
    },
    {
      title: 'Device',
      dataIndex: 'deviceName',
      key: 'device',
      render: (_: unknown, record: Gate) =>
        record.deviceName ? (
          <Tooltip title={`Hardware ID: ${record.hardwareId}`}>
            <Tag color="geekblue">{record.deviceName}</Tag>
          </Tooltip>
        ) : record.hardwareId ? (
          <Tooltip title="Device registered but name not set">
            <Tag color="orange">{record.hardwareId}</Tag>
          </Tooltip>
        ) : (
          <Tag color="default">Not linked</Tag>
        ),
    },
    {
      title: 'Building',
      dataIndex: ['tenant', 'name'],
      key: 'tenant',
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
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
      <Card
        title="Gates Management"
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
        <Table
          columns={columns}
          dataSource={gates}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
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

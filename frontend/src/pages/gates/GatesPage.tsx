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
  tenantId: string;
  tenant?: { name: string };
  createdAt: string;
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

  useEffect(() => {
    fetchGates();
    fetchTenants();
  }, []);

  const handleCreate = () => {
    setEditingGate(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (gate: Gate) => {
    setEditingGate(gate);
    form.setFieldsValue(gate);
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

  const handleSubmit = async (values: Partial<Gate>) => {
    try {
      if (editingGate) {
        // Don't send tenantId on update - it's not allowed
        const { tenantId, ...updateValues } = values;
        await api.patch(`/gates/${editingGate.id}`, updateValues);
        message.success('Gate updated successfully');
      } else {
        await api.post('/gates', values);
        message.success('Gate created successfully');
      }
      setModalVisible(false);
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
      title: 'Hardware ID',
      dataIndex: 'hardwareId',
      key: 'hardwareId',
      render: (hardwareId: string) =>
        hardwareId ? (
          <Tooltip title="ESP32 Device ID (MAC Address)">
            <Tag color="geekblue">{hardwareId}</Tag>
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
            name="hardwareId"
            label="Hardware ID (ESP32)"
            tooltip="Enter the ESP32 device MAC address (shown on device OLED at startup)"
          >
            <Input
              placeholder="e.g., AABBCCDDEEFF"
              maxLength={12}
              style={{ fontFamily: 'monospace' }}
            />
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

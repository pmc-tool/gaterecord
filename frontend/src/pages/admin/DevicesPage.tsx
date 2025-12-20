import { useState, useEffect, useCallback } from 'react';
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
  Tooltip,
  Descriptions,
  Progress,
  Badge,
  Typography,
  Divider,
  Alert,
  Statistic,
  Row,
  Col,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  WifiOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  DesktopOutlined,
  QrcodeOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import api from '../../services/api';

dayjs.extend(relativeTime);

const { Text, Paragraph } = Typography;

interface Device {
  id: string;
  deviceName: string;
  deviceId: string;
  tenantId: string;
  gateId?: string;
  gateName?: string;
  wifiSsid?: string;
  firmwareVersion?: string;
  status: 'setup' | 'online' | 'offline' | 'updating';
  lastSeenAt?: string;
  ipAddress?: string;
  wifiSignalStrength?: number;
  uptime?: number;
  pairedAt?: string;
  createdAt: string;
}

interface SetupCode {
  id: string;
  code: string;
  deviceName: string;
  gateId?: string;
  expiresAt: string;
  status: 'pending' | 'claimed' | 'expired';
  createdAt: string;
}

interface Gate {
  id: string;
  name: string;
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [setupCodes, setSetupCodes] = useState<SetupCode[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [loading, setLoading] = useState(false);
  const [setupCodeModalVisible, setSetupCodeModalVisible] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/devices');
      setDevices(response.data);
    } catch (error) {
      message.error('Failed to fetch devices');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSetupCodes = useCallback(async () => {
    try {
      const response = await api.get('/devices/setup-codes');
      setSetupCodes(response.data);
    } catch (error) {
      console.error('Failed to fetch setup codes', error);
    }
  }, []);

  const fetchGates = useCallback(async () => {
    try {
      const response = await api.get('/gates');
      setGates(response.data);
    } catch (error) {
      console.error('Failed to fetch gates', error);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
    fetchSetupCodes();
    fetchGates();
  }, [fetchDevices, fetchSetupCodes, fetchGates]);

  const handleGenerateCode = async (values: { deviceName: string; gateId?: string }) => {
    try {
      const response = await api.post('/devices/setup-codes', values);
      setGeneratedCode(response.data.code);
      message.success('Setup code generated!');
      fetchSetupCodes();
    } catch (error) {
      message.error('Failed to generate setup code');
    }
  };

  const handleDeleteSetupCode = async (id: string) => {
    try {
      await api.delete(`/devices/setup-codes/${id}`);
      message.success('Setup code cancelled');
      fetchSetupCodes();
    } catch (error) {
      message.error('Failed to delete setup code');
    }
  };

  const handleEditDevice = (device: Device) => {
    setSelectedDevice(device);
    editForm.setFieldsValue({
      deviceName: device.deviceName,
      gateId: device.gateId,
    });
    setEditModalVisible(true);
  };

  const handleUpdateDevice = async (values: { deviceName?: string; gateId?: string }) => {
    if (!selectedDevice) return;
    try {
      await api.patch(`/devices/${selectedDevice.id}`, values);
      message.success('Device updated');
      setEditModalVisible(false);
      fetchDevices();
    } catch (error) {
      message.error('Failed to update device');
    }
  };

  const handleDeleteDevice = async (id: string) => {
    try {
      await api.delete(`/devices/${id}`);
      message.success('Device removed');
      fetchDevices();
    } catch (error) {
      message.error('Failed to remove device');
    }
  };

  const handleTriggerOta = async (device: Device) => {
    try {
      const response = await api.post(`/devices/${device.id}/firmware/update`);
      if (response.data.success) {
        message.success(response.data.message);
        fetchDevices();
      } else {
        message.warning(response.data.message);
      }
    } catch (error) {
      message.error('Failed to trigger OTA update');
    }
  };

  const handleTestDevice = async (device: Device) => {
    try {
      const response = await api.post(`/devices/${device.id}/test`);
      message.success(response.data.message);
    } catch (error) {
      message.error('Failed to send test command');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    message.success('Copied to clipboard!');
  };

  const getStatusTag = (status: string) => {
    const configs: Record<string, { color: string; icon: React.ReactNode }> = {
      online: { color: 'success', icon: <CheckCircleOutlined /> },
      offline: { color: 'error', icon: <CloseCircleOutlined /> },
      setup: { color: 'processing', icon: <SyncOutlined spin /> },
      updating: { color: 'warning', icon: <CloudUploadOutlined /> },
    };
    const config = configs[status] || { color: 'default', icon: null };
    return (
      <Tag color={config.color} icon={config.icon}>
        {status.toUpperCase()}
      </Tag>
    );
  };

  const getSignalStrengthTag = (rssi?: number) => {
    if (rssi === undefined) return <span className="text-gray-400">-</span>;
    let color = 'error';
    let label = 'Weak';
    if (rssi > -50) {
      color = 'success';
      label = 'Excellent';
    } else if (rssi > -60) {
      color = 'processing';
      label = 'Good';
    } else if (rssi > -70) {
      color = 'warning';
      label = 'Fair';
    }
    return (
      <Tag color={color}>
        <WifiOutlined /> {rssi} dBm ({label})
      </Tag>
    );
  };

  const formatUptime = (seconds?: number) => {
    if (!seconds) return '-';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const columns: ColumnsType<Device> = [
    {
      title: 'Device',
      key: 'device',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Space>
            <DesktopOutlined />
            <Text strong>{record.deviceName}</Text>
          </Space>
          <Text type="secondary" className="text-xs">
            {record.deviceId}
          </Text>
        </Space>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => getStatusTag(status),
      filters: [
        { text: 'Online', value: 'online' },
        { text: 'Offline', value: 'offline' },
        { text: 'Setup', value: 'setup' },
        { text: 'Updating', value: 'updating' },
      ],
      onFilter: (value, record) => record.status === value,
    },
    {
      title: 'Gate',
      dataIndex: 'gateName',
      key: 'gateName',
      render: (name: string) => name || <span className="text-gray-400">Unassigned</span>,
    },
    {
      title: 'Firmware',
      dataIndex: 'firmwareVersion',
      key: 'firmwareVersion',
      render: (version: string) =>
        version ? <Tag>{version}</Tag> : <span className="text-gray-400">Unknown</span>,
    },
    {
      title: 'Signal',
      dataIndex: 'wifiSignalStrength',
      key: 'wifiSignalStrength',
      render: (rssi: number) => getSignalStrengthTag(rssi),
    },
    {
      title: 'Last Seen',
      dataIndex: 'lastSeenAt',
      key: 'lastSeenAt',
      render: (date: string) =>
        date ? (
          <Tooltip title={dayjs(date).format('YYYY-MM-DD HH:mm:ss')}>
            {dayjs(date).fromNow()}
          </Tooltip>
        ) : (
          <span className="text-gray-400">Never</span>
        ),
      sorter: (a, b) => {
        if (!a.lastSeenAt) return 1;
        if (!b.lastSeenAt) return -1;
        return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Tooltip title="View Details">
            <Button
              icon={<DesktopOutlined />}
              size="small"
              onClick={() => {
                setSelectedDevice(record);
                setDetailModalVisible(true);
              }}
            />
          </Tooltip>
          <Tooltip title="Test Device">
            <Button
              icon={<ThunderboltOutlined />}
              size="small"
              onClick={() => handleTestDevice(record)}
              disabled={record.status !== 'online'}
            />
          </Tooltip>
          <Tooltip title="Edit">
            <Button icon={<EditOutlined />} size="small" onClick={() => handleEditDevice(record)} />
          </Tooltip>
          <Tooltip title="Update Firmware">
            <Button
              icon={<CloudUploadOutlined />}
              size="small"
              onClick={() => handleTriggerOta(record)}
              disabled={record.status !== 'online'}
            />
          </Tooltip>
          <Popconfirm
            title="Remove this device?"
            description="The device will need to be re-paired."
            onConfirm={() => handleDeleteDevice(record.id)}
          >
            <Tooltip title="Remove">
              <Button icon={<DeleteOutlined />} size="small" danger />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const setupCodeColumns: ColumnsType<SetupCode> = [
    {
      title: 'Code',
      dataIndex: 'code',
      key: 'code',
      render: (code: string) => (
        <Space>
          <Text code className="text-lg font-mono">
            {code}
          </Text>
          <Button
            icon={<CopyOutlined />}
            size="small"
            type="text"
            onClick={() => copyToClipboard(code)}
          />
        </Space>
      ),
    },
    {
      title: 'Device Name',
      dataIndex: 'deviceName',
      key: 'deviceName',
    },
    {
      title: 'Expires',
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      render: (date: string) => {
        const remaining = dayjs(date).diff(dayjs(), 'minute');
        return (
          <Space>
            <Progress
              type="circle"
              percent={Math.max(0, Math.round((remaining / 15) * 100))}
              size={30}
              format={() => `${remaining}m`}
              status={remaining < 3 ? 'exception' : 'normal'}
            />
          </Space>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Popconfirm title="Cancel this setup code?" onConfirm={() => handleDeleteSetupCode(record.id)}>
          <Button size="small" danger>
            Cancel
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const onlineCount = devices.filter((d) => d.status === 'online').length;
  const offlineCount = devices.filter((d) => d.status === 'offline').length;

  return (
    <div className="space-y-4">
      {/* Stats Row */}
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic
              title="Total Devices"
              value={devices.length}
              prefix={<DesktopOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="Online"
              value={onlineCount}
              valueStyle={{ color: '#52c41a' }}
              prefix={<Badge status="success" />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="Offline"
              value={offlineCount}
              valueStyle={{ color: offlineCount > 0 ? '#ff4d4f' : undefined }}
              prefix={<Badge status="error" />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="Active Setup Codes"
              value={setupCodes.length}
              prefix={<QrcodeOutlined />}
            />
          </Card>
        </Col>
      </Row>

      {/* Active Setup Codes */}
      {setupCodes.length > 0 && (
        <Card
          title="Active Setup Codes"
          size="small"
          extra={
            <Button size="small" onClick={fetchSetupCodes}>
              Refresh
            </Button>
          }
        >
          <Table
            columns={setupCodeColumns}
            dataSource={setupCodes}
            rowKey="id"
            size="small"
            pagination={false}
          />
        </Card>
      )}

      {/* Devices List */}
      <Card
        title="Devices"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchDevices}>
              Refresh
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setGeneratedCode(null);
                form.resetFields();
                setSetupCodeModalVisible(true);
              }}
            >
              Add Device
            </Button>
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={devices}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      {/* Generate Setup Code Modal */}
      <Modal
        title="Add New Device"
        open={setupCodeModalVisible}
        onCancel={() => setSetupCodeModalVisible(false)}
        footer={null}
        width={500}
      >
        {generatedCode ? (
          <div className="text-center py-4">
            <CheckCircleOutlined style={{ fontSize: 48, color: '#52c41a' }} />
            <div className="mt-4 mb-2">
              <Text>Enter this code on your device:</Text>
            </div>
            <Paragraph
              copyable={{ text: generatedCode }}
              className="text-3xl font-mono bg-gray-100 p-4 rounded"
            >
              {generatedCode}
            </Paragraph>
            <Alert
              message="Code expires in 15 minutes"
              type="info"
              showIcon
              className="mt-4"
            />
            <Divider />
            <Space>
              <Button onClick={() => setSetupCodeModalVisible(false)}>Close</Button>
              <Button
                type="primary"
                onClick={() => {
                  setGeneratedCode(null);
                  form.resetFields();
                }}
              >
                Generate Another
              </Button>
            </Space>
          </div>
        ) : (
          <Form form={form} layout="vertical" onFinish={handleGenerateCode}>
            <Alert
              message="Device Setup Instructions"
              description={
                <ol className="list-decimal list-inside text-sm">
                  <li>Power on your ESP32 gate controller</li>
                  <li>Connect to the "Gate-Setup-XXXX" WiFi network</li>
                  <li>Open the captive portal and enter the setup code</li>
                  <li>Configure your WiFi credentials</li>
                  <li>The device will automatically connect and appear here</li>
                </ol>
              }
              type="info"
              showIcon
              className="mb-4"
            />
            <Form.Item
              name="deviceName"
              label="Device Name"
              rules={[{ required: true, message: 'Please enter a device name' }]}
            >
              <Input placeholder="e.g., Main Gate Controller" />
            </Form.Item>
            <Form.Item name="gateId" label="Assign to Gate (Optional)">
              <Select placeholder="Select a gate" allowClear>
                {gates.map((gate) => (
                  <Select.Option key={gate.id} value={gate.id}>
                    {gate.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
            <Form.Item className="mb-0 text-right">
              <Space>
                <Button onClick={() => setSetupCodeModalVisible(false)}>Cancel</Button>
                <Button type="primary" htmlType="submit" icon={<QrcodeOutlined />}>
                  Generate Setup Code
                </Button>
              </Space>
            </Form.Item>
          </Form>
        )}
      </Modal>

      {/* Edit Device Modal */}
      <Modal
        title="Edit Device"
        open={editModalVisible}
        onCancel={() => setEditModalVisible(false)}
        footer={null}
      >
        <Form form={editForm} layout="vertical" onFinish={handleUpdateDevice}>
          <Form.Item name="deviceName" label="Device Name">
            <Input />
          </Form.Item>
          <Form.Item name="gateId" label="Assign to Gate">
            <Select placeholder="Select a gate" allowClear>
              {gates.map((gate) => (
                <Select.Option key={gate.id} value={gate.id}>
                  {gate.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item className="mb-0 text-right">
            <Space>
              <Button onClick={() => setEditModalVisible(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit">
                Update
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* Device Details Modal */}
      <Modal
        title="Device Details"
        open={detailModalVisible}
        onCancel={() => setDetailModalVisible(false)}
        footer={[
          <Button key="close" onClick={() => setDetailModalVisible(false)}>
            Close
          </Button>,
        ]}
        width={600}
      >
        {selectedDevice && (
          <Descriptions column={2} bordered size="small">
            <Descriptions.Item label="Device Name" span={2}>
              {selectedDevice.deviceName}
            </Descriptions.Item>
            <Descriptions.Item label="Device ID" span={2}>
              <Text code copyable>
                {selectedDevice.deviceId}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              {getStatusTag(selectedDevice.status)}
            </Descriptions.Item>
            <Descriptions.Item label="Firmware">
              {selectedDevice.firmwareVersion || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Gate">
              {selectedDevice.gateName || 'Unassigned'}
            </Descriptions.Item>
            <Descriptions.Item label="WiFi SSID">
              {selectedDevice.wifiSsid || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="IP Address">
              {selectedDevice.ipAddress || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Signal Strength">
              {getSignalStrengthTag(selectedDevice.wifiSignalStrength)}
            </Descriptions.Item>
            <Descriptions.Item label="Uptime">
              {formatUptime(selectedDevice.uptime)}
            </Descriptions.Item>
            <Descriptions.Item label="Last Seen">
              {selectedDevice.lastSeenAt
                ? dayjs(selectedDevice.lastSeenAt).format('YYYY-MM-DD HH:mm:ss')
                : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Paired At" span={2}>
              {selectedDevice.pairedAt
                ? dayjs(selectedDevice.pairedAt).format('YYYY-MM-DD HH:mm:ss')
                : '-'}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  );
}

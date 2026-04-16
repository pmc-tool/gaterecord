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
  Upload,
  message,
  Popconfirm,
  Tooltip,
  Typography,
  Switch,
  Descriptions,
  Progress,
} from 'antd';
import {
  UploadOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  StarOutlined,
  StarFilled,
  InfoCircleOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd/es/upload';
import dayjs from 'dayjs';
import api from '../../services/api';

const { Text } = Typography;
const { TextArea } = Input;

interface FirmwareVersion {
  id: string;
  version: string;
  firmwareUrl: string;
  firmwareSize?: number;
  checksum: string;
  releaseNotes?: string;
  isStable: boolean;
  isLatest: boolean;
  minRequiredVersion?: string;
  releasedAt?: string;
  createdAt: string;
  deviceCount?: number;
}

export default function FirmwareManagementPage() {
  const [firmwareList, setFirmwareList] = useState<FirmwareVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadModalVisible, setUploadModalVisible] = useState(false);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [selectedFirmware, setSelectedFirmware] = useState<FirmwareVersion | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [form] = Form.useForm();

  const fetchFirmware = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/admin/firmware');
      setFirmwareList(response.data);
    } catch (error) {
      message.error('Failed to fetch firmware versions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFirmware();
  }, [fetchFirmware]);

  const handleUpload = async (values: {
    version: string;
    releaseNotes?: string;
    minRequiredVersion?: string;
    isStable?: boolean;
  }) => {
    if (fileList.length === 0) {
      message.error('Please select a firmware file');
      return;
    }

    const formData = new FormData();
    formData.append('firmware', fileList[0].originFileObj as File);
    formData.append('version', values.version);
    if (values.releaseNotes) formData.append('releaseNotes', values.releaseNotes);
    if (values.minRequiredVersion) formData.append('minRequiredVersion', values.minRequiredVersion);
    formData.append('isStable', String(values.isStable || false));

    setUploading(true);
    try {
      await api.post('/admin/firmware', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      message.success('Firmware uploaded successfully!');
      setUploadModalVisible(false);
      setFileList([]);
      form.resetFields();
      fetchFirmware();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Failed to upload firmware');
    } finally {
      setUploading(false);
    }
  };

  const handleRelease = async (firmware: FirmwareVersion, options: { isLatest?: boolean; isStable?: boolean }) => {
    try {
      await api.post(`/admin/firmware/${firmware.id}/release`, options);
      message.success('Firmware updated');
      fetchFirmware();
    } catch (error) {
      message.error('Failed to update firmware');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/admin/firmware/${id}`);
      message.success('Firmware deleted');
      fetchFirmware();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Failed to delete firmware');
    }
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const columns: ColumnsType<FirmwareVersion> = [
    {
      title: 'Version',
      dataIndex: 'version',
      key: 'version',
      render: (version: string, record) => (
        <Space>
          <Text strong className="font-mono text-lg">{version}</Text>
          {record.isLatest && (
            <Tag color="blue" icon={<StarFilled />}>Latest</Tag>
          )}
          {record.isStable && (
            <Tag color="green" icon={<CheckCircleOutlined />}>Stable</Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Devices',
      dataIndex: 'deviceCount',
      key: 'deviceCount',
      width: 80,
      align: 'center',
      render: (count: number) => (
        <Tag color={count > 0 ? 'blue' : 'default'}>{count || 0}</Tag>
      ),
    },
    {
      title: 'Size',
      dataIndex: 'firmwareSize',
      key: 'firmwareSize',
      render: (size: number) => formatFileSize(size),
    },
    {
      title: 'Min Required',
      dataIndex: 'minRequiredVersion',
      key: 'minRequiredVersion',
      render: (version: string) => version ? <Tag>{version}+</Tag> : '-',
    },
    {
      title: 'Released',
      dataIndex: 'releasedAt',
      key: 'releasedAt',
      render: (date: string) =>
        date ? dayjs(date).format('YYYY-MM-DD HH:mm') : <Tag color="orange">Unreleased</Tag>,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => dayjs(date).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Tooltip title="View Details">
            <Button
              icon={<InfoCircleOutlined />}
              size="small"
              onClick={() => {
                setSelectedFirmware(record);
                setDetailModalVisible(true);
              }}
            />
          </Tooltip>
          <Tooltip title={record.isLatest ? 'Already Latest' : 'Set as Latest'}>
            <Button
              icon={record.isLatest ? <StarFilled /> : <StarOutlined />}
              size="small"
              type={record.isLatest ? 'primary' : 'default'}
              onClick={() => handleRelease(record, { isLatest: true })}
              disabled={record.isLatest}
            />
          </Tooltip>
          <Tooltip title={record.isStable ? 'Mark as Beta' : 'Mark as Stable'}>
            <Button
              icon={<CheckCircleOutlined />}
              size="small"
              type={record.isStable ? 'primary' : 'default'}
              onClick={() => handleRelease(record, { isStable: !record.isStable })}
            >
              {record.isStable ? 'Stable' : 'Beta'}
            </Button>
          </Tooltip>
          <Popconfirm
            title="Delete this firmware version?"
            description="This cannot be undone. Make sure no devices are using this version."
            onConfirm={() => handleDelete(record.id)}
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
    <div className="space-y-4">
      <Card
        title={
          <Space>
            <RocketOutlined />
            <span>Firmware Management</span>
          </Space>
        }
        extra={
          <Space>
            <Button onClick={fetchFirmware}>Refresh</Button>
            <Button
              type="primary"
              icon={<UploadOutlined />}
              onClick={() => {
                form.resetFields();
                setFileList([]);
                setUploadModalVisible(true);
              }}
            >
              Upload New Firmware
            </Button>
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={firmwareList}
          rowKey="id"
          loading={loading}
          scroll={{ x: 800 }}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      {/* Upload Modal */}
      <Modal
        title="Upload New Firmware"
        open={uploadModalVisible}
        onCancel={() => setUploadModalVisible(false)}
        footer={null}
        width={500}
      >
        <Form form={form} layout="vertical" onFinish={handleUpload}>
          <Form.Item
            name="version"
            label="Version"
            rules={[
              { required: true, message: 'Please enter version number' },
              { pattern: /^\d+\.\d+\.\d+$/, message: 'Use semantic versioning (e.g., 1.2.3)' },
            ]}
          >
            <Input placeholder="e.g., 2.1.0" />
          </Form.Item>

          <Form.Item label="Firmware Binary" required>
            <Upload
              beforeUpload={() => false}
              fileList={fileList}
              onChange={({ fileList }) => setFileList(fileList.slice(-1))}
              accept=".bin"
            >
              <Button icon={<CloudUploadOutlined />}>Select .bin File</Button>
            </Upload>
            {fileList[0] && (
              <div className="mt-2">
                <Progress
                  percent={100}
                  size="small"
                  format={() => formatFileSize(fileList[0].size)}
                />
              </div>
            )}
          </Form.Item>

          <Form.Item name="releaseNotes" label="Release Notes">
            <TextArea rows={3} placeholder="What's new in this version?" />
          </Form.Item>

          <Form.Item name="minRequiredVersion" label="Minimum Required Version">
            <Input placeholder="e.g., 1.0.0 (leave empty for no minimum)" />
          </Form.Item>

          <Form.Item name="isStable" label="Mark as Stable" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.Item className="mb-0 text-right">
            <Space>
              <Button onClick={() => setUploadModalVisible(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit" loading={uploading} icon={<UploadOutlined />}>
                Upload Firmware
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* Details Modal */}
      <Modal
        title="Firmware Details"
        open={detailModalVisible}
        onCancel={() => setDetailModalVisible(false)}
        footer={[
          <Button key="close" onClick={() => setDetailModalVisible(false)}>
            Close
          </Button>,
        ]}
        width={600}
      >
        {selectedFirmware && (
          <Descriptions column={2} bordered size="small">
            <Descriptions.Item label="Version" span={2}>
              <Text strong className="text-lg">{selectedFirmware.version}</Text>
              {selectedFirmware.isLatest && <Tag color="blue" className="ml-2">Latest</Tag>}
              {selectedFirmware.isStable && <Tag color="green" className="ml-2">Stable</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="File Size">
              {formatFileSize(selectedFirmware.firmwareSize)}
            </Descriptions.Item>
            <Descriptions.Item label="Min Required">
              {selectedFirmware.minRequiredVersion || 'Any'}
            </Descriptions.Item>
            <Descriptions.Item label="Checksum (SHA256)" span={2}>
              <Text code copyable className="text-xs">
                {selectedFirmware.checksum}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="Download URL" span={2}>
              <Text code copyable className="text-xs break-all">
                {selectedFirmware.firmwareUrl}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="Release Notes" span={2}>
              {selectedFirmware.releaseNotes || <Text type="secondary">No release notes</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="Released At">
              {selectedFirmware.releasedAt
                ? dayjs(selectedFirmware.releasedAt).format('YYYY-MM-DD HH:mm:ss')
                : 'Not released'}
            </Descriptions.Item>
            <Descriptions.Item label="Created At">
              {dayjs(selectedFirmware.createdAt).format('YYYY-MM-DD HH:mm:ss')}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  );
}

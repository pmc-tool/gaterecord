import { useState, useEffect } from 'react';
import { Card, Table, Tag, Typography, Spin, message, Empty, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DesktopOutlined,
  MobileOutlined,
  TabletOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { settingsService, LoginActivity } from '../../../services/settings.service';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

const { Title, Text, Paragraph } = Typography;

// Device icons mapping
const getDeviceIcon = (device: string) => {
  switch (device.toLowerCase()) {
    case 'mobile':
      return <MobileOutlined className="text-lg" />;
    case 'tablet':
      return <TabletOutlined className="text-lg" />;
    default:
      return <DesktopOutlined className="text-lg" />;
  }
};

export default function LoginActivityTab() {
  const [loading, setLoading] = useState(true);
  const [activities, setActivities] = useState<LoginActivity[]>([]);

  useEffect(() => {
    loadActivities();
  }, []);

  const loadActivities = async () => {
    try {
      setLoading(true);
      const data = await settingsService.getLoginActivity(30);
      setActivities(data);
    } catch (error) {
      message.error('Failed to load login activity');
    } finally {
      setLoading(false);
    }
  };

  const columns: ColumnsType<LoginActivity> = [
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <Tag
          icon={status === 'success' ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          color={status === 'success' ? 'success' : 'error'}
        >
          {status === 'success' ? 'Success' : 'Failed'}
        </Tag>
      ),
    },
    {
      title: 'Device',
      key: 'device',
      render: (_, record) => (
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gray-100 rounded-lg">
            {getDeviceIcon(record.device)}
          </div>
          <div>
            <Text strong className="block">
              {record.browser || 'Unknown'} on {record.os || 'Unknown'}
            </Text>
            <Text type="secondary" className="text-xs">
              {record.device}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: 'IP Address',
      dataIndex: 'ipAddress',
      key: 'ipAddress',
      render: (ip: string) => (
        <Tooltip title={ip || 'Unknown'}>
          <Text code>{ip || 'Unknown'}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => (
        <Tooltip title={dayjs(date).format('MMMM D, YYYY h:mm A')}>
          <Text>{dayjs(date).fromNow()}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Reason',
      dataIndex: 'failureReason',
      key: 'failureReason',
      render: (reason: string | null) =>
        reason ? (
          <Text type="danger" className="text-sm">
            {reason}
          </Text>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
  ];

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Card className="shadow-sm">
      <div className="mb-6">
        <Title level={4} className="!mb-2">
          Login Activity
        </Title>
        <Paragraph type="secondary">
          Review your recent login history and monitor account security.
        </Paragraph>
      </div>

      {activities.length === 0 ? (
        <Empty description="No login activity found" />
      ) : (
        <Table
          columns={columns}
          dataSource={activities}
          rowKey="id"
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            showTotal: (total) => `Total ${total} records`,
            selectProps: { listHeight: 256 },
          }}
          scroll={{ x: 800 }}
        />
      )}
    </Card>
  );
}

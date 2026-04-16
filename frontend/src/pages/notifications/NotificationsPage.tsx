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
  Empty,
  message,
  Select,
  Modal,
  Descriptions,
} from 'antd';
import {
  BellOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { notificationService, NotificationsQueryDto } from '../../services/notification.service';
import { Notification, NotificationType, NotificationPriority } from '../../types';

const { Title, Text } = Typography;
const { Option } = Select;

const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  [NotificationType.SECURITY_ALERT]: 'Security Alert',
  [NotificationType.VISITOR_ENTRY]: 'Visitor Entry',
  [NotificationType.ACCESS_DENIED]: 'Access Denied',
  [NotificationType.SYSTEM_ALERT]: 'System Alert',
  [NotificationType.GATE_OFFLINE]: 'Gate Offline',
  [NotificationType.MAINTENANCE]: 'Maintenance',
  [NotificationType.SUBSCRIPTION]: 'Subscription',
};

const NOTIFICATION_TYPE_ICONS: Record<NotificationType, string> = {
  [NotificationType.SECURITY_ALERT]: '🚨',
  [NotificationType.VISITOR_ENTRY]: '👤',
  [NotificationType.ACCESS_DENIED]: '🚫',
  [NotificationType.SYSTEM_ALERT]: '⚙️',
  [NotificationType.GATE_OFFLINE]: '📡',
  [NotificationType.MAINTENANCE]: '🔧',
  [NotificationType.SUBSCRIPTION]: '💳',
};

const PRIORITY_COLORS: Record<NotificationPriority, string> = {
  [NotificationPriority.LOW]: 'green',
  [NotificationPriority.MEDIUM]: 'blue',
  [NotificationPriority.HIGH]: 'orange',
  [NotificationPriority.URGENT]: 'red',
};

export function NotificationsPage() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNotification, setSelectedNotification] = useState<Notification | null>(null);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: 1,
    pageSize: 20,
    total: 0,
  });
  const [filters, setFilters] = useState<NotificationsQueryDto>({});

  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true);
      const [response, counts] = await Promise.all([
        notificationService.getAll({
          ...filters,
          page: pagination.current,
          limit: pagination.pageSize,
        }),
        notificationService.getCounts(),
      ]);
      setNotifications(response.notifications);
      setTotal(response.total);
      setUnreadCount(counts.unread);
      setPagination(prev => ({ ...prev, total: response.total }));
    } catch (error) {
      console.error('Failed to fetch notifications:', error);
      message.error('Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }, [filters, pagination.current, pagination.pageSize]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const handleMarkAsRead = async (ids: string[]) => {
    try {
      await notificationService.markAsRead(ids);
      message.success('Marked as read');
      fetchNotifications();
    } catch (error) {
      message.error('Failed to mark as read');
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      await notificationService.markAllAsRead();
      message.success('All notifications marked as read');
      fetchNotifications();
    } catch (error) {
      message.error('Failed to mark all as read');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await notificationService.delete(id);
      message.success('Notification deleted');
      fetchNotifications();
    } catch (error) {
      message.error('Failed to delete notification');
    }
  };

  const handleTableChange = (newPagination: TablePaginationConfig) => {
    setPagination(newPagination);
  };

  const handleRowClick = async (notification: Notification) => {
    // If unread, mark as read and update local state immediately
    if (!notification.isRead) {
      // Update both selectedNotification and list state immediately for better UX
      const updatedNotification = { ...notification, isRead: true };
      setSelectedNotification(updatedNotification);
      setDetailModalVisible(true);
      
      setNotifications(prev => 
        prev.map(n => n.id === notification.id ? { ...n, isRead: true } : n)
      );
      setUnreadCount(prev => Math.max(0, prev - 1));
      
      // Then sync with server
      try {
        await notificationService.markAsRead([notification.id]);
      } catch (error) {
        // Revert on error
        setSelectedNotification(notification);
        setNotifications(prev => 
          prev.map(n => n.id === notification.id ? { ...n, isRead: false } : n)
        );
        setUnreadCount(prev => prev + 1);
      }
    } else {
      // Already read - just open modal
      setSelectedNotification(notification);
      setDetailModalVisible(true);
    }
  };

  const handleGoToLink = () => {
    const link = selectedNotification?.metadata?.link as string | undefined;
    if (link) {
      setDetailModalVisible(false);
      navigate(link);
    }
  };

  const columns: ColumnsType<Notification> = [
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 150,
      render: (type: NotificationType) => (
        <Space>
          <span>{NOTIFICATION_TYPE_ICONS[type]}</span>
          <Text>{NOTIFICATION_TYPE_LABELS[type]}</Text>
        </Space>
      ),
      filters: Object.values(NotificationType).map(t => ({
        text: NOTIFICATION_TYPE_LABELS[t],
        value: t,
      })),
    },
    {
      title: 'Priority',
      dataIndex: 'priority',
      key: 'priority',
      width: 100,
      render: (priority: NotificationPriority) => (
        <Tag color={PRIORITY_COLORS[priority]}>
          {priority.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, record: Notification) => (
        <div>
          <Text strong={!record.isRead}>{title}</Text>
          {!record.isRead && (
            <Tag color="blue" className="ml-2">Unread</Tag>
          )}
        </div>
      ),
    },
    {
      title: 'Message',
      dataIndex: 'message',
      key: 'message',
      ellipsis: true,
      render: (message: string) => (
        <Text type="secondary" className="text-sm">{message}</Text>
      ),
    },
    {
      title: 'Time',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (date: string) => new Date(date).toLocaleString(),
      sorter: true,
      defaultSortOrder: 'descend',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 80,
      render: (_, record: Notification) => (
        <Space>
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(record.id);
            }}
            title="Delete"
          />
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <Title level={2} className="mb-0">
          <BellOutlined className="mr-2" />
          Notifications
        </Title>
        <Space>
          <Button
            onClick={handleMarkAllAsRead}
            disabled={unreadCount === 0}
          >
            Mark All as Read
          </Button>
        </Space>
      </div>

      <Row gutter={16} className="mb-6">
        <Col xs={12} sm={8} md={6}>
          <Card>
            <Statistic
              title="Total"
              value={total}
              prefix={<BellOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card>
            <Statistic
              title="Unread"
              value={unreadCount}
              valueStyle={{ color: unreadCount > 0 ? '#1890ff' : undefined }}
            />
          </Card>
        </Col>
      </Row>

      <Card>
        <Space className="mb-4">
          <Select
            placeholder="Filter by type"
            allowClear
            style={{ width: 180 }}
            onChange={(value) => setFilters(prev => ({ ...prev, type: value }))}
          >
            {Object.values(NotificationType).map(type => (
              <Option key={type} value={type}>
                {NOTIFICATION_TYPE_ICONS[type]} {NOTIFICATION_TYPE_LABELS[type]}
              </Option>
            ))}
          </Select>
          <Select
            placeholder="Filter by status"
            allowClear
            style={{ width: 150 }}
            onChange={(value) => setFilters(prev => ({ ...prev, isRead: value }))}
          >
            <Option value={false}>Unread</Option>
            <Option value={true}>Read</Option>
          </Select>
        </Space>

        {notifications.length === 0 && !loading ? (
          <Empty description="No notifications" />
        ) : (
          <Table
            columns={columns}
            dataSource={notifications}
            rowKey="id"
            loading={loading}
            pagination={pagination}
            onChange={handleTableChange}
            scroll={{ x: 700 }}
            onRow={(record) => ({
              onClick: () => handleRowClick(record),
              className: `cursor-pointer ${!record.isRead ? 'bg-blue-50' : ''}`,
            })}
          />
        )}
      </Card>

      {/* Notification Detail Modal */}
      <Modal
        title="Notification Details"
        open={detailModalVisible}
        onCancel={() => setDetailModalVisible(false)}
        footer={null}
        width={600}
      >
        {selectedNotification && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Type">
              <Space>
                <span>{NOTIFICATION_TYPE_ICONS[selectedNotification.type]}</span>
                <Text>{NOTIFICATION_TYPE_LABELS[selectedNotification.type]}</Text>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="Priority">
              <Tag color={PRIORITY_COLORS[selectedNotification.priority]}>
                {selectedNotification.priority.toUpperCase()}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Title">
              <Text strong>{selectedNotification.title}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="Message">
              <div style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                {selectedNotification.message}
              </div>
            </Descriptions.Item>
            <Descriptions.Item label="Time">
              {new Date(selectedNotification.createdAt).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag color={selectedNotification.isRead ? 'default' : 'blue'}>
                {selectedNotification.isRead ? 'Read' : 'Unread'}
              </Tag>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  );
}

export default NotificationsPage;

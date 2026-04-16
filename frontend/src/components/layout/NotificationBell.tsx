import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Dropdown, Typography, Button, Spin, Empty } from 'antd';
import { BellOutlined, RightOutlined } from '@ant-design/icons';
import { notificationService } from '../../services/notification.service';
import { Notification, NotificationType, NotificationPriority } from '../../types';

const { Text } = Typography;

const NOTIFICATION_TYPE_ICONS: Record<NotificationType, string> = {
  [NotificationType.SECURITY_ALERT]: '🚨',
  [NotificationType.VISITOR_ENTRY]: '👤',
  [NotificationType.ACCESS_DENIED]: '🚫',
  [NotificationType.SYSTEM_ALERT]: '⚙️',
  [NotificationType.GATE_OFFLINE]: '📡',
  [NotificationType.MAINTENANCE]: '🔧',
  [NotificationType.SUBSCRIPTION]: '💳',
};

const NOTIFICATION_TYPE_COLORS: Record<NotificationType, string> = {
  [NotificationType.SECURITY_ALERT]: 'bg-red-100',
  [NotificationType.VISITOR_ENTRY]: 'bg-blue-100',
  [NotificationType.ACCESS_DENIED]: 'bg-orange-100',
  [NotificationType.SYSTEM_ALERT]: 'bg-gray-100',
  [NotificationType.GATE_OFFLINE]: 'bg-yellow-100',
  [NotificationType.MAINTENANCE]: 'bg-purple-100',
  [NotificationType.SUBSCRIPTION]: 'bg-green-100',
};

const PRIORITY_COLORS: Record<NotificationPriority, string> = {
  [NotificationPriority.LOW]: '#52c41a',
  [NotificationPriority.MEDIUM]: '#1890ff',
  [NotificationPriority.HIGH]: '#fa8c16',
  [NotificationPriority.URGENT]: '#ff4d4f',
};

export function NotificationBell() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true);
      const [unreadNotifications, counts] = await Promise.all([
        notificationService.getUnread(10),
        notificationService.getCounts(),
      ]);
      setNotifications(unreadNotifications);
      setUnreadCount(counts.unread);
    } catch (error) {
      console.error('Failed to fetch notifications:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNotifications();

    // Poll for new notifications every 30 seconds
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  const handleMarkAsRead = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await notificationService.markAsRead([id]);
      setNotifications(prev => prev.filter(n => n.id !== id));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      await notificationService.markAllAsRead();
      setNotifications([]);
      setUnreadCount(0);
    } catch (error) {
      console.error('Failed to mark all notifications as read:', error);
    }
  };

  const handleNotificationClick = (notification: Notification) => {
    // Navigate to notifications page
    navigate('/notifications');
    setDropdownOpen(false);
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
  };

  const formatDateHeader = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric' 
    });
  };

  // Group notifications by date
  const groupedNotifications = useMemo(() => {
    const groups: Record<string, Notification[]> = {};
    
    notifications.forEach(notification => {
      const dateKey = new Date(notification.createdAt).toDateString();
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey].push(notification);
    });

    // Sort groups by date (newest first)
    return Object.entries(groups)
      .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
      .map(([dateKey, items]) => ({
        date: dateKey,
        notifications: items.sort((a, b) => 
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
      }));
  }, [notifications]);

  const dropdownContent = (
    <div className="w-96 bg-white rounded-xl shadow-xl border border-gray-100">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <Text strong className="text-lg">Notifications</Text>
        {unreadCount > 0 && (
          <Button 
            type="link" 
            size="small" 
            onClick={handleMarkAllAsRead}
            className="text-blue-500 hover:text-blue-600 font-medium"
          >
            Mark all as read
          </Button>
        )}
      </div>

      {/* Content */}
      {loading && notifications.length === 0 ? (
        <div className="flex justify-center py-12">
          <Spin />
        </div>
      ) : notifications.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No unread notifications"
          className="py-12"
        />
      ) : (
        <div className="max-h-[400px] overflow-y-auto">
          {groupedNotifications.map((group) => (
            <div key={group.date}>
              {/* Date Header */}
              <div className="px-5 py-2 bg-gray-50 border-b border-gray-100">
                <Text className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {formatDateHeader(group.date)}
                </Text>
              </div>
              
              {/* Notifications for this date */}
              <div className="px-4 py-2">
                {group.notifications.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => handleNotificationClick(item)}
                    className="flex items-start gap-3 p-3 mb-2 bg-white rounded-xl border border-gray-200 hover:border-blue-300 hover:shadow-md cursor-pointer transition-all duration-200 group"
                  >
                    {/* Icon/Thumbnail */}
                    <div className={`w-14 h-14 rounded-lg flex items-center justify-center flex-shrink-0 ${NOTIFICATION_TYPE_COLORS[item.type] || 'bg-gray-100'}`}>
                      <span className="text-2xl">
                        {NOTIFICATION_TYPE_ICONS[item.type] || '📢'}
                      </span>
                    </div>
                    
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span 
                          className="text-xs font-medium text-blue-500"
                        >
                          {formatTime(item.createdAt)}
                        </span>
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: PRIORITY_COLORS[item.priority] }}
                        />
                      </div>
                      <Text strong className="text-sm text-gray-900 block leading-tight line-clamp-1">
                        {item.title}
                      </Text>
                      <Text className="text-xs text-gray-500 block mt-0.5 line-clamp-2 leading-relaxed">
                        {item.message}
                      </Text>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-gray-100 px-5 py-3">
        <button
          onClick={() => {
            navigate('/notifications');
            setDropdownOpen(false);
          }}
          className="flex items-center justify-center gap-2 w-full text-blue-500 hover:text-blue-600 font-medium text-sm transition-colors"
        >
          View all Notifications
          <RightOutlined className="text-xs" />
        </button>
      </div>
    </div>
  );

  return (
    <Dropdown
      trigger={['click']}
      open={dropdownOpen}
      onOpenChange={setDropdownOpen}
      dropdownRender={() => dropdownContent}
      placement="bottomRight"
    >
      <div className="flex items-center">
        <Badge count={unreadCount} size="small" offset={[-2, 2]}>
          <BellOutlined
            className="text-xl cursor-pointer hover:text-blue-500 transition-colors"
            onClick={() => setDropdownOpen(!dropdownOpen)}
          />
        </Badge>
      </div>
    </Dropdown>
  );
}

export default NotificationBell;

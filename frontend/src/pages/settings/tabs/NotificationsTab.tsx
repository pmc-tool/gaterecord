import { useState, useEffect } from 'react';
import { Card, Switch, Typography, Spin, message, Divider } from 'antd';
import {
  BellOutlined,
  MailOutlined,
  SafetyOutlined,
  UsergroupAddOutlined,
} from '@ant-design/icons';
import { settingsService, NotificationSettings } from '../../../services/settings.service';

const { Title, Text, Paragraph } = Typography;

interface NotificationItem {
  key: keyof NotificationSettings;
  icon: React.ReactNode;
  title: string;
  description: string;
}

export default function NotificationsTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [settings, setSettings] = useState<NotificationSettings>({
    pushNotifications: true,
    emailAlerts: true,
    securityAlerts: true,
    visitorNotifications: true,
  });

  const notificationItems: NotificationItem[] = [
    {
      key: 'pushNotifications',
      icon: <BellOutlined className="text-2xl text-blue-500" />,
      title: 'Push Notifications',
      description: 'Receive instant notifications for important updates',
    },
    {
      key: 'emailAlerts',
      icon: <MailOutlined className="text-2xl text-green-500" />,
      title: 'Email Alerts',
      description: 'Get email notifications for critical events',
    },
    {
      key: 'securityAlerts',
      icon: <SafetyOutlined className="text-2xl text-red-500" />,
      title: 'Security Alerts',
      description: 'Receive alerts for security-related events',
    },
    {
      key: 'visitorNotifications',
      icon: <UsergroupAddOutlined className="text-2xl text-purple-500" />,
      title: 'Visitor Notifications',
      description: 'Get notified when visitors arrive or passes are used',
    },
  ];

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const data = await settingsService.getNotificationSettings();
      setSettings(data);
    } catch (error) {
      message.error('Failed to load notification settings');
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (key: keyof NotificationSettings, value: boolean) => {
    try {
      setSaving(key);
      const updatedSettings = await settingsService.updateNotificationSettings({ [key]: value });
      setSettings(updatedSettings);
      message.success('Settings updated');
    } catch (error) {
      message.error('Failed to update settings');
    } finally {
      setSaving(null);
    }
  };

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
          Notifications
        </Title>
        <Paragraph type="secondary">
          Manage your notification settings.
        </Paragraph>
      </div>

      <div className="space-y-4">
        {notificationItems.map((item, index) => (
          <div key={item.key}>
            <div className="flex items-center justify-between p-4 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors">
              <div className="flex items-center gap-4">
                {item.icon}
                <div>
                  <Text strong className="block">
                    {item.title}
                  </Text>
                  <Text type="secondary" className="text-sm">
                    {item.description}
                  </Text>
                </div>
              </div>
              <Switch
                checked={settings[item.key]}
                onChange={(checked) => handleToggle(item.key, checked)}
                loading={saving === item.key}
              />
            </div>
            {index < notificationItems.length - 1 && <Divider className="!my-2" />}
          </div>
        ))}
      </div>
    </Card>
  );
}

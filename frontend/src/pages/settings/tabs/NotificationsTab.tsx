import { useState, useEffect } from 'react';
import { Card, Switch, Typography, Spin, message, Divider } from 'antd';
import {
  MailOutlined,
  BellOutlined,
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
    emailNotifications: true,
    inAppNotifications: true,
  });

  const notificationItems: NotificationItem[] = [
    {
      key: 'emailNotifications',
      icon: <MailOutlined className="text-2xl text-green-500" />,
      title: 'Email Notifications',
      description: 'Receive notifications via email',
    },
    {
      key: 'inAppNotifications',
      icon: <BellOutlined className="text-2xl text-blue-500" />,
      title: 'In-App Notifications',
      description: 'Receive notifications in the app (bell icon)',
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

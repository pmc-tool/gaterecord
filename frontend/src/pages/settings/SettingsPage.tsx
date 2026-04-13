import { useState } from 'react';
import { Typography, Tabs } from 'antd';
import { LockOutlined, BellOutlined, HistoryOutlined } from '@ant-design/icons';
import SecurityTab from './tabs/SecurityTab';
import NotificationsTab from './tabs/NotificationsTab';
import LoginActivityTab from './tabs/LoginActivityTab';

const { Title } = Typography;

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('security');

  const tabItems = [
    {
      key: 'security',
      label: (
        <span className="flex items-center gap-2">
          <LockOutlined />
          Security
        </span>
      ),
      children: <SecurityTab />,
    },
    {
      key: 'notifications',
      label: (
        <span className="flex items-center gap-2">
          <BellOutlined />
          Notifications
        </span>
      ),
      children: <NotificationsTab />,
    },
    {
      key: 'login-activity',
      label: (
        <span className="flex items-center gap-2">
          <HistoryOutlined />
          Login Activity
        </span>
      ),
      children: <LoginActivityTab />,
    },
  ];

  return (
    <div className="max-w-4xl mx-auto">
      <Title level={2} className="text-center mb-6">
        Settings
      </Title>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        centered
        size="large"
        className="settings-tabs"
      />
    </div>
  );
}

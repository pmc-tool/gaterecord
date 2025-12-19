import { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Avatar, Dropdown, Typography, Space } from 'antd';
import {
  DashboardOutlined,
  GatewayOutlined,
  UserOutlined,
  SettingOutlined,
  LogoutOutlined,
  TeamOutlined,
  HistoryOutlined,
  ExperimentOutlined,
  BuildOutlined,
  UsergroupAddOutlined,
  DollarOutlined,
  AlertOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../../store/authStore';
import { UserRole, User } from '../../types';
import { socketService } from '../../services/socket.service';

interface UserWithTenant extends User {
  tenant?: { id: string; name: string; slug: string } | null;
}

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, tokens } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);
  const userWithTenant = user as UserWithTenant | null;

  useEffect(() => {
    if (tokens?.accessToken) {
      socketService.connect(tokens.accessToken);
    }

    return () => {
      socketService.disconnect();
    };
  }, [tokens?.accessToken]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const menuItems = [
    {
      key: '/dashboard',
      icon: <DashboardOutlined />,
      label: 'Dashboard',
    },
    {
      key: '/visitors',
      icon: <UsergroupAddOutlined />,
      label: [UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY].includes(user?.role as UserRole)
        ? 'Visitor Management'
        : 'My Visitors',
    },
    {
      key: '/gates',
      icon: <GatewayOutlined />,
      label: 'Gates',
      roles: [UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY],
    },
    {
      key: '/simulator',
      icon: <ExperimentOutlined />,
      label: 'Gate Simulator',
      roles: [UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY],
    },
    {
      key: '/events',
      icon: <HistoryOutlined />,
      label: 'Access Events',
    },
    {
      key: '/security-alerts',
      icon: <AlertOutlined />,
      label: 'Security Alerts',
      roles: [UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY],
    },
    {
      key: '/users',
      icon: <TeamOutlined />,
      label: 'Users',
      roles: [UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN],
    },
    {
      key: '/admin',
      icon: <BuildOutlined />,
      label: 'Admin',
      roles: [UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN],
      children: [
        // Only SUPER_ADMIN can manage all buildings/tenants and see subscriptions
        ...(user?.role === UserRole.SUPER_ADMIN ? [
          {
            key: '/admin/subscriptions',
            icon: <DollarOutlined />,
            label: 'Subscriptions',
          },
          {
            key: '/admin/plans',
            label: 'Plans',
          },
          {
            key: '/admin/tenants',
            label: 'Buildings',
          },
        ] : []),
        {
          key: '/admin/residents',
          label: 'Residents',
        },
        {
          key: '/admin/vehicles',
          label: 'Vehicles',
        },
      ],
    },
  ].filter((item) => !item.roles || item.roles.includes(user?.role as UserRole));

  const userMenu = {
    items: [
      {
        key: 'profile',
        icon: <UserOutlined />,
        label: 'Profile',
      },
      {
        key: 'settings',
        icon: <SettingOutlined />,
        label: 'Settings',
      },
      {
        type: 'divider' as const,
      },
      {
        key: 'logout',
        icon: <LogoutOutlined />,
        label: 'Logout',
        danger: true,
        onClick: handleLogout,
      },
    ],
  };

  return (
    <Layout className="min-h-screen">
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="light"
        className="shadow-sm"
      >
        <div className="h-16 flex items-center justify-center border-b">
          <Text strong className="text-lg">
            {collapsed ? 'GM' : 'Gate Management'}
          </Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          className="border-r-0"
        />
      </Sider>

      <Layout>
        <Header className="bg-white px-6 flex items-center justify-between shadow-sm">
          <div>
            <Text type="secondary">
              {userWithTenant?.tenant ? userWithTenant.tenant.name : 'Super Admin'}
            </Text>
          </div>

          <Dropdown menu={userMenu} trigger={['click']}>
            <Space className="cursor-pointer">
              <Avatar icon={<UserOutlined />} />
              <Text>
                {user?.firstName} {user?.lastName}
              </Text>
            </Space>
          </Dropdown>
        </Header>

        <Content className="m-6 p-6 bg-white rounded-lg shadow-sm min-h-[calc(100vh-140px)]">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

export default AppLayout;

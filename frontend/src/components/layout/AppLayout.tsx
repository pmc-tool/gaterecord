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
  DesktopOutlined,
  CreditCardOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../../store/authStore';
import { UserRole, User } from '../../types';
import { socketService } from '../../services/socket.service';
import { PlansModal } from '../billing/PlansModal';

interface UserWithTenant extends Omit<User, 'tenant'> {
  tenant?: { id: string; name: string; slug: string };
}

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, tokens } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);
  const [plansModalOpen, setPlansModalOpen] = useState(false);
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
            key: '/admin/payments',
            icon: <CreditCardOutlined />,
            label: 'Payments',
          },
          {
            key: '/admin/plans',
            label: 'Plans',
          },
          {
            key: '/admin/tenants',
            label: 'Buildings',
          },
          // {
          //   key: '/admin/firmware',
          //   icon: <CloudUploadOutlined />,
          //   label: 'Firmware',
          // },
        ] : []),
        {
          key: '/admin/devices',
          icon: <DesktopOutlined />,
          label: 'Devices',
        },
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
    // Billing Settings for building admins
    {
      key: '/billing/settings',
      icon: <CreditCardOutlined />,
      label: 'Billing',
      roles: [UserRole.BUILDING_ADMIN],
    },
    // Upgrade for building admins
    {
      key: 'upgrade',
      icon: <RocketOutlined />,
      label: 'Upgrade',
      roles: [UserRole.BUILDING_ADMIN],
    },
  ].filter((item) => !item.roles || item.roles.includes(user?.role as UserRole));

  const handleMenuClick = ({ key }: { key: string }) => {
    if (key === 'upgrade') {
      setPlansModalOpen(true);
    } else {
      navigate(key);
    }
  };

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
        <div className="h-16 flex items-center justify-center border-b px-2">
          <img
            src="/logo.png"
            alt="GateRecord"
            className={collapsed ? "h-8 w-8 object-contain" : "h-12 object-contain"}
          />
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={handleMenuClick}
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
      
      {/* Plans Modal */}
      {user?.role === UserRole.BUILDING_ADMIN && (
        <PlansModal
          open={plansModalOpen}
          onClose={() => setPlansModalOpen(false)}
        />
      )}
    </Layout>
  );
}

export default AppLayout;

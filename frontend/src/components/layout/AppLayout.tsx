import { useState, useEffect, useMemo } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Avatar, Dropdown, Typography, Space, Modal, Spin, Drawer, Button } from 'antd';
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
  QrcodeOutlined,
  MenuOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { QRCodeSVG } from 'qrcode.react';
import { useAuthStore } from '../../store/authStore';
import { UserRole, User } from '../../types';
import { socketService } from '../../services/socket.service';
import { PlansModal } from '../billing/PlansModal';
import { NotificationBell } from './NotificationBell';

interface UserWithTenant extends Omit<User, 'tenant'> {
  tenant?: { id: string; name: string; slug: string };
}

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, tokens, isLoading } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [plansModalOpen, setPlansModalOpen] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const userWithTenant = user as UserWithTenant | null;

  // Handle window resize for mobile detection
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
      if (window.innerWidth >= 768) {
        setMobileMenuOpen(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

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

  // Memoize menu items to only re-compute when user.role changes
  const menuItems = useMemo(() => {
    // Don't render menu until user role is available
    if (!user?.role) return [];
    
    return [
    {
      key: '/dashboard',
      icon: <DashboardOutlined />,
      label: 'Dashboard',
    },
    {
      key: '/visitors',
      icon: <UsergroupAddOutlined />,
      label: [UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN].includes(user?.role as UserRole)
        ? 'Visitor Management'
        : 'My Visitors',
      roles: [UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.RESIDENT],
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
  }, [user?.role]);

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
        onClick: () => navigate('/profile'),
      },
      {
        key: 'myqrcode',
        icon: <QrcodeOutlined />,
        label: 'My QR Code',
        onClick: () => setQrModalOpen(true),
      },
      {
        key: 'settings',
        icon: <SettingOutlined />,
        label: 'Settings',
        onClick: () => navigate('/settings'),
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
      {/* Desktop Sidebar */}
      {!isMobile && (
        <Sider
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          theme="light"
          className="shadow-sm hidden md:block"
          style={{ position: 'fixed', left: 0, top: 0, bottom: 0, zIndex: 100 }}
        >
          <div className="h-16 flex items-center justify-center border-b px-2">
            <img
              src="/logo.svg"
              alt="Yaad"
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
      )}

      {/* Mobile Drawer */}
      <Drawer
        title={
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="Yaad" className="h-8 object-contain" />
            <span className="font-semibold">Yaad</span>
          </div>
        }
        placement="left"
        onClose={() => setMobileMenuOpen(false)}
        open={mobileMenuOpen}
        width={280}
        className="md:hidden"
        styles={{ body: { padding: 0 } }}
        closeIcon={<CloseOutlined />}
      >
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={handleMenuClick}
          className="border-r-0"
          style={{ border: 'none' }}
        />
      </Drawer>

      <Layout style={{ marginLeft: isMobile ? 0 : (collapsed ? 80 : 200), transition: 'margin-left 0.2s' }}>
        <Header className="bg-white px-4 md:px-6 flex items-center justify-between shadow-sm sticky top-0 z-50">
          <div className="flex items-center gap-3">
            {/* Mobile Menu Button */}
            {isMobile && (
              <Button
                type="text"
                icon={<MenuOutlined />}
                onClick={() => setMobileMenuOpen(true)}
                className="md:hidden"
                size="large"
              />
            )}
            <Text type="secondary" className="hidden sm:block">
              {userWithTenant?.tenant ? userWithTenant.tenant.name : 'Super Admin'}
            </Text>
          </div>

          <div className="flex items-center gap-2 sm:gap-6">
            <NotificationBell />
            
            <Dropdown menu={userMenu} trigger={['click']}>
              <div className="flex items-center gap-2 cursor-pointer">
                <Avatar 
                  src={user?.profileImageUrl} 
                  icon={!user?.profileImageUrl && <UserOutlined />}
                  size={isMobile ? 'small' : 'default'}
                />
                <Text className="hidden sm:inline">
                  {user?.firstName} {user?.lastName}
                </Text>
              </div>
            </Dropdown>
          </div>
        </Header>

        <Content className="m-2 sm:m-4 md:m-6 p-3 sm:p-4 md:p-6 bg-white rounded-lg shadow-sm min-h-[calc(100vh-140px)]">
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

      {/* QR Code Modal */}
      <Modal
        title="My QR Code"
        open={qrModalOpen}
        onCancel={() => setQrModalOpen(false)}
        footer={null}
        centered
        width={320}
      >
        <div className="flex flex-col items-center py-4">
          {user?.qrCode ? (
            <QRCodeSVG 
              value={user.qrCode} 
              size={200}
              level="H"
              includeMargin
            />
          ) : (
            <Text type="secondary">No QR Code available</Text>
          )}
        </div>
      </Modal>
    </Layout>
  );
}

export default AppLayout;

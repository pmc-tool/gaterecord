import { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  message,
  Popconfirm,
  Tooltip,
  Badge,
  List,
  Empty,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  UserOutlined,
  CarOutlined,
  CreditCardOutlined,
} from '@ant-design/icons';
import RfidRegistrationModal from '../../components/RfidRegistrationModal';
import type { ColumnsType } from 'antd/es/table';
import api from '../../services/api';

interface RfidCard {
  id: string;
  uid: string;
  label?: string;
  status: string;
  createdAt: string;
}

interface Resident {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  unit: string;
  status: string;
  tenantId: string;
  tenant?: { name: string };
  vehicles?: { id: string; licensePlate: string }[];
  rfidCards?: RfidCard[];
}

export default function ResidentsPage() {
  const [residents, setResidents] = useState<Resident[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingResident, setEditingResident] = useState<Resident | null>(null);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [form] = Form.useForm();

  // RFID Registration state
  const [rfidModalVisible, setRfidModalVisible] = useState(false);
  const [rfidTargetResident, setRfidTargetResident] = useState<Resident | null>(null);

  // RFID Cards list modal state
  const [cardsModalVisible, setCardsModalVisible] = useState(false);
  const [selectedResidentForCards, setSelectedResidentForCards] = useState<Resident | null>(null);
  const [deletingCardId, setDeletingCardId] = useState<string | null>(null);

  const fetchResidents = async () => {
    setLoading(true);
    try {
      const response = await api.get('/residents');
      setResidents(response.data);
    } catch (error) {
      message.error('Failed to fetch residents');
    } finally {
      setLoading(false);
    }
  };

  const fetchTenants = async () => {
    try {
      const response = await api.get('/admin/tenants');
      setTenants(response.data);
    } catch (error) {
      console.error('Failed to fetch tenants');
    }
  };

  useEffect(() => {
    fetchResidents();
    fetchTenants();
  }, []);

  const handleCreate = () => {
    setEditingResident(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (resident: Resident) => {
    setEditingResident(resident);
    form.setFieldsValue({
      ...resident,
      isActive: resident.status === 'active',
    });
    setModalVisible(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/residents/${id}`);
      message.success('Resident deleted successfully');
      fetchResidents();
    } catch (error) {
      message.error('Failed to delete resident');
    }
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    try {
      if (editingResident) {
        await api.patch(`/residents/${editingResident.id}`, values);
        message.success('Resident updated successfully');
      } else {
        await api.post('/residents', values);
        message.success('Resident created successfully');
      }
      setModalVisible(false);
      fetchResidents();
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      message.error(err.response?.data?.message || 'Failed to save resident');
    }
  };

  // RFID Registration handlers
  const handleRegisterRfid = (resident: Resident) => {
    setRfidTargetResident(resident);
    setRfidModalVisible(true);
  };

  const handleRfidRegistrationSuccess = (rfidUid: string) => {
    message.success(`RFID card ${rfidUid} registered successfully!`);
    setRfidModalVisible(false);
    setRfidTargetResident(null);
    fetchResidents();
  };

  // RFID Cards list handlers
  const handleViewCards = (resident: Resident) => {
    setSelectedResidentForCards(resident);
    setCardsModalVisible(true);
  };

  const handleDeleteCard = async (cardId: string) => {
    setDeletingCardId(cardId);
    try {
      await api.delete(`/rfid-cards/${cardId}`);
      message.success('RFID card deleted successfully');
      // Refresh residents to update the card count
      await fetchResidents();
      // Update the selected resident's cards
      if (selectedResidentForCards) {
        const updated = residents.find(r => r.id === selectedResidentForCards.id);
        if (updated) {
          setSelectedResidentForCards(updated);
        }
      }
    } catch (error) {
      message.error('Failed to delete RFID card');
    } finally {
      setDeletingCardId(null);
    }
  };

  // Keep selected resident in sync after fetch
  useEffect(() => {
    if (selectedResidentForCards) {
      const updated = residents.find(r => r.id === selectedResidentForCards.id);
      if (updated) {
        setSelectedResidentForCards(updated);
      }
    }
  }, [residents, selectedResidentForCards]);

  const columns: ColumnsType<Resident> = [
    {
      title: 'Name',
      key: 'name',
      render: (_, record) => (
        <Space>
          <UserOutlined />
          <span className="font-medium">
            {record.firstName} {record.lastName}
          </span>
        </Space>
      ),
      sorter: (a, b) =>
        `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
    },
    {
      title: 'Unit',
      dataIndex: 'unit',
      key: 'unit',
      render: (unit: string) => <Tag>{unit}</Tag>,
    },
    {
      title: 'Building',
      dataIndex: ['tenant', 'name'],
      key: 'tenant',
    },
    {
      title: 'Contact',
      key: 'contact',
      render: (_, record) => (
        <div className="text-sm">
          {record.email && <div>{record.email}</div>}
          {record.phone && <div className="text-gray-500">{record.phone}</div>}
        </div>
      ),
    },
    {
      title: 'Vehicles',
      key: 'vehicles',
      render: (_, record) => (
        <Space>
          <CarOutlined />
          <Badge count={record.vehicles?.length || 0} showZero />
        </Space>
      ),
    },
    {
      title: 'Access Cards',
      key: 'accessCards',
      render: (_, record) => (
        <Tooltip title="Click to view cards">
          <Button
            type="link"
            size="small"
            onClick={() => handleViewCards(record)}
            style={{ padding: 0 }}
          >
            <Space>
              <CreditCardOutlined />
              <Badge
                count={record.rfidCards?.length || 0}
                showZero
                style={{ backgroundColor: record.rfidCards?.length ? '#52c41a' : '#d9d9d9' }}
              />
            </Space>
          </Button>
        </Tooltip>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={status === 'active' ? 'success' : 'default'}>
          {status === 'active' ? 'Active' : 'Inactive'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Tooltip title="Register RFID Card">
            <Button
              icon={<CreditCardOutlined />}
              size="small"
              type="primary"
              ghost
              onClick={() => handleRegisterRfid(record)}
            />
          </Tooltip>
          <Tooltip title="Edit">
            <Button icon={<EditOutlined />} size="small" onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm
            title="Delete this resident?"
            onConfirm={() => handleDelete(record.id)}
            okText="Yes"
            cancelText="No"
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
    <div>
      <Card
        title="Residents Management"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchResidents}>
              Refresh
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              Add Resident
            </Button>
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={residents}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Modal
        title={editingResident ? 'Edit Resident' : 'Add Resident'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <div className="grid grid-cols-2 gap-4">
            <Form.Item
              name="firstName"
              label="First Name"
              rules={[{ required: true, message: 'Please enter first name' }]}
            >
              <Input placeholder="First name" />
            </Form.Item>

            <Form.Item
              name="lastName"
              label="Last Name"
              rules={[{ required: true, message: 'Please enter last name' }]}
            >
              <Input placeholder="Last name" />
            </Form.Item>
          </div>

          <Form.Item
            name="unit"
            label="Unit Number"
            rules={[{ required: true, message: 'Please enter unit number' }]}
          >
            <Input placeholder="e.g., A-101" />
          </Form.Item>

          <Form.Item
            name="tenantId"
            label="Building"
            rules={[{ required: true, message: 'Please select building' }]}
          >
            <Select placeholder="Select building">
              {tenants.map((tenant) => (
                <Select.Option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: 'Please enter email' },
              { type: 'email', message: 'Please enter a valid email' },
            ]}
          >
            <Input placeholder="email@example.com" />
          </Form.Item>

          {!editingResident && (
            <Form.Item name="password" label="Password (optional, default: Resident123!)">
              <Input.Password placeholder="Leave blank for default password" />
            </Form.Item>
          )}

          <Form.Item name="phone" label="Phone">
            <Input placeholder="+1 234 567 8900" />
          </Form.Item>

          <Form.Item name="isActive" label="Status" initialValue={true}>
            <Select>
              <Select.Option value={true}>Active</Select.Option>
              <Select.Option value={false}>Inactive</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item className="mb-0 text-right">
            <Space>
              <Button onClick={() => setModalVisible(false)}>Cancel</Button>
              <Button type="primary" htmlType="submit">
                {editingResident ? 'Update' : 'Create'}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* RFID Registration Modal */}
      <RfidRegistrationModal
        open={rfidModalVisible}
        onClose={() => {
          setRfidModalVisible(false);
          setRfidTargetResident(null);
        }}
        onSuccess={handleRfidRegistrationSuccess}
        targetType="resident"
        targetId={rfidTargetResident?.id}
        targetName={
          rfidTargetResident
            ? `${rfidTargetResident.firstName} ${rfidTargetResident.lastName} (Unit ${rfidTargetResident.unit})`
            : undefined
        }
        tenantId={rfidTargetResident?.tenantId}
      />

      {/* RFID Cards List Modal */}
      <Modal
        title={
          <Space>
            <CreditCardOutlined />
            <span>
              Access Cards - {selectedResidentForCards?.firstName} {selectedResidentForCards?.lastName}
            </span>
          </Space>
        }
        open={cardsModalVisible}
        onCancel={() => {
          setCardsModalVisible(false);
          setSelectedResidentForCards(null);
        }}
        footer={
          <Space>
            <Button onClick={() => {
              setCardsModalVisible(false);
              setSelectedResidentForCards(null);
            }}>
              Close
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                if (selectedResidentForCards) {
                  setRfidTargetResident(selectedResidentForCards);
                  setRfidModalVisible(true);
                }
              }}
            >
              Add New Card
            </Button>
          </Space>
        }
        width={500}
      >
        {selectedResidentForCards?.rfidCards && selectedResidentForCards.rfidCards.length > 0 ? (
          <List
            dataSource={selectedResidentForCards.rfidCards}
            renderItem={(card) => (
              <List.Item
                actions={[
                  <Popconfirm
                    key="delete"
                    title="Delete this card?"
                    description="This action cannot be undone."
                    onConfirm={() => handleDeleteCard(card.id)}
                    okText="Delete"
                    cancelText="Cancel"
                    okButtonProps={{ danger: true }}
                  >
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      loading={deletingCardId === card.id}
                    >
                      Delete
                    </Button>
                  </Popconfirm>
                ]}
              >
                <List.Item.Meta
                  avatar={
                    <div className="w-12 h-8 bg-gradient-to-br from-blue-500 to-blue-700 rounded flex items-center justify-center">
                      <CreditCardOutlined className="text-white" />
                    </div>
                  }
                  title={
                    <Space>
                      <code className="bg-gray-100 px-2 py-1 rounded text-sm font-mono">
                        {card.uid}
                      </code>
                      <Tag color={card.status === 'active' ? 'success' : 'default'}>
                        {card.status}
                      </Tag>
                    </Space>
                  }
                  description={
                    <span className="text-gray-500 text-xs">
                      {card.label || 'Access Card'}
                      {card.createdAt && ` • Added ${new Date(card.createdAt).toLocaleDateString()}`}
                    </span>
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No access cards registered"
          >
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                if (selectedResidentForCards) {
                  setRfidTargetResident(selectedResidentForCards);
                  setRfidModalVisible(true);
                }
              }}
            >
              Register First Card
            </Button>
          </Empty>
        )}
      </Modal>
    </div>
  );
}

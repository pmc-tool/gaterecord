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
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CarOutlined,
  CreditCardOutlined,
} from '@ant-design/icons';
import RfidRegistrationModal from '../../components/RfidRegistrationModal';
import type { ColumnsType } from 'antd/es/table';
import api from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { UserRole } from '../../types';

interface Vehicle {
  id: string;
  licensePlate: string;
  brand?: string;
  model?: string;
  color?: string;
  rfidUid: string;
  status: string;
  ownerId: string;
  tenantId: string;
  owner?: {
    firstName: string;
    lastName: string;
    unit: string;
  };
  tenant?: { name: string };
}

interface Resident {
  id: string;
  firstName: string;
  lastName: string;
  unit: string;
  tenantId: string;
  tenant?: { name: string };
}

export default function VehiclesPage() {
  const { user } = useAuthStore();
  const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [form] = Form.useForm();

  // RFID Registration state
  const [rfidModalVisible, setRfidModalVisible] = useState(false);
  const [rfidTargetVehicle, setRfidTargetVehicle] = useState<Vehicle | null>(null);

  // Filter residents by selected building
  const filteredResidents = selectedTenantId
    ? residents.filter((r) => r.tenantId === selectedTenantId)
    : isSuperAdmin
      ? [] // Super admin must select a building first
      : residents; // Building admin sees their own residents

  const fetchVehicles = async () => {
    setLoading(true);
    try {
      const response = await api.get('/vehicles');
      setVehicles(response.data);
    } catch (error) {
      message.error('Failed to fetch vehicles');
    } finally {
      setLoading(false);
    }
  };

  const fetchResidents = async () => {
    try {
      const response = await api.get('/residents');
      setResidents(response.data);
    } catch (error) {
      console.error('Failed to fetch residents');
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
    fetchVehicles();
    fetchResidents();
    // Only super admin can fetch tenants list
    if (isSuperAdmin) {
      fetchTenants();
    }
  }, [isSuperAdmin]);

  const handleCreate = () => {
    setEditingVehicle(null);
    setSelectedTenantId(null);
    form.resetFields();
    // Clear owner when opening modal
    form.setFieldValue('ownerId', undefined);
    setModalVisible(true);
  };

  const handleEdit = (vehicle: Vehicle) => {
    setEditingVehicle(vehicle);
    setSelectedTenantId(vehicle.tenantId);
    form.setFieldsValue({
      ...vehicle,
      isActive: vehicle.status === 'active',
    });
    setModalVisible(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/vehicles/${id}`);
      message.success('Vehicle deleted successfully');
      fetchVehicles();
    } catch (error) {
      message.error('Failed to delete vehicle');
    }
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    try {
      if (editingVehicle) {
        // Remove tenantId from update payload
        const { tenantId, ...updateValues } = values;
        await api.patch(`/vehicles/${editingVehicle.id}`, updateValues);
        message.success('Vehicle updated successfully');
      } else {
        await api.post('/vehicles', values);
        message.success('Vehicle created successfully');
      }
      setModalVisible(false);
      setSelectedTenantId(null);
      fetchVehicles();
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      message.error(err.response?.data?.message || 'Failed to save vehicle');
    }
  };

  const generateRfidUid = () => {
    const chars = 'ABCDEF0123456789';
    let uid = '';
    for (let i = 0; i < 8; i++) {
      uid += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    form.setFieldValue('rfidUid', uid);
  };

  // RFID Registration handlers
  const handleRegisterRfid = (vehicle: Vehicle) => {
    setRfidTargetVehicle(vehicle);
    setRfidModalVisible(true);
  };

  const handleRfidRegistrationSuccess = (rfidUid: string) => {
    message.success(`RFID card ${rfidUid} registered successfully!`);
    setRfidModalVisible(false);
    setRfidTargetVehicle(null);
    fetchVehicles();
  };

  const columns: ColumnsType<Vehicle> = [
    {
      title: 'Plate Number',
      dataIndex: 'licensePlate',
      key: 'licensePlate',
      render: (plate: string) => (
        <Space>
          <CarOutlined />
          <span className="font-mono font-medium">{plate}</span>
        </Space>
      ),
      sorter: (a, b) => a.licensePlate.localeCompare(b.licensePlate),
    },
    {
      title: 'Vehicle',
      key: 'vehicle',
      render: (_, record) => (
        <span>
          {record.brand || record.model || record.color ? (
            <>
              {record.color && <span className="text-gray-500">{record.color} </span>}
              {record.brand} {record.model}
            </>
          ) : (
            <span className="text-gray-400">-</span>
          )}
        </span>
      ),
    },
    {
      title: 'RFID UID',
      dataIndex: 'rfidUid',
      key: 'rfidUid',
      render: (uid: string, record) => (
        <Space>
          {uid ? (
            <>
              <code className="text-xs bg-gray-100 px-2 py-1 rounded">{uid}</code>
              <Tooltip title="Re-register RFID Card">
                <Button
                  type="text"
                  size="small"
                  icon={<CreditCardOutlined />}
                  onClick={() => handleRegisterRfid(record)}
                />
              </Tooltip>
            </>
          ) : (
            <Tag color="warning">No Card</Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Owner',
      key: 'owner',
      render: (_, record) =>
        record.owner ? (
          <div>
            <div>
              {record.owner.firstName} {record.owner.lastName}
            </div>
            <div className="text-xs text-gray-500">
              Unit {record.owner.unit}{isSuperAdmin && record.tenant ? ` - ${record.tenant.name}` : ''}
            </div>
          </div>
        ) : (
          <span className="text-gray-400">-</span>
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
            title="Delete this vehicle?"
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
        title="Vehicles Management"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchVehicles}>
              Refresh
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              Add Vehicle
            </Button>
          </Space>
        }
      >
        <Table
          columns={columns}
          dataSource={vehicles}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Modal
        title={editingVehicle ? 'Edit Vehicle' : 'Add Vehicle'}
        open={modalVisible}
        onCancel={() => {
          setModalVisible(false);
          setSelectedTenantId(null);
        }}
        footer={null}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            name="licensePlate"
            label="License Plate"
            rules={[{ required: true, message: 'Please enter license plate' }]}
          >
            <Input placeholder="e.g., ABC-1234" />
          </Form.Item>

          <div className="grid grid-cols-3 gap-4">
            <Form.Item name="brand" label="Brand">
              <Input placeholder="e.g., Toyota" />
            </Form.Item>

            <Form.Item name="model" label="Model">
              <Input placeholder="e.g., Camry" />
            </Form.Item>

            <Form.Item name="color" label="Color">
              <Input placeholder="e.g., White" />
            </Form.Item>
          </div>

          <Form.Item
            name="rfidUid"
            label="RFID UID"
            rules={[{ required: true, message: 'Please enter RFID UID' }]}
          >
            <Input
              placeholder="e.g., ABCD1234"
              addonAfter={
                <Button type="link" size="small" onClick={generateRfidUid}>
                  Generate
                </Button>
              }
            />
          </Form.Item>

          {/* Only super admin can select building - building admin's tenant is auto-assigned */}
          {!editingVehicle && isSuperAdmin && (
            <Form.Item
              name="tenantId"
              label="Building"
              rules={[{ required: true, message: 'Please select building' }]}
            >
              <Select
                placeholder="Select building"
                onChange={(value) => {
                  setSelectedTenantId(value);
                  // Clear owner when building changes
                  form.setFieldValue('ownerId', undefined);
                }}
              >
                {tenants.map((tenant) => (
                  <Select.Option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          )}

          <Form.Item
            name="ownerId"
            label="Owner (Resident)"
            rules={[{ required: true, message: 'Please select owner' }]}
          >
            <Select
              placeholder={isSuperAdmin && !selectedTenantId ? 'Select building first' : 'Select resident'}
              showSearch
              optionFilterProp="children"
              disabled={isSuperAdmin && !selectedTenantId && !editingVehicle}
            >
              {filteredResidents.map((resident) => (
                <Select.Option key={resident.id} value={resident.id}>
                  {resident.firstName} {resident.lastName} - Unit {resident.unit}
                </Select.Option>
              ))}
            </Select>
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
                {editingVehicle ? 'Update' : 'Create'}
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
          setRfidTargetVehicle(null);
        }}
        onSuccess={handleRfidRegistrationSuccess}
        targetType="vehicle"
        targetId={rfidTargetVehicle?.id}
        targetName={
          rfidTargetVehicle
            ? `${rfidTargetVehicle.licensePlate} (${rfidTargetVehicle.owner?.firstName} ${rfidTargetVehicle.owner?.lastName})`
            : undefined
        }
        tenantId={rfidTargetVehicle?.tenantId}
      />
    </div>
  );
}

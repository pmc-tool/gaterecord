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
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import api from '../../services/api';

interface Vehicle {
  id: string;
  licensePlate: string;
  make?: string;
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
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [form] = Form.useForm();

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
    fetchTenants();
  }, []);

  const handleCreate = () => {
    setEditingVehicle(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (vehicle: Vehicle) => {
    setEditingVehicle(vehicle);
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
        await api.patch(`/vehicles/${editingVehicle.id}`, values);
        message.success('Vehicle updated successfully');
      } else {
        await api.post('/vehicles', values);
        message.success('Vehicle created successfully');
      }
      setModalVisible(false);
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
          {record.make || record.model || record.color ? (
            <>
              {record.color && <span className="text-gray-500">{record.color} </span>}
              {record.make} {record.model}
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
      render: (uid: string) => (
        <code className="text-xs bg-gray-100 px-2 py-1 rounded">{uid}</code>
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
              Unit {record.owner.unit} - {record.tenant?.name}
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
        onCancel={() => setModalVisible(false)}
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
            <Form.Item name="make" label="Make">
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
            name="ownerId"
            label="Owner (Resident)"
            rules={[{ required: true, message: 'Please select owner' }]}
          >
            <Select placeholder="Select resident" showSearch optionFilterProp="children">
              {residents.map((resident) => (
                <Select.Option key={resident.id} value={resident.id}>
                  {resident.firstName} {resident.lastName} - Unit {resident.unit}
                  {resident.tenant && ` (${resident.tenant.name})`}
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
    </div>
  );
}

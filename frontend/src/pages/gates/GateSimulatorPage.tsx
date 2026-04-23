import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import {
  Row,
  Col,
  Card,
  Select,
  Button,
  Space,
  Typography,
  Tag,
  Input,
  Divider,
  List,
  Badge,
  message,
  Switch,
  Alert,
  Modal,
} from 'antd';
import {
  CarOutlined,
  IdcardOutlined,
  QrcodeOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  UpOutlined,
  DownOutlined,
  StopOutlined,
  WifiOutlined,
  ApiOutlined,
  CameraOutlined,
  CloseOutlined,
  VideoCameraOutlined,
  BankOutlined,
} from '@ant-design/icons';
import { Html5Qrcode } from 'html5-qrcode';
import { useGateStore } from '../../store/gateStore';
import { useAuthStore } from '../../store/authStore';
import { simulatorService, TriggerEventDto } from '../../services/simulator.service';
import { socketService } from '../../services/socket.service';
import { GateState, SimulatorEvent, SimulatorFeedback, SensorHealthStatus } from '../../types';
import api from '../../services/api';

interface Tenant {
  id: string;
  name: string;
  slug: string;
}

const { Title, Text, Paragraph } = Typography;

const stateColors: Record<GateState, string> = {
  [GateState.CLOSED]: 'default',
  [GateState.OPENING]: 'processing',
  [GateState.OPEN]: 'success',
  [GateState.CLOSING]: 'processing',
  [GateState.OBSTACLE_HOLD]: 'warning',
  [GateState.FAULT]: 'error',
  [GateState.MANUAL_OVERRIDE]: 'purple',
};

interface EventLog {
  id: string;
  gateId: string;
  gateName: string;
  timestamp: string | Date;
  method: string;
  subjectType: string;
  subjectId?: string;
  subjectIdentifier?: string;
  subjectName?: string;
  result: string;
  denialReason?: string;
  operatorName?: string;
}

export function GateSimulatorPage() {
  const { gates, fetchGates, selectedGate, fetchGateById, gateHealth, fetchGateHealth, updateGateState } = useGateStore();
  const { user } = useAuthStore();
  const isSuperAdmin = user?.role === 'super_admin';
  
  // Tenant selection state (for Super Admin)
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  
  const [selectedGateId, setSelectedGateId] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [selectedDoor, setSelectedDoor] = useState<number>(0);
  const [rfidUid, setRfidUid] = useState('');
  const [qrToken, setQrToken] = useState('');
  const [eventLogs, setEventLogs] = useState<EventLog[]>([]);
  const [loadingEventLogs, setLoadingEventLogs] = useState(false);
  const [processingCarRfid, setProcessingCarRfid] = useState(false);
  const [processingHumanRfid, setProcessingHumanRfid] = useState(false);
  const [processingVerifyQr, setProcessingVerifyQr] = useState(false);
  const [processingOpenGate, setProcessingOpenGate] = useState(false);
  const [processingCloseGate, setProcessingCloseGate] = useState(false);
  const [processingSimulateOpen, setProcessingSimulateOpen] = useState(false);
  const [processingSimulateClose, setProcessingSimulateClose] = useState(false);

  // Cloud Plus TypeB parameters
  const [serialNumber, setSerialNumber] = useState('');
  const [readerNumber, setReaderNumber] = useState('0');
  const [credentialType, setCredentialType] = useState('12');

  // Camera scanner state
  const [scannerModalOpen, setScannerModalOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const scannerContainerId = 'qr-scanner-container';

  // Filter gates by selected tenant for Super Admin
  const filteredGates = useMemo(() => {
    if (!isSuperAdmin) return gates;
    if (!selectedTenantId) return [];
    return gates.filter((g) => g.tenantId === selectedTenantId);
  }, [gates, selectedTenantId, isSuperAdmin]);

  // Fetch tenants for Super Admin
  const fetchTenants = useCallback(async () => {
    if (!isSuperAdmin) return;
    try {
      const response = await api.get('/admin/tenants');
      setTenants(response.data.data || response.data);
    } catch (error) {
      console.error('Failed to fetch tenants', error);
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    fetchGates();
    if (isSuperAdmin) {
      fetchTenants();
    }
  }, [isSuperAdmin, fetchTenants]);

  // Reset gate selection when tenant changes
  useEffect(() => {
    if (isSuperAdmin) {
      setSelectedGateId(null);
      setSelectedDeviceId(null);
      setSelectedDoor(0);
    }
  }, [selectedTenantId, isSuperAdmin]);

  useEffect(() => {
    if (selectedGateId) {
      // Reset device and door selection when gate changes
      setSelectedDeviceId(null);
      setSelectedDoor(0);
      
      fetchGateById(selectedGateId);
      fetchGateHealth(selectedGateId);
      socketService.joinGate(selectedGateId);

      // Listen for state changes
      const unsubStateChange = socketService.on<{ gateId: string; newState: GateState }>(
        'gate:state-change',
        (data) => {
          if (data.gateId === selectedGateId) {
            updateGateState(data.gateId, data.newState);
          }
        }
      );

      // Listen for simulator feedback
      const unsubFeedback = socketService.on<SimulatorFeedback>(
        'simulator:feedback',
        (data) => {
          if (data.gateId === selectedGateId) {
            // Refresh event logs after simulator feedback
            addEventLog();
          }
        }
      );

      return () => {
        socketService.leaveGate(selectedGateId);
        unsubStateChange();
        unsubFeedback();
      };
    }
  }, [selectedGateId]);

  // Fetch latest 10 event logs from database
  useEffect(() => {
    const fetchEventLogs = async () => {
      if (!selectedGateId) {
        setEventLogs([]);
        return;
      }

      setLoadingEventLogs(true);
      try {
        const response = await api.get('/events/live', {
          params: {
            gateId: selectedGateId,
            limit: 10,
          },
        });
        const events = response.data.data || response.data;
        setEventLogs(Array.isArray(events) ? events : []);
      } catch (error) {
        console.error('Failed to fetch event logs:', error);
        setEventLogs([]);
      } finally {
        setLoadingEventLogs(false);
      }
    };

    fetchEventLogs();
  }, [selectedGateId]);

  // Cleanup scanner on unmount
  useEffect(() => {
    return () => {
      if (scannerRef.current && isScanning) {
        scannerRef.current.stop().catch(() => {});
      }
    };
  }, [isScanning]);

  const addEventLog = async () => {
    // Refresh event logs from database after an action
    if (!selectedGateId) return;
    
    try {
      const response = await api.get('/events/live', {
        params: {
          gateId: selectedGateId,
          limit: 10,
        },
      });
      const events = response.data.data || response.data;
      setEventLogs(Array.isArray(events) ? events : []);
    } catch (error) {
      console.error('Failed to refresh event logs:', error);
    }
  };

  const triggerEvent = async (event: SimulatorEvent, data?: Partial<TriggerEventDto>) => {
    if (!selectedGateId) {
      message.error('Please select a gate first');
      return;
    }

    try {
      const result = await simulatorService.triggerEvent(selectedGateId, {
        event,
        ...data,
      });
      await addEventLog();
      updateGateState(selectedGateId, result.gateState);

      if (result.success) {
        message.success(result.message);
      } else {
        message.warning(result.message);
      }
    } catch (error) {
      message.error('Failed to trigger event');
    }
  };

  const triggerEventWithLoading = async (
    event: SimulatorEvent,
    setLoading: React.Dispatch<React.SetStateAction<boolean>>,
    data?: Partial<TriggerEventDto>
  ) => {
    if (!selectedGateId) {
      message.error('Please select a gate first');
      return;
    }

    setLoading(true);
    try {
      const result = await simulatorService.triggerEvent(selectedGateId, {
        event,
        ...data,
      });
      await addEventLog();
      updateGateState(selectedGateId, result.gateState);

      if (result.success) {
        message.success(result.message);
      } else {
        message.warning(result.message);
      }
    } catch (error) {
      message.error('Failed to trigger event');
    } finally {
      setLoading(false);
    }
  };

  const handleCarRfid = () => {
    if (!rfidUid.trim()) {
      message.error('Please enter RFID UID');
      return;
    }
    triggerEventWithLoading(SimulatorEvent.CAR_RFID_DETECTED, setProcessingCarRfid, {
      rfidUid: rfidUid.trim(),
      Serial: serialNumber || undefined,
      Reader: readerNumber || undefined,
      type: credentialType || undefined,
    });
  };

  const handleHumanRfid = () => {
    if (!rfidUid.trim()) {
      message.error('Please enter RFID UID');
      return;
    }
    triggerEventWithLoading(SimulatorEvent.HUMAN_RFID_DETECTED, setProcessingHumanRfid, {
      rfidUid: rfidUid.trim(),
      Serial: serialNumber || undefined,
      Reader: readerNumber || undefined,
      type: credentialType || undefined,
    });
  };

  const handleQrVerify = (token?: string) => {
    const tokenToUse = token || qrToken.trim();
    if (!tokenToUse) {
      message.error('Please enter QR Token');
      return;
    }
    triggerEventWithLoading(SimulatorEvent.QR_VERIFIED, setProcessingVerifyQr, {
      qrToken: tokenToUse,
      Serial: serialNumber || undefined,
      Reader: readerNumber || undefined,
      type: '16', // QR type
    });
  };

  // Send real command to hardware via TCP
  const sendHardwareCommand = async (action: 'OPEN' | 'CLOSE' | 'STOP', setLoading: React.Dispatch<React.SetStateAction<boolean>>) => {
    if (!selectedGateId) {
      message.error('Please select a gate first');
      return;
    }

    if (!selectedDeviceId) {
      message.error('Please select a device first');
      return;
    }

    setLoading(true);
    try {
      // Map action to TCP endpoint action
      const tcpAction = action === 'OPEN' ? 'open' : action === 'CLOSE' ? 'close' : 'close';
      const response = await api.post(`/gates/${selectedGateId}/tcp/control`, { 
        action: tcpAction,
        deviceId: selectedDeviceId,
        door: selectedDoor,
      });
      if (response.data.success) {
        message.success(response.data.message);
        await addEventLog();
      } else {
        message.warning(response.data.message);
        await addEventLog();
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || 'Failed to send hardware command';
      message.error(errorMsg);
      await addEventLog();
    } finally {
      setLoading(false);
    }
  };

  const toggleOnlineStatus = async (online: boolean) => {
    if (!selectedGateId) return;
    try {
      await simulatorService.setOnlineStatus(selectedGateId, online);
      fetchGateById(selectedGateId);
      message.success(`Gate ${online ? 'online' : 'offline'}`);
    } catch {
      message.error('Failed to update status');
    }
  };

  // Extract QR token from URL or raw token
  const extractQrToken = (scannedData: string): string => {
    // Check if it's a URL containing the visitor pass path
    const visitorPassMatch = scannedData.match(/\/visitor-pass\/([a-f0-9-]+)/i);
    if (visitorPassMatch) {
      return visitorPassMatch[1];
    }
    // Otherwise return as-is (might be a raw UUID token)
    return scannedData;
  };

  const startScanner = async () => {
    if (!selectedGateId) {
      message.error('Please select a gate first');
      return;
    }

    setScannerModalOpen(true);

    // Wait for modal to render
    setTimeout(async () => {
      try {
        scannerRef.current = new Html5Qrcode(scannerContainerId);

        await scannerRef.current.start(
          { facingMode: 'environment' }, // Use back camera
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
          },
          async (decodedText) => {
            // QR code detected
            const token = extractQrToken(decodedText);
            message.info(`QR Code detected: ${token.substring(0, 20)}...`);

            // Stop scanner
            await stopScanner();

            // Set token and verify
            setQrToken(token);
            handleQrVerify(token);
          },
          () => {
            // QR code not detected (ignore)
          }
        );

        setIsScanning(true);
      } catch (err) {
        console.error('Failed to start scanner:', err);
        message.error('Failed to access camera. Please check permissions.');
        setScannerModalOpen(false);
      }
    }, 100);
  };

  const stopScanner = async () => {
    if (scannerRef.current && isScanning) {
      try {
        await scannerRef.current.stop();
        scannerRef.current = null;
      } catch (err) {
        console.error('Error stopping scanner:', err);
      }
    }
    setIsScanning(false);
    setScannerModalOpen(false);
  };

  return (
    <div>
       {/* Headline */}
      <div className="flex justify-between items-center">
        <Title level={3}>Gate Simulator</Title>
      </div>

      <Paragraph type="secondary">
        Test gate operations without physical hardware. Select a gate and simulate various events.
      </Paragraph>

      <Row gutter={[16, 16]}>
        {/* Gate Selection and Status */}
        <Col xs={24} lg={8}>
          <Card title="Gate Selection" className="mb-4">
            <Space direction="vertical" className="w-full" size="middle">
              {/* Tenant/Building Selection for Super Admin */}
              {isSuperAdmin && (
                <div>
                  <Text type="secondary" className="text-xs mb-1 block">
                    <BankOutlined className="mr-1" />
                    Select Building
                  </Text>
                  <Select
                    placeholder="Select a building"
                    value={selectedTenantId}
                    onChange={setSelectedTenantId}
                    className="w-full"
                    showSearch
                    optionFilterProp="label"
                    options={tenants.map((t) => ({
                      value: t.id,
                      label: t.name,
                    }))}
                  />
                </div>
              )}
              
              {/* Gate Selection */}
              <div>
                {isSuperAdmin && (
                  <Text type="secondary" className="text-xs mb-1 block">
                    Select Gate
                  </Text>
                )}
                <Select
                  placeholder={isSuperAdmin && !selectedTenantId ? "Select building first" : "Select a gate"}
                  value={selectedGateId}
                  onChange={setSelectedGateId}
                  className="w-full"
                  disabled={isSuperAdmin && !selectedTenantId}
                  notFoundContent={
                    isSuperAdmin && selectedTenantId && filteredGates.length === 0 
                      ? "No gates found for this building" 
                      : "No gates found"
                  }
                  options={filteredGates.map((g) => ({
                    value: g.id,
                    label: `${g.name} (${g.type})`,
                  }))}
                />
              </div>
            </Space>
          </Card>

          {selectedGate && (
            <>
              <Card title="Gate Status" className="mb-4">
                <Space direction="vertical" className="w-full">
                  <div className="flex justify-between items-center">
                    <Text>Name:</Text>
                    <Text strong>{selectedGate.name}</Text>
                  </div>
                  <div className="flex justify-between items-center">
                    <Text>Type:</Text>
                    <Tag>{selectedGate.type.toUpperCase()}</Tag>
                  </div>
                  <div className="flex justify-between items-center">
                    <Text>State:</Text>
                    <Tag color={stateColors[selectedGate.state]} className="text-lg px-4 py-1">
                      {selectedGate.state}
                    </Tag>
                  </div>
                  {/* <Divider className="my-2" />
                  <div className="flex justify-between items-center">
                    <Text>Online Status:</Text>
                    <Switch
                      checked={selectedGate.isOnline}
                      onChange={toggleOnlineStatus}
                      checkedChildren={<WifiOutlined />}
                      unCheckedChildren={<ApiOutlined />}
                    />
                  </div> */}
                </Space>
              </Card>

              {/* <Card title="Sensor Health" size="small">
                {gateHealth?.sensors?.map((sensor) => (
                  <div key={sensor.sensorType} className="flex justify-between items-center py-1">
                    <Text className="text-xs">{sensor.sensorType.replace(/_/g, ' ')}</Text>
                    <Badge
                      status={
                        sensor.status === SensorHealthStatus.OK
                          ? 'success'
                          : sensor.status === SensorHealthStatus.UNKNOWN
                          ? 'default'
                          : 'error'
                      }
                      text={sensor.status}
                    />
                  </div>
                ))}
              </Card> */}
            </>
          )}
        </Col>

        {/* Simulator Controls */}
        <Col xs={24} lg={8}>
          <Card title="Access Methods" className="mb-4">
            <Space direction="vertical" className="w-full">
              <Input
                placeholder="RFID UID (e.g., VH-A1B2C3D4 or RF-JD-001)"
                value={rfidUid}
                onChange={(e) => setRfidUid(e.target.value)}
                addonBefore={<IdcardOutlined />}
              />

              {/* Cloud Plus TypeB Parameters */}
              <div className="grid grid-cols-3 gap-2">
                <Input
                  placeholder="Serial Number"
                  value={serialNumber}
                  onChange={(e) => setSerialNumber(e.target.value)}
                  size="small"
                />
                <Select
                  placeholder="Reader"
                  value={readerNumber}
                  onChange={setReaderNumber}
                  size="small"
                  options={[
                    { value: '0', label: 'Reader 0' },
                    { value: '1', label: 'Reader 1' },
                  ]}
                />
                <Select
                  placeholder="Type"
                  value={credentialType}
                  onChange={setCredentialType}
                  size="small"
                  options={[
                    { value: '12', label: 'RFID (12)' },
                    { value: '16', label: 'QR (16)' },
                    { value: '4', label: 'Button (4)' },
                  ]}
                />
              </div>

              <Space className="w-full">
                <Button
                  icon={<CarOutlined />}
                  onClick={handleCarRfid}
                  loading={processingCarRfid}
                  disabled={!selectedGateId}
                >
                  Car RFID
                </Button>
                <Button
                  icon={<IdcardOutlined />}
                  onClick={handleHumanRfid}
                  loading={processingHumanRfid}
                  disabled={!selectedGateId}
                >
                  Human RFID
                </Button>
              </Space>

              <Divider className="my-2" />

              <Input
                placeholder="QR Token (or scan with camera)"
                value={qrToken}
                onChange={(e) => setQrToken(e.target.value)}
                addonBefore={<QrcodeOutlined />}
              />
              <Space className="w-full" style={{ display: 'flex' }}>
                <Button
                  icon={<QrcodeOutlined />}
                  onClick={() => handleQrVerify()}
                  loading={processingVerifyQr}
                  disabled={!selectedGateId}
                  style={{ flex: 1 }}
                >
                  Verify QR
                </Button>
                <Button
                  type="primary"
                  icon={<CameraOutlined />}
                  onClick={startScanner}
                  disabled={!selectedGateId}
                  style={{ flex: 1 }}
                >
                  Scan QR
                </Button>
              </Space>
            </Space>
          </Card>

          <Card title="Manual Controls" className="mb-4">
            <Space direction="vertical" className="w-full">
              {/* Real Hardware Control - show if gate has devices */}
              {selectedGate?.devices && selectedGate.devices.length > 0 && (
                <>
                  <Text strong className="text-green-600">Hardware Control (Real Device)</Text>
                  
                  {/* Device Selection */}
                  <Select
                    placeholder="Select device to control"
                    value={selectedDeviceId}
                    onChange={(value) => {
                      setSelectedDeviceId(value);
                      setSelectedDoor(0); // Reset door when device changes
                    }}
                    className="w-full"
                    options={selectedGate.devices.map((device) => ({
                      value: device.deviceId,
                      label: (
                        <span>
                          {device.deviceName || device.deviceId}
                          <Tag 
                            color={device.status === 'online' ? 'success' : 'default'} 
                            className="ml-2"
                          >
                            {device.status}
                          </Tag>
                        </span>
                      ),
                    }))}
                  />
                  
                  {/* Door Selection - Cloud Plus TypeB supports 2 doors */}
                  {selectedDeviceId && (
                    <Select
                      placeholder="Select door"
                      value={selectedDoor}
                      onChange={setSelectedDoor}
                      className="w-full"
                      options={[
                        { value: 0, label: 'Door 0 (Entry/Exit 1)' },
                        { value: 1, label: 'Door 1 (Entry/Exit 2)' },
                      ]}
                    />
                  )}
                  
                  <Space className="w-full justify-center">
                    <Button
                      type="primary"
                      icon={<UpOutlined />}
                      onClick={() => sendHardwareCommand('OPEN', setProcessingOpenGate)}
                      loading={processingOpenGate}
                      disabled={!selectedGateId || !selectedDeviceId}
                      size="large"
                      style={{ backgroundColor: '#52c41a', borderColor: '#52c41a' }}
                    >
                      Open Gate
                    </Button>
                    <Button
                      danger
                      icon={<DownOutlined />}
                      onClick={() => sendHardwareCommand('CLOSE', setProcessingCloseGate)}
                      loading={processingCloseGate}
                      disabled={!selectedGateId || !selectedDeviceId}
                      size="large"
                    >
                      Close Gate
                    </Button>
                  </Space>
                  <Divider className="my-2" />
                  <Text type="secondary" className="text-xs">Simulation (Software Only)</Text>
                </>
              )}
              <Space className="w-full justify-center">
                <Button
                  type="primary"
                  icon={<UpOutlined />}
                  onClick={() => triggerEventWithLoading(SimulatorEvent.MANUAL_OPEN, setProcessingSimulateOpen)}
                  loading={processingSimulateOpen}
                  disabled={!selectedGateId}
                  size="large"
                >
                  {selectedGate?.devices && selectedGate.devices.length > 0 ? 'Simulate Open' : 'Manual Open'}
                </Button>
                <Button
                  danger
                  icon={<DownOutlined />}
                  onClick={() => triggerEventWithLoading(SimulatorEvent.MANUAL_CLOSE, setProcessingSimulateClose)}
                  loading={processingSimulateClose}
                  disabled={!selectedGateId}
                  size="large"
                >
                  {selectedGate?.devices && selectedGate.devices.length > 0 ? 'Simulate Close' : 'Manual Close'}
                </Button>
              </Space>
            </Space>
          </Card>

          <Card title="Sensor Simulation" size="small">
            <Space direction="vertical" className="w-full">
              <Space className="w-full">
                <Button
                  icon={<WarningOutlined />}
                  onClick={() => triggerEvent(SimulatorEvent.OBSTACLE_DETECTED)}
                  disabled={!selectedGateId}
                  size="small"
                >
                  Obstacle Detected
                </Button>
                <Button
                  icon={<CheckCircleOutlined />}
                  onClick={() => triggerEvent(SimulatorEvent.OBSTACLE_CLEARED)}
                  disabled={!selectedGateId}
                  size="small"
                >
                  Obstacle Cleared
                </Button>
              </Space>
              <Space className="w-full">
                <Button
                  icon={<StopOutlined />}
                  onClick={() => triggerEvent(SimulatorEvent.LIMIT_OPEN_REACHED)}
                  disabled={!selectedGateId}
                  size="small"
                >
                  Limit Open
                </Button>
                <Button
                  icon={<StopOutlined />}
                  onClick={() => triggerEvent(SimulatorEvent.LIMIT_CLOSE_REACHED)}
                  disabled={!selectedGateId}
                  size="small"
                >
                  Limit Close
                </Button>
              </Space>
            </Space>
          </Card>
        </Col>

        {/* Event Log */}
        <Col xs={24} lg={8}>
          <Card
            title="Event Log"
            className="h-full"
          >
            <List
              dataSource={eventLogs}
              loading={loadingEventLogs}
              renderItem={(item) => (
                <List.Item className="py-1">
                  <div className="w-full">
                    <div className="flex justify-between">
                      <Tag color={item.result === 'ALLOWED' ? 'success' : 'error'}>
                        {item.method.replace(/_/g, ' ')}
                      </Tag>
                      <Text type="secondary" className="text-xs">
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </Text>
                    </div>
                    <div className="mt-2">
                      <Text className="text-sm">
                        <strong>{item.subjectName || item.subjectIdentifier || 'Unknown'}</strong>
                      </Text>
                      <div className="text-xs text-gray-600 mt-1">
                        {item.subjectType} • {item.result}
                      </div>
                      {item.denialReason && (
                        <div className="text-xs text-red-600 mt-1">
                          Reason: {item.denialReason}
                        </div>
                      )}
                    </div>
                  </div>
                </List.Item>
              )}
              locale={{ emptyText: 'No events found' }}
              className="max-h-96 overflow-auto"
            />
          </Card>
        </Col>
      </Row>

      <Alert
        message="Simulation Mode - Sample RFID UIDs"
        description={
          <div>
            <div><strong>Vehicle RFIDs:</strong> VH-A1B2C3D4, VH-E5F6G7H8, VH-I9J0K1L2, VH-M3N4O5P6, VH-Q7R8S9T0</div>
            <div><strong>Human Card RFIDs:</strong> RF-JD-001, RF-JS-002, RF-MJ-003, RF-SW-004, RF-DB-005</div>
            <div className="mt-2"><strong>QR Scanner:</strong> Click "Scan QR" button to use camera for scanning visitor pass QR codes</div>
          </div>
        }
        type="info"
        showIcon
        className="mt-4"
      />

      {/* Camera Scanner Modal */}
      <Modal
        title={
          <Space>
            <VideoCameraOutlined />
            <span>QR Code Scanner</span>
          </Space>
        }
        open={scannerModalOpen}
        onCancel={stopScanner}
        footer={[
          <Button key="close" icon={<CloseOutlined />} onClick={stopScanner}>
            Close Scanner
          </Button>,
        ]}
        width={400}
        centered
        destroyOnClose
      >
        <div className="text-center">
          <div
            id={scannerContainerId}
            style={{
              width: '100%',
              minHeight: 300,
              background: '#000',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          />
          <div className="mt-4">
            <Text type="secondary">
              Point your camera at a visitor pass QR code
            </Text>
          </div>
          {isScanning && (
            <div className="mt-2">
              <Badge status="processing" text="Scanning..." />
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

export default GateSimulatorPage;

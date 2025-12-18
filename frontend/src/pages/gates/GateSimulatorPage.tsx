import { useEffect, useState } from 'react';
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
} from '@ant-design/icons';
import { useGateStore } from '../../store/gateStore';
import { simulatorService, TriggerEventDto } from '../../services/simulator.service';
import { socketService } from '../../services/socket.service';
import { GateState, SimulatorEvent, SimulatorFeedback, SensorHealthStatus } from '../../types';

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
  timestamp: Date;
  action: string;
  success: boolean;
  message: string;
}

export function GateSimulatorPage() {
  const { gates, fetchGates, selectedGate, fetchGateById, gateHealth, fetchGateHealth, updateGateState } = useGateStore();
  const [selectedGateId, setSelectedGateId] = useState<string | null>(null);
  const [rfidUid, setRfidUid] = useState('');
  const [qrToken, setQrToken] = useState('');
  const [eventLogs, setEventLogs] = useState<EventLog[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    fetchGates();
  }, []);

  useEffect(() => {
    if (selectedGateId) {
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
            addEventLog(data);
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

  const addEventLog = (feedback: SimulatorFeedback) => {
    setEventLogs((prev) => [
      {
        id: feedback.eventId || Date.now().toString(),
        timestamp: new Date(),
        action: feedback.action,
        success: feedback.success,
        message: feedback.message,
      },
      ...prev.slice(0, 49),
    ]);
  };

  const triggerEvent = async (event: SimulatorEvent, data?: Partial<TriggerEventDto>) => {
    if (!selectedGateId) {
      message.error('Please select a gate first');
      return;
    }

    setIsProcessing(true);
    try {
      const result = await simulatorService.triggerEvent(selectedGateId, {
        event,
        ...data,
      });
      addEventLog(result);
      updateGateState(selectedGateId, result.gateState);

      if (result.success) {
        message.success(result.message);
      } else {
        message.warning(result.message);
      }
    } catch (error) {
      message.error('Failed to trigger event');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCarRfid = () => {
    if (!rfidUid.trim()) {
      message.error('Please enter RFID UID');
      return;
    }
    triggerEvent(SimulatorEvent.CAR_RFID_DETECTED, { rfidUid: rfidUid.trim() });
  };

  const handleHumanRfid = () => {
    if (!rfidUid.trim()) {
      message.error('Please enter RFID UID');
      return;
    }
    triggerEvent(SimulatorEvent.HUMAN_RFID_DETECTED, { rfidUid: rfidUid.trim() });
  };

  const handleQrVerify = () => {
    if (!qrToken.trim()) {
      message.error('Please enter QR Token');
      return;
    }
    triggerEvent(SimulatorEvent.QR_VERIFIED, { qrToken: qrToken.trim() });
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

  return (
    <div>
      <Title level={4}>Gate Simulator</Title>
      <Paragraph type="secondary">
        Test gate operations without physical hardware. Select a gate and simulate various events.
      </Paragraph>

      <Row gutter={[16, 16]}>
        {/* Gate Selection and Status */}
        <Col xs={24} lg={8}>
          <Card title="Gate Selection" className="mb-4">
            <Select
              placeholder="Select a gate"
              value={selectedGateId}
              onChange={setSelectedGateId}
              className="w-full"
              options={gates.map((g) => ({
                value: g.id,
                label: `${g.name} (${g.type})`,
              }))}
            />
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
                  <Divider className="my-2" />
                  <div className="flex justify-between items-center">
                    <Text>Online Status:</Text>
                    <Switch
                      checked={selectedGate.isOnline}
                      onChange={toggleOnlineStatus}
                      checkedChildren={<WifiOutlined />}
                      unCheckedChildren={<ApiOutlined />}
                    />
                  </div>
                </Space>
              </Card>

              <Card title="Sensor Health" size="small">
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
              </Card>
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
              <Space className="w-full">
                <Button
                  icon={<CarOutlined />}
                  onClick={handleCarRfid}
                  loading={isProcessing}
                  disabled={!selectedGateId}
                >
                  Car RFID
                </Button>
                <Button
                  icon={<IdcardOutlined />}
                  onClick={handleHumanRfid}
                  loading={isProcessing}
                  disabled={!selectedGateId}
                >
                  Human RFID
                </Button>
              </Space>

              <Divider className="my-2" />

              <Input
                placeholder="QR Token"
                value={qrToken}
                onChange={(e) => setQrToken(e.target.value)}
                addonBefore={<QrcodeOutlined />}
              />
              <Button
                icon={<QrcodeOutlined />}
                onClick={handleQrVerify}
                loading={isProcessing}
                disabled={!selectedGateId}
                block
              >
                Verify QR Pass
              </Button>
            </Space>
          </Card>

          <Card title="Manual Controls" className="mb-4">
            <Space direction="vertical" className="w-full">
              <Space className="w-full justify-center">
                <Button
                  type="primary"
                  icon={<UpOutlined />}
                  onClick={() => triggerEvent(SimulatorEvent.MANUAL_OPEN)}
                  loading={isProcessing}
                  disabled={!selectedGateId}
                  size="large"
                >
                  Manual Open
                </Button>
                <Button
                  danger
                  icon={<DownOutlined />}
                  onClick={() => triggerEvent(SimulatorEvent.MANUAL_CLOSE)}
                  loading={isProcessing}
                  disabled={!selectedGateId}
                  size="large"
                >
                  Manual Close
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
            extra={
              <Button size="small" onClick={() => setEventLogs([])}>
                Clear
              </Button>
            }
          >
            <List
              dataSource={eventLogs}
              renderItem={(item) => (
                <List.Item className="py-1">
                  <div className="w-full">
                    <div className="flex justify-between">
                      <Tag color={item.success ? 'success' : 'error'}>
                        {item.action.replace(/_/g, ' ')}
                      </Tag>
                      <Text type="secondary" className="text-xs">
                        {item.timestamp.toLocaleTimeString()}
                      </Text>
                    </div>
                    <Text className="text-sm">{item.message}</Text>
                  </div>
                </List.Item>
              )}
              locale={{ emptyText: 'No events yet' }}
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
          </div>
        }
        type="info"
        showIcon
        className="mt-4"
      />
    </div>
  );
}

export default GateSimulatorPage;

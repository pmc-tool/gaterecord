import { useState, useEffect, useRef } from 'react';
import { Modal, Button, message, Result } from 'antd';
import { CheckCircleOutlined, LoadingOutlined, CreditCardOutlined } from '@ant-design/icons';
import { socketService } from '../services/socket.service';
import api from '../services/api';

interface RfidRegistrationModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (rfidUid: string) => void;
  targetType: 'vehicle' | 'resident';
  targetId?: string;
  targetName?: string;
  tenantId?: string;
}

type RegistrationState = 'waiting' | 'success' | 'error';

interface RfidScanEvent {
  rfidUid: string;
  type: 'vehicle' | 'human';
  sessionId: string;
  tenantId: string;
}

export default function RfidRegistrationModal({
  open,
  onClose,
  onSuccess,
  targetType,
  targetId,
  targetName,
  tenantId,
}: RfidRegistrationModalProps) {
  const [state, setState] = useState<RegistrationState>('waiting');
  const [scannedUid, setScannedUid] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Keep ref in sync with state for cleanup
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Start registration session when modal opens
  useEffect(() => {
    if (!open) return;

    // Debug logging
    console.log('=== RFID Registration Modal Opened ===');
    console.log('Target Type:', targetType);
    console.log('Target ID:', targetId);
    console.log('Tenant ID:', tenantId);

    if (!tenantId || !targetId) {
      console.error('Missing tenantId or targetId!');
      message.error('Missing required data for RFID registration');
      return;
    }

    const startSession = async () => {
      try {
        // Join tenant room to receive registration events
        console.log('Joining tenant room:', tenantId);
        socketService.joinTenant(tenantId);

        console.log('Calling API to start registration session...');
        const response = await api.post('/rfid/registration/start', {
          targetType,
          targetId,
          tenantId,
        });
        console.log('Registration session started:', response.data);
        setSessionId(response.data.sessionId);
        message.success('Ready to scan RFID card');
      } catch (error: unknown) {
        console.error('Failed to start registration session:', error);
        const err = error as { response?: { data?: { message?: string }; status?: number } };
        message.error(err.response?.data?.message || 'Failed to start RFID registration');
      }
    };

    setState('waiting');
    setScannedUid(null);
    startSession();

    // Cleanup when modal closes
    return () => {
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        console.log('Cancelling registration session:', currentSessionId);
        api.post('/rfid/registration/cancel', { sessionId: currentSessionId }).catch(() => {});
      }
      setSessionId(null);
    };
  }, [open, tenantId, targetId, targetType]);

  // Listen for RFID scan events
  useEffect(() => {
    if (!open || !sessionId) return;

    console.log('=== RFID Modal: Setting up event listener ===');
    console.log('Current sessionId:', sessionId);
    console.log('Socket connected:', socketService.isConnected());

    const unsubscribe = socketService.on<RfidScanEvent>('rfid:registration-scan', (data) => {
      console.log('=== RFID Modal: Received scan event ===', data);
      console.log('Expected sessionId:', sessionId);
      console.log('Received sessionId:', data.sessionId);
      console.log('Match:', data.sessionId === sessionId);

      if (data.sessionId === sessionId) {
        console.log('=== RFID Modal: Session ID matched! Setting success state ===');
        setScannedUid(data.rfidUid);
        setState('success');

        // Auto-close after delay and call success callback
        setTimeout(() => {
          onSuccess(data.rfidUid);
        }, 1500);
      }
    });

    return () => {
      console.log('=== RFID Modal: Cleaning up event listener ===');
      unsubscribe();
    };
  }, [open, sessionId, onSuccess]);

  const handleCancel = () => {
    // Cleanup will be handled by useEffect
    onClose();
  };

  const renderContent = () => {
    if (state === 'success') {
      return (
        <Result
          icon={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
          title="Card Registered Successfully!"
          subTitle={
            <div>
              <p>RFID UID: <code className="bg-gray-100 px-2 py-1 rounded font-mono">{scannedUid}</code></p>
              {targetName && <p>Assigned to: {targetName}</p>}
            </div>
          }
        />
      );
    }

    return (
      <div className="flex flex-col items-center py-8">
        {/* RFID Card Animation */}
        <div className="relative mb-8">
          {/* Reader base */}
          <div className="w-48 h-32 bg-gradient-to-b from-gray-700 to-gray-800 rounded-lg shadow-xl flex items-center justify-center relative overflow-hidden">
            {/* Scanning waves */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="rfid-wave"></div>
              <div className="rfid-wave" style={{ animationDelay: '0.5s' }}></div>
              <div className="rfid-wave" style={{ animationDelay: '1s' }}></div>
            </div>

            {/* Reader icon */}
            <CreditCardOutlined className="text-4xl text-blue-400 z-10" />

            {/* LED indicator */}
            <div className="absolute top-3 right-3 w-3 h-3 rounded-full bg-green-500 animate-pulse"></div>
          </div>

          {/* Animated card */}
          <div className="absolute -top-4 left-1/2 transform -translate-x-1/2 animate-bounce">
            <div className="w-16 h-10 bg-gradient-to-br from-blue-500 to-blue-700 rounded shadow-lg flex items-center justify-center">
              <div className="w-8 h-1 bg-yellow-400 rounded"></div>
            </div>
          </div>
        </div>

        {/* Instructions */}
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 text-lg font-medium text-gray-700 mb-2">
            <LoadingOutlined spin />
            <span>Waiting for card...</span>
          </div>
          <p className="text-gray-500">
            Please place the RFID card on the reader
          </p>
          {targetName && (
            <p className="text-sm text-gray-400 mt-2">
              Registering for: <strong>{targetName}</strong>
            </p>
          )}
        </div>

        {/* CSS for animations */}
        <style>{`
          .rfid-wave {
            position: absolute;
            width: 60px;
            height: 60px;
            border: 2px solid rgba(59, 130, 246, 0.5);
            border-radius: 50%;
            animation: rfid-pulse 2s ease-out infinite;
          }

          @keyframes rfid-pulse {
            0% {
              transform: scale(0.5);
              opacity: 1;
            }
            100% {
              transform: scale(2);
              opacity: 0;
            }
          }
        `}</style>
      </div>
    );
  };

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <CreditCardOutlined />
          <span>Register RFID Card</span>
        </div>
      }
      open={open}
      onCancel={handleCancel}
      footer={
        state === 'waiting' ? (
          <Button onClick={handleCancel}>Cancel</Button>
        ) : null
      }
      width={500}
      centered
      maskClosable={false}
    >
      {renderContent()}
    </Modal>
  );
}

import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Spin, Tag, Typography, Alert, Divider } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  UserOutlined,
  HomeOutlined,
  CalendarOutlined,
  EnvironmentOutlined,
} from '@ant-design/icons';
import { QRCodeSVG } from 'qrcode.react';
import dayjs from 'dayjs';
import axios from 'axios';

const { Title, Text } = Typography;

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

interface VisitorPassPublic {
  visitorName: string;
  hostName: string;
  hostUnit?: string;
  buildingName: string;
  buildingAddress?: string;
  validFrom: string;
  validUntil: string;
  status: string;
  qrToken: string;
  purpose?: string;
  usesRemaining: number;
}

const statusConfig: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  active: {
    color: 'success',
    icon: <CheckCircleOutlined />,
    label: 'Active',
  },
  pending: {
    color: 'warning',
    icon: <ClockCircleOutlined />,
    label: 'Pending',
  },
  used: {
    color: 'default',
    icon: <CheckCircleOutlined />,
    label: 'Used',
  },
  expired: {
    color: 'default',
    icon: <CloseCircleOutlined />,
    label: 'Expired',
  },
  cancelled: {
    color: 'error',
    icon: <CloseCircleOutlined />,
    label: 'Cancelled',
  },
};

export default function VisitorPassPage() {
  const { qrToken } = useParams<{ qrToken: string }>();
  const [pass, setPass] = useState<VisitorPassPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPass = async () => {
      if (!qrToken) return;

      try {
        const passRes = await axios.get(`${API_URL}/visitor-passes/public/${qrToken}`);
        setPass(passRes.data);
      } catch (err) {
        setError('Visitor pass not found or has been removed.');
      } finally {
        setLoading(false);
      }
    };

    fetchPass();
  }, [qrToken]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
        <Spin size="large" />
      </div>
    );
  }

  if (error || !pass) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <Card className="max-w-md w-full shadow-xl">
          <Alert
            message="Pass Not Found"
            description={error || 'This visitor pass could not be found.'}
            type="error"
            showIcon
          />
        </Card>
      </div>
    );
  }

  const isValid = pass.status === 'active' || pass.status === 'pending';
  const isExpired = new Date(pass.validUntil) < new Date();
  const notYetValid = new Date(pass.validFrom) > new Date();
  const statusInfo = statusConfig[pass.status] || statusConfig.expired;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 flex items-center justify-center">
      <Card className="max-w-md w-full shadow-xl">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <UserOutlined className="text-white text-2xl" />
          </div>
          <Title level={3} className="mb-1">Visitor Pass</Title>
          <Text type="secondary">{pass.buildingName}</Text>
        </div>

        {/* Status Badge */}
        <div className="text-center mb-6">
          <Tag
            color={statusInfo.color}
            icon={statusInfo.icon}
            className="text-lg px-4 py-1"
          >
            {statusInfo.label}
          </Tag>
        </div>

        {/* Warning for invalid passes */}
        {!isValid && (
          <Alert
            message={`This pass is ${pass.status}`}
            description="This visitor pass can no longer be used for entry."
            type="warning"
            showIcon
            className="mb-4"
          />
        )}

        {isExpired && isValid && (
          <Alert
            message="Pass Expired"
            description="This visitor pass has expired and can no longer be used."
            type="error"
            showIcon
            className="mb-4"
          />
        )}

        {notYetValid && isValid && (
          <Alert
            message="Not Yet Valid"
            description={`This pass will be valid from ${dayjs(pass.validFrom).format('MMM D, YYYY h:mm A')}`}
            type="info"
            showIcon
            className="mb-4"
          />
        )}

        {/* Visitor Info */}
        <div className="bg-gray-50 rounded-lg p-4 mb-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Text type="secondary" className="text-xs">VISITOR</Text>
              <div className="font-semibold">{pass.visitorName}</div>
            </div>
            <div>
              <Text type="secondary" className="text-xs">HOST</Text>
              <div className="font-semibold">{pass.hostName}</div>
            </div>
          </div>

          {pass.hostUnit && (
            <div className="mt-3">
              <Text type="secondary" className="text-xs">UNIT</Text>
              <div className="font-semibold flex items-center gap-1">
                <HomeOutlined /> {pass.hostUnit}
              </div>
            </div>
          )}

          {pass.purpose && (
            <div className="mt-3">
              <Text type="secondary" className="text-xs">PURPOSE</Text>
              <div className="font-semibold capitalize">{pass.purpose}</div>
            </div>
          )}
        </div>

        {/* QR Code */}
        {isValid && !isExpired && !notYetValid && pass.qrToken && (
          <div className="text-center mb-4">
            <div className="mx-auto border-4 border-white shadow-lg rounded-lg inline-block p-2 bg-white">
              <QRCodeSVG value={pass.qrToken} size={200} />
            </div>
            <Text type="secondary" className="text-sm mt-2 block">
              Show this QR code at the gate
            </Text>
          </div>
        )}

        <Divider />

        {/* Validity Period */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500 flex items-center gap-1">
              <CalendarOutlined /> Valid From
            </span>
            <span className="font-medium">
              {dayjs(pass.validFrom).format('MMM D, YYYY h:mm A')}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500 flex items-center gap-1">
              <CalendarOutlined /> Valid Until
            </span>
            <span className="font-medium">
              {dayjs(pass.validUntil).format('MMM D, YYYY h:mm A')}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">Uses Remaining</span>
            <span className="font-medium">{pass.usesRemaining}</span>
          </div>
        </div>

        {/* Building Address */}
        {pass.buildingAddress && (
          <>
            <Divider />
            <div className="text-center text-sm text-gray-500">
              <EnvironmentOutlined className="mr-1" />
              {pass.buildingAddress}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="mt-6 text-center">
          <Text type="secondary" className="text-xs">
            Powered by GateRecord
          </Text>
        </div>
      </Card>
    </div>
  );
}

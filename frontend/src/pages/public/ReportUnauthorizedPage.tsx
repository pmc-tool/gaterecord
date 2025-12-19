import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Card, Button, Result, Typography, Space, Alert, Modal } from 'antd';
import { WarningOutlined, ExclamationCircleOutlined, CheckCircleOutlined } from '@ant-design/icons';
import api from '../../services/api';

const { Title, Text, Paragraph } = Typography;

export function ReportUnauthorizedPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eventId = searchParams.get('eventId');
  const token = searchParams.get('token');

  useEffect(() => {
    if (!eventId || !token) {
      setError('Invalid report link. Missing required parameters.');
    }
  }, [eventId, token]);

  const handleReport = async () => {
    Modal.confirm({
      title: 'Confirm Unauthorized Visitor Report',
      icon: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
      content: (
        <div>
          <p>Are you sure you want to report this visitor as <strong>UNAUTHORIZED</strong>?</p>
          <p style={{ color: '#ff4d4f' }}>
            This will immediately:
          </p>
          <ul>
            <li>Trigger an alarm at the building</li>
            <li>Alert all security personnel</li>
            <li>Notify building administrators</li>
          </ul>
          <p><strong>Only proceed if this visitor is genuinely unauthorized.</strong></p>
        </div>
      ),
      okText: 'Yes, Report Unauthorized',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        setLoading(true);
        try {
          await api.post('/security-alerts/report-unauthorized', {
            accessEventId: eventId,
            token,
          });
          setSubmitted(true);
        } catch (err: unknown) {
          const error = err as { response?: { data?: { message?: string } } };
          setError(error.response?.data?.message || 'Failed to submit report. Please try again.');
        } finally {
          setLoading(false);
        }
      },
    });
  };

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
        <Card className="max-w-md w-full">
          <Result
            status="error"
            title="Error"
            subTitle={error}
            extra={
              <Button type="primary" onClick={() => navigate('/')}>
                Go to Home
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
        <Card className="max-w-md w-full">
          <Result
            status="success"
            icon={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
            title="Report Submitted"
            subTitle="Security has been alerted and an alarm has been triggered at the building."
            extra={
              <Space direction="vertical" className="w-full">
                <Alert
                  message="What happens next?"
                  description={
                    <ul className="mt-2 mb-0 pl-4">
                      <li>Security personnel are being notified immediately</li>
                      <li>An alarm has been triggered at the building</li>
                      <li>Building administrators have been alerted</li>
                      <li>Security will investigate and take appropriate action</li>
                    </ul>
                  }
                  type="info"
                  showIcon
                />
                <Button type="primary" onClick={() => navigate('/')}>
                  Go to Home
                </Button>
              </Space>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
      <Card className="max-w-lg w-full">
        <Space direction="vertical" className="w-full" size="large">
          <div className="text-center">
            <WarningOutlined style={{ fontSize: 64, color: '#ff4d4f' }} />
            <Title level={2} className="mt-4 mb-0" style={{ color: '#ff4d4f' }}>
              Report Unauthorized Visitor
            </Title>
          </div>

          <Alert
            message="Important Notice"
            description="Use this form only if the visitor who entered is NOT authorized by you. This will trigger an immediate security alert."
            type="warning"
            showIcon
          />

          <Paragraph>
            If you click the button below, the following will happen:
          </Paragraph>

          <ul className="space-y-2">
            <li className="flex items-start">
              <span className="text-red-500 mr-2">1.</span>
              <Text>An <strong>alarm will be triggered</strong> at the building</Text>
            </li>
            <li className="flex items-start">
              <span className="text-red-500 mr-2">2.</span>
              <Text>All <strong>security personnel</strong> will be immediately alerted</Text>
            </li>
            <li className="flex items-start">
              <span className="text-red-500 mr-2">3.</span>
              <Text>Building <strong>administrators</strong> will be notified</Text>
            </li>
            <li className="flex items-start">
              <span className="text-red-500 mr-2">4.</span>
              <Text>Security will <strong>investigate</strong> the unauthorized entry</Text>
            </li>
          </ul>

          <div className="text-center pt-4">
            <Space direction="vertical" className="w-full">
              <Button
                type="primary"
                danger
                size="large"
                icon={<WarningOutlined />}
                onClick={handleReport}
                loading={loading}
                className="w-full"
              >
                REPORT UNAUTHORIZED ENTRY
              </Button>
              <Button onClick={() => navigate('/')} disabled={loading}>
                Cancel - This visitor is authorized
              </Button>
            </Space>
          </div>
        </Space>
      </Card>
    </div>
  );
}

export default ReportUnauthorizedPage;

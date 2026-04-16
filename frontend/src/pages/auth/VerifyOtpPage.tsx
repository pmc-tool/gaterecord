import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Typography, Alert, Button, Input } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { authService } from '../../services/auth.service';

const { Title, Text } = Typography;

const OTP_VALIDITY_SECONDS = 60;

export default function VerifyOtpPage() {
  const navigate = useNavigate();
  const [otp, setOtp] = useState<string[]>(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [email, setEmail] = useState<string>('');
  const [otpTimer, setOtpTimer] = useState(OTP_VALIDITY_SECONDS);
  const [isOtpExpired, setIsOtpExpired] = useState(false);
  const [canResend, setCanResend] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    const storedEmail = sessionStorage.getItem('resetEmail');
    const storedExpiry = sessionStorage.getItem('otpExpiry');
    
    if (!storedEmail) {
      navigate('/forgot-password');
      return;
    }
    setEmail(storedEmail);
    
    // Calculate remaining time from stored expiry
    if (storedExpiry) {
      const expiryTime = parseInt(storedExpiry, 10);
      const remainingSeconds = Math.max(0, Math.floor((expiryTime - Date.now()) / 1000));
      if (remainingSeconds > 0) {
        setOtpTimer(remainingSeconds);
      } else {
        setIsOtpExpired(true);
        setCanResend(true);
      }
    }
    
    // Focus first input
    inputRefs.current[0]?.focus();
  }, [navigate]);

  // OTP validity countdown timer
  useEffect(() => {
    if (otpTimer > 0 && !success && !isOtpExpired) {
      const timer = setTimeout(() => setOtpTimer(otpTimer - 1), 1000);
      return () => clearTimeout(timer);
    } else if (otpTimer === 0 && !success) {
      setIsOtpExpired(true);
      setCanResend(true);
      setOtp(['', '', '', '', '', '']);
    }
  }, [otpTimer, success, isOtpExpired]);

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value) || isOtpExpired) return;
    
    const newOtp = [...otp];
    newOtp[index] = value.slice(-1);
    setOtp(newOtp);

    // Auto-focus next input
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (isOtpExpired) return;
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pastedData.length === 6) {
      const newOtp = pastedData.split('');
      setOtp(newOtp);
    }
  };

  const handleVerify = async () => {
    const otpCode = otp.join('');
    if (!email || isOtpExpired || otpCode.length !== 6) return;
    
    setLoading(true);
    setError(null);

    try {
      const response = await authService.verifyOtp(email, otpCode);
      setSuccess(true);
      
      // Store token for reset password page
      sessionStorage.setItem('resetToken', response.token);
      
      // Navigate to reset password page
      setTimeout(() => {
        navigate('/reset-password');
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid verification code');
      setOtp(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!email || !canResend) return;
    
    setResendLoading(true);
    setError(null);

    try {
      const response = await authService.forgotPassword(email);
      // Reset timer with new expiry
      const newExpirySeconds = response.expiresIn || OTP_VALIDITY_SECONDS;
      setOtpTimer(newExpirySeconds);
      setIsOtpExpired(false);
      setCanResend(false);
      // Update stored expiry
      sessionStorage.setItem('otpExpiry', String(Date.now() + newExpirySeconds * 1000));
      setOtp(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend code');
    } finally {
      setResendLoading(false);
    }
  };

  const maskedEmail = email ? 
    email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : 
    '';

  const isOtpComplete = otp.every(digit => digit !== '');

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm">
        <Card className="shadow-lg rounded-2xl border-0">
          <div className="text-center py-4">
            {/* Lock Icon */}
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <LockOutlined className="text-2xl text-gray-500" />
            </div>

            {/* Title */}
            <Title level={3} className="mb-2 font-semibold" style={{ marginBottom: 8 }}>
              Verify your identity
            </Title>

            {/* Subtitle */}
            <Text type="secondary" className="block mb-1">
              We sent a verification code to
            </Text>
            <Text strong className="block mb-6">
              {maskedEmail}
            </Text>

            {/* Error Alert */}
            {error && (
              <Alert
                message={error}
                type="error"
                showIcon
                closable
                onClose={() => setError(null)}
                className="mb-4 text-left"
              />
            )}

            {/* Success Alert */}
            {success && (
              <Alert
                message="Verification successful! Redirecting..."
                type="success"
                showIcon
                className="mb-4"
              />
            )}

            {/* OTP Label */}
            <Text className="block mb-3 text-gray-600 font-medium">
              Enter verification code
            </Text>

            {/* OTP Input Boxes */}
            <div className="flex justify-center gap-3 mb-6" onPaste={handlePaste}>
              {otp.map((digit, index) => (
                <Input
                  key={index}
                  ref={(el) => { inputRefs.current[index] = el?.input || null; }}
                  value={digit}
                  onChange={(e) => handleOtpChange(index, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(index, e)}
                  maxLength={1}
                  className="w-12 h-14 text-center text-xl font-semibold rounded-lg border-2"
                  disabled={loading || success || isOtpExpired}
                  style={{ 
                    fontSize: '20px',
                    borderColor: digit ? '#5EBAB4' : '#e5e7eb',
                    backgroundColor: isOtpExpired ? '#f9fafb' : 'white',
                  }}
                />
              ))}
            </div>

            {/* Verify Button */}
            <Button
              type="primary"
              size="large"
              block
              onClick={handleVerify}
              loading={loading}
              disabled={!isOtpComplete || isOtpExpired || success}
              style={{
                backgroundColor: isOtpComplete && !isOtpExpired ? '#5EBAB4' : undefined,
                borderColor: isOtpComplete && !isOtpExpired ? '#5EBAB4' : undefined,
                height: 48,
                borderRadius: 8,
                fontWeight: 500,
              }}
            >
              Verify and continue
            </Button>

            {/* Resend Link */}
            <div className="mt-6">
              <Text type="secondary">
                Didn't receive the code?{' '}
                {canResend ? (
                  <Button
                    type="link"
                    onClick={handleResend}
                    loading={resendLoading}
                    disabled={success}
                    className="text-teal-600 hover:text-teal-700 p-0"
                    style={{ padding: 0, height: 'auto' }}
                  >
                    Resend now
                  </Button>
                ) : (
                  <Text type="secondary" strong>
                    Resend in {otpTimer}s
                  </Text>
                )}
              </Text>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

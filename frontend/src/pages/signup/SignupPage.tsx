import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  Form,
  Input,
  Button,
  Card,
  Typography,
  Alert,
  Steps,
  Space,
  Divider,
  Radio,
  message,
} from 'antd';
import {
  UserOutlined,
  LockOutlined,
  MailOutlined,
  PhoneOutlined,
  HomeOutlined,
  CreditCardOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useAuthStore } from '../../store/authStore';

const { Title, Text, Paragraph } = Typography;

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

interface Plan {
  id: string;
  name: string;
  maxGates: number;
  maxUsers: number;
  logRetentionDays: number;
  features: {
    simulator_access?: boolean;
    csv_export?: boolean;
    api_access?: boolean;
    custom_branding?: boolean;
  };
}

const planPricing: Record<string, { price: number; period: string }> = {
  starter: { price: 49, period: '/month' },
  professional: { price: 99, period: '/month' },
  enterprise: { price: 199, period: '/month' },
};

export default function SignupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setAuth } = useAuthStore();

  const [currentStep, setCurrentStep] = useState(0);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<string>(searchParams.get('plan') || 'starter');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'demo' | 'card'>('demo');
  const [form] = Form.useForm();

  useEffect(() => {
    const fetchPlans = async () => {
      try {
        const response = await axios.get(`${API_URL}/auth/plans`);
        setPlans(response.data);
      } catch (err) {
        console.error('Failed to fetch plans');
      }
    };
    fetchPlans();
  }, []);

  useEffect(() => {
    const planFromUrl = searchParams.get('plan');
    if (planFromUrl) {
      setSelectedPlan(planFromUrl);
    }
  }, [searchParams]);

  // Fields to validate for each step
  const getStepFields = (step: number): string[] => {
    const fields: Record<number, string[]> = {
      0: [], // Plan selection doesn't need form validation
      1: ['firstName', 'lastName', 'email', 'password', 'confirmPassword'],
      2: ['buildingName'],
      3: paymentMethod === 'card' ? ['cardNumber', 'cardExpiry', 'cardCvc'] : [],
    };
    return fields[step] || [];
  };

  const handleSubmit = async () => {
    try {
      // Get all form values (including preserved values from previous steps)
      const allValues = form.getFieldsValue(true);

      // Validate current step fields
      const fieldsToValidate = getStepFields(currentStep);
      if (fieldsToValidate.length > 0) {
        await form.validateFields(fieldsToValidate);
      }

      setLoading(true);
      setError(null);

      const response = await axios.post(`${API_URL}/auth/signup`, {
        firstName: allValues.firstName,
        lastName: allValues.lastName,
        email: allValues.email,
        password: allValues.password,
        phone: allValues.phone || '',
        buildingName: allValues.buildingName,
        buildingAddress: allValues.buildingAddress || '',
        planName: selectedPlan,
        paymentInfo: paymentMethod === 'demo'
          ? { cardLast4: 'DEMO', cardBrand: 'Demo' }
          : {
              cardLast4: allValues.cardNumber?.slice(-4) || '4242',
              cardBrand: 'Visa',
            },
      });

      // Auto-login with returned tokens
      setAuth(response.data.user, {
        accessToken: response.data.accessToken,
        refreshToken: response.data.refreshToken,
      });

      message.success('Account created successfully!');
      navigate('/dashboard');
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      setError(error.response?.data?.message || 'Signup failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const steps = [
    { title: 'Plan', icon: <CheckCircleOutlined /> },
    { title: 'Account', icon: <UserOutlined /> },
    { title: 'Building', icon: <HomeOutlined /> },
    { title: 'Payment', icon: <CreditCardOutlined /> },
  ];

  const handleNext = async () => {
    try {
      const fieldsToValidate = getStepFields(currentStep);
      if (fieldsToValidate.length > 0) {
        await form.validateFields(fieldsToValidate);
      }
      setCurrentStep(currentStep + 1);
    } catch {
      // Validation failed, don't proceed
    }
  };

  const pricing = planPricing[selectedPlan] || { price: 49, period: '/month' };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2 mb-4">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl flex items-center justify-center">
              <ShieldCheckIcon className="w-7 h-7 text-white" />
            </div>
            <span className="text-2xl font-bold text-gray-900">GateRecord</span>
          </Link>
          <Title level={2} className="mb-2">Create Your Account</Title>
          <Text type="secondary">Set up your building's gate management system</Text>
        </div>

        {/* Steps */}
        <Steps current={currentStep} items={steps} className="mb-8" />

        <Card className="shadow-xl">
          {error && (
            <Alert
              message="Error"
              description={error}
              type="error"
              showIcon
              closable
              onClose={() => setError(null)}
              className="mb-4"
            />
          )}

          <Form form={form} layout="vertical" size="large" preserve={true}>
            {/* Step 1: Select Plan */}
            {currentStep === 0 && (
              <div>
                <Title level={4}>Select Your Plan</Title>
                <Paragraph type="secondary">
                  Choose the plan that best fits your building's needs. You can upgrade anytime.
                </Paragraph>

                <Radio.Group
                  value={selectedPlan}
                  onChange={(e) => setSelectedPlan(e.target.value)}
                  className="w-full"
                >
                  <Space direction="vertical" className="w-full">
                    {plans.map((plan) => {
                      const price = planPricing[plan.name.toLowerCase()] || { price: 0, period: '' };
                      return (
                        <Radio
                          key={plan.id}
                          value={plan.name.toLowerCase()}
                          className="w-full p-4 border rounded-lg hover:border-blue-500 transition-colors"
                        >
                          <div className="flex justify-between items-start w-full">
                            <div>
                              <div className="font-semibold text-lg capitalize">{plan.name}</div>
                              <div className="text-gray-500 text-sm">
                                Up to {plan.maxGates} gates, {plan.maxUsers} users
                              </div>
                              <div className="text-gray-400 text-xs mt-1">
                                {plan.logRetentionDays} days log retention
                                {plan.features.csv_export && ' • CSV Export'}
                                {plan.features.api_access && ' • API Access'}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-2xl font-bold text-blue-600">
                                ${price.price}
                              </div>
                              <div className="text-gray-500 text-sm">{price.period}</div>
                            </div>
                          </div>
                        </Radio>
                      );
                    })}
                  </Space>
                </Radio.Group>

                <div className="mt-6 p-4 bg-green-50 rounded-lg border border-green-200">
                  <Text className="text-green-700">
                    <CheckCircleOutlined className="mr-2" />
                    Start with a <strong>14-day free trial</strong>. No credit card required to start.
                  </Text>
                </div>
              </div>
            )}

            {/* Step 2: Account Details */}
            {currentStep === 1 && (
              <div>
                <Title level={4}>Account Details</Title>
                <Paragraph type="secondary">
                  Create your admin account to manage your building.
                </Paragraph>

                <div className="grid grid-cols-2 gap-4">
                  <Form.Item
                    name="firstName"
                    label="First Name"
                    rules={[{ required: true, message: 'Please enter your first name' }]}
                  >
                    <Input prefix={<UserOutlined />} placeholder="John" />
                  </Form.Item>

                  <Form.Item
                    name="lastName"
                    label="Last Name"
                    rules={[{ required: true, message: 'Please enter your last name' }]}
                  >
                    <Input prefix={<UserOutlined />} placeholder="Doe" />
                  </Form.Item>
                </div>

                <Form.Item
                  name="email"
                  label="Email"
                  rules={[
                    { required: true, message: 'Please enter your email' },
                    { type: 'email', message: 'Please enter a valid email' },
                  ]}
                >
                  <Input prefix={<MailOutlined />} placeholder="admin@yourbuilding.com" />
                </Form.Item>

                <Form.Item
                  name="phone"
                  label="Phone Number"
                >
                  <Input prefix={<PhoneOutlined />} placeholder="+1 234 567 8900" />
                </Form.Item>

                <Form.Item
                  name="password"
                  label="Password"
                  rules={[
                    { required: true, message: 'Please enter a password' },
                    { min: 8, message: 'Password must be at least 8 characters' },
                  ]}
                >
                  <Input.Password prefix={<LockOutlined />} placeholder="Min 8 characters" />
                </Form.Item>

                <Form.Item
                  name="confirmPassword"
                  label="Confirm Password"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: 'Please confirm your password' },
                    ({ getFieldValue }) => ({
                      validator(_, value) {
                        if (!value || getFieldValue('password') === value) {
                          return Promise.resolve();
                        }
                        return Promise.reject(new Error('Passwords do not match'));
                      },
                    }),
                  ]}
                >
                  <Input.Password prefix={<LockOutlined />} placeholder="Confirm password" />
                </Form.Item>
              </div>
            )}

            {/* Step 3: Building Details */}
            {currentStep === 2 && (
              <div>
                <Title level={4}>Building Details</Title>
                <Paragraph type="secondary">
                  Tell us about your building or property.
                </Paragraph>

                <Form.Item
                  name="buildingName"
                  label="Building / Property Name"
                  rules={[{ required: true, message: 'Please enter your building name' }]}
                >
                  <Input prefix={<HomeOutlined />} placeholder="Sunrise Apartments" />
                </Form.Item>

                <Form.Item
                  name="buildingAddress"
                  label="Address"
                >
                  <Input.TextArea
                    placeholder="123 Main Street, City, State 12345"
                    rows={3}
                  />
                </Form.Item>
              </div>
            )}

            {/* Step 4: Payment (Dummy) */}
            {currentStep === 3 && (
              <div>
                <Title level={4}>Payment Details</Title>
                <Paragraph type="secondary">
                  Your card won't be charged during the 14-day trial period.
                </Paragraph>

                {/* Order Summary */}
                <div className="bg-gray-50 p-4 rounded-lg mb-6">
                  <div className="flex justify-between mb-2">
                    <Text>Plan</Text>
                    <Text strong className="capitalize">{selectedPlan}</Text>
                  </div>
                  <div className="flex justify-between mb-2">
                    <Text>Price</Text>
                    <Text strong>${pricing.price}/month</Text>
                  </div>
                  <Divider className="my-2" />
                  <div className="flex justify-between">
                    <Text>Due today (14-day trial)</Text>
                    <Text strong className="text-green-600">$0.00</Text>
                  </div>
                </div>

                {/* Payment Method Selection */}
                <div className="mb-6">
                  <Text strong className="block mb-3">Payment Method</Text>
                  <Radio.Group
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="w-full"
                  >
                    <Space direction="vertical" className="w-full">
                      <Radio
                        value="demo"
                        className="w-full p-4 border rounded-lg hover:border-blue-500 transition-colors"
                      >
                        <div>
                          <div className="font-semibold text-green-600">
                            <CheckCircleOutlined className="mr-2" />
                            Demo Payment (Recommended)
                          </div>
                          <div className="text-gray-500 text-sm mt-1">
                            Skip payment details for demo purposes. No card required.
                          </div>
                        </div>
                      </Radio>
                      <Radio
                        value="card"
                        className="w-full p-4 border rounded-lg hover:border-blue-500 transition-colors"
                      >
                        <div>
                          <div className="font-semibold">
                            <CreditCardOutlined className="mr-2" />
                            Credit/Debit Card
                          </div>
                          <div className="text-gray-500 text-sm mt-1">
                            Enter card details (demo mode - no charges)
                          </div>
                        </div>
                      </Radio>
                    </Space>
                  </Radio.Group>
                </div>

                {/* Card Fields - Only shown when card is selected */}
                {paymentMethod === 'card' && (
                  <>
                    <Form.Item
                      name="cardNumber"
                      label="Card Number"
                      rules={[{ required: true, message: 'Please enter card number' }]}
                    >
                      <Input
                        prefix={<CreditCardOutlined />}
                        placeholder="4242 4242 4242 4242"
                        maxLength={19}
                      />
                    </Form.Item>

                    <div className="grid grid-cols-2 gap-4">
                      <Form.Item
                        name="cardExpiry"
                        label="Expiry Date"
                        rules={[{ required: true, message: 'Required' }]}
                      >
                        <Input placeholder="MM/YY" maxLength={5} />
                      </Form.Item>

                      <Form.Item
                        name="cardCvc"
                        label="CVC"
                        rules={[{ required: true, message: 'Required' }]}
                      >
                        <Input placeholder="123" maxLength={4} />
                      </Form.Item>
                    </div>
                  </>
                )}

                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <Text className="text-blue-700 text-sm">
                    <LockOutlined className="mr-2" />
                    {paymentMethod === 'demo'
                      ? 'Demo mode - Your account will be created immediately with full access.'
                      : 'Your payment information is secure. This is a demo - no actual charges will be made.'}
                  </Text>
                </div>
              </div>
            )}

            {/* Navigation Buttons */}
            <div className="flex justify-between mt-8">
              <Button
                onClick={() => setCurrentStep(currentStep - 1)}
                disabled={currentStep === 0}
              >
                Previous
              </Button>

              {currentStep < 3 ? (
                <Button
                  type="primary"
                  onClick={handleNext}
                >
                  Next
                </Button>
              ) : (
                <Button
                  type="primary"
                  loading={loading}
                  onClick={handleSubmit}
                  className="bg-gradient-to-r from-blue-600 to-indigo-600 border-none"
                >
                  Start Free Trial
                </Button>
              )}
            </div>
          </Form>

          <Divider />

          <div className="text-center">
            <Text type="secondary">
              Already have an account?{' '}
              <Link to="/login" className="text-blue-600 hover:text-blue-700">
                Sign in
              </Link>
            </Text>
          </div>
        </Card>
      </div>
    </div>
  );
}

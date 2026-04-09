import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  Form,
  Input,
  Button,
  Card,
  Typography,
  Alert,
  Steps,
  Divider,
  message,
  Segmented,
} from 'antd';
import {
  UserOutlined,
  LockOutlined,
  MailOutlined,
  PhoneOutlined,
  HomeOutlined,
  CreditCardOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  CrownOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  GiftOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import { useAuthStore } from '../../store/authStore';

const { Title, Text, Paragraph } = Typography;

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

interface Plan {
  id: string;
  name: string;
  description?: string;
  monthlyPrice: number;
  yearlyPrice: number;
  maxGates: number;
  maxUsers: number;
  maxVehicles: number;
  logRetentionDays: number;
  trialDays: number;
  badge?: string;
  badgeColor?: string;
  isFeatured?: boolean;
  discountPercent?: number;
  discountLabel?: string;
  features: {
    simulator_access?: boolean;
    csv_export?: boolean;
    api_access?: boolean;
    custom_branding?: boolean;
    priority_support?: boolean;
    advanced_analytics?: boolean;
    multi_building?: boolean;
    webhook_notifications?: boolean;
  };
}

export default function SignupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setAuth } = useAuthStore();

  const [currentStep, setCurrentStep] = useState(0);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<string>(searchParams.get('plan') || '');
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'yearly'>('monthly');
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [trialLoading, setTrialLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();

  // Combined loading state for disabling buttons
  const loading = paymentLoading || trialLoading;

  // Sort plans by price (ascending)
  const sortedPlans = useMemo(() => {
    return [...plans].sort((a, b) => a.monthlyPrice - b.monthlyPrice);
  }, [plans]);

  useEffect(() => {
    const fetchPlans = async () => {
      try {
        const response = await axios.get(`${API_URL}/auth/plans`);
        setPlans(response.data);
        // Auto-select first plan if none selected
        if (!selectedPlan && response.data.length > 0) {
          const sorted = [...response.data].sort((a: Plan, b: Plan) => a.monthlyPrice - b.monthlyPrice);
          setSelectedPlan(sorted[0]?.name?.toLowerCase() || '');
        }
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

  // Get selected plan details
  const selectedPlanDetails = useMemo(() => {
    return plans.find(p => p.name.toLowerCase() === selectedPlan);
  }, [plans, selectedPlan]);

  // Format price - show decimals only when needed (e.g., $13.50 not $14, but $15 not $15.00)
  const formatPrice = (amount: number) => {
    const rounded = Math.round(amount * 100) / 100; // Round to 2 decimals
    if (rounded % 1 === 0) {
      return rounded.toString(); // Whole number: $15
    }
    return rounded.toFixed(2).replace(/\.?0+$/, ''); // Remove trailing zeros: $13.5
  };

  // Get base price (stored in DB - before discount)
  const getBasePrice = (plan: Plan) => {
    if (billingInterval === 'yearly') {
      return plan.yearlyPrice > 0 ? plan.yearlyPrice / 12 : 0;
    }
    return plan.monthlyPrice;
  };

  // Calculate discounted price (apply discount to base price)
  const getPrice = (plan: Plan) => {
    const basePrice = getBasePrice(plan);
    if (plan.discountPercent && plan.discountPercent > 0) {
      return basePrice * (1 - plan.discountPercent / 100);
    }
    return basePrice;
  };

  const getTotalYearlyPrice = (plan: Plan) => {
    const baseYearly = plan.yearlyPrice || plan.monthlyPrice * 12;
    if (plan.discountPercent && plan.discountPercent > 0) {
      return baseYearly * (1 - plan.discountPercent / 100);
    }
    return baseYearly;
  };

  const getYearlySavings = (plan: Plan) => {
    // Calculate what you'd pay monthly for a year vs yearly price (both with discount applied)
    const discountMultiplier = plan.discountPercent && plan.discountPercent > 0 
      ? (1 - plan.discountPercent / 100) 
      : 1;
    const monthlyTotalWithDiscount = plan.monthlyPrice * 12 * discountMultiplier;
    const yearlyTotalWithDiscount = (plan.yearlyPrice || plan.monthlyPrice * 12) * discountMultiplier;
    return monthlyTotalWithDiscount - yearlyTotalWithDiscount;
  };

  // Calculate pricing for selected plan
  const pricing = selectedPlanDetails 
    ? { price: getPrice(selectedPlanDetails), period: billingInterval === 'yearly' ? '/year' : '/month' }
    : { price: 0, period: '/month' };

  // Check if current plan is free
  const isFreePlan = pricing.price === 0;

  // Fields to validate for each step
  const getStepFields = (step: number): string[] => {
    const fields: Record<number, string[]> = {
      0: [], // Plan selection doesn't need form validation
      1: ['firstName', 'lastName', 'email', 'password', 'confirmPassword'],
      2: ['buildingName'],
      3: [], // Payment handled by Stripe Checkout
    };
    return fields[step] || [];
  };

  // Handle Stripe Checkout redirect for paid plans (payment-first flow)
  const handleStripeCheckout = async (skipTrial: boolean = false) => {
    try {
      if (skipTrial) {
        setPaymentLoading(true);
      } else {
        setTrialLoading(true);
      }
      setError(null);

      const allValues = form.getFieldsValue(true);

      // Create Stripe Checkout session with all signup data
      // Account will be created ONLY after successful payment (via webhook)
      const checkoutResponse = await axios.post(`${API_URL}/auth/signup-checkout`, {
        firstName: allValues.firstName,
        lastName: allValues.lastName,
        email: allValues.email,
        password: allValues.password,
        phone: allValues.phone || '',
        buildingName: allValues.buildingName,
        buildingAddress: allValues.buildingAddress || '',
        planId: selectedPlanDetails?.id,
        billingCycle: billingInterval,
        skipTrial, // Pass skipTrial to backend - true = charge now, false = use trial
        successUrl: `${window.location.origin}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${window.location.origin}/signup?step=3&plan=${selectedPlan}`,
      });

      // Redirect to Stripe Checkout page
      if (checkoutResponse.data.url) {
        window.location.href = checkoutResponse.data.url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      setError(error.response?.data?.message || 'Failed to start checkout. Please try again.');
    } finally {
      setPaymentLoading(false);
      setTrialLoading(false);
    }
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

      // For paid plans, redirect to Stripe Checkout (skip trial = charge immediately)
      if (!isFreePlan) {
        await handleStripeCheckout(true); // skipTrial = true for "Pay & Subscribe"
        return;
      }

      // For free plans, create account directly
      setPaymentLoading(true);
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
        billingInterval: billingInterval,
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
      setPaymentLoading(false);
    }
  };

  // Handle starting a free trial without immediate payment
  const handleStartFreeTrial = async () => {
    try {
      setTrialLoading(true);
      setError(null);
      
      // Validate all required fields
      const fieldsToValidate = getStepFields(currentStep);
      if (fieldsToValidate.length > 0) {
        await form.validateFields(fieldsToValidate);
      }

      // For paid plans with trial, redirect to Stripe Checkout (use trial period)
      // Note: handleStripeCheckout will manage loading state internally
      setTrialLoading(false); // Reset before handleStripeCheckout sets it
      await handleStripeCheckout(false); // skipTrial = false for "Free Trial"
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      setError(error.response?.data?.message || 'Failed to start trial. Please try again.');
      setTrialLoading(false);
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center mb-4">
            <img src="/logo.png" alt="GateRecord" className="h-14 object-contain" />
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

          <Form
            form={form}
            layout="vertical"
            size="large"
            preserve={true}
            validateTrigger={['onChange', 'onBlur']}
          >
            {/* Step 1: Select Plan */}
            {currentStep === 0 && (
              <div>
                <Title level={4}>Select Your Plan</Title>
                <Paragraph type="secondary">
                  Choose the plan that best fits your building's needs. You can upgrade anytime.
                </Paragraph>

                {/* Billing Interval Toggle */}
                <div className="flex justify-center mb-6">
                  <Segmented
                    value={billingInterval}
                    onChange={(value) => setBillingInterval(value as 'monthly' | 'yearly')}
                    options={[
                      { label: 'Monthly', value: 'monthly' },
                      { 
                        label: (
                          <span>
                            Yearly
                          </span>
                        ), 
                        value: 'yearly' 
                      },
                    ]}
                    size="large"
                  />
                </div>

                {/* Plan Cards Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {sortedPlans.map((plan) => {
                    const isSelected = selectedPlan === plan.name.toLowerCase();
                    const price = getPrice(plan);
                    const isFree = price === 0;
                    const savings = getYearlySavings(plan);
                    const hasDiscount = plan.discountPercent && plan.discountPercent > 0;
                    const hasTrial = plan.trialDays && plan.trialDays > 0;
                    
                    return (
                      <div
                        key={plan.id}
                        onClick={() => setSelectedPlan(plan.name.toLowerCase())}
                        className={`
                          relative cursor-pointer rounded-xl border-2 p-5 transition-all duration-200
                          ${isSelected 
                            ? 'border-blue-500 bg-blue-50 shadow-lg scale-[1.02]' 
                            : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-md'
                          }
                          ${plan.isFeatured ? 'ring-2 ring-blue-500 ring-offset-2' : ''}
                        `}
                      >
                        {/* Badge */}
                        {plan.badge && (
                          <div 
                            className={`
                              absolute -top-3 left-4 px-3 py-1 rounded-full text-xs font-semibold text-white
                              ${plan.badgeColor === 'gold' ? 'bg-yellow-500' : ''}
                              ${plan.badgeColor === 'blue' ? 'bg-blue-500' : ''}
                              ${plan.badgeColor === 'green' ? 'bg-green-500' : ''}
                              ${plan.badgeColor === 'purple' ? 'bg-purple-500' : ''}
                              ${!plan.badgeColor ? 'bg-blue-500' : ''}
                            `}
                          >
                            {plan.badge === 'Popular' && <CrownOutlined className="mr-1" />}
                            {plan.badge}
                          </div>
                        )}

                        {/* Selection Indicator */}
                        <div className={`
                          absolute top-4 right-4 w-6 h-6 rounded-full border-2 flex items-center justify-center
                          ${isSelected 
                            ? 'border-blue-500 bg-blue-500' 
                            : 'border-gray-300'
                          }
                        `}>
                          {isSelected && <CheckOutlined className="text-white text-xs" />}
                        </div>

                        {/* Plan Header */}
                        <div className="mb-4">
                          <h3 className="text-xl font-bold text-gray-900 capitalize">{plan.name}</h3>
                          {plan.description && (
                            <p className="text-sm text-gray-500 mt-1">{plan.description}</p>
                          )}
                        </div>

                        {/* Price */}
                        <div className="mb-4">
                          <div className="flex items-baseline flex-wrap gap-x-2">
                            {/* Show base price (struck through) if there's a discount */}
                            {hasDiscount && !isFree && (
                              <span className="text-xl text-gray-400 line-through">
                                ${billingInterval === 'yearly' 
                                  ? formatPrice(plan.yearlyPrice || plan.monthlyPrice * 12)
                                  : formatPrice(getBasePrice(plan))
                                }
                              </span>
                            )}
                            <span className={`text-4xl font-bold ${isSelected ? 'text-blue-600' : 'text-gray-900'}`}>
                              {isFree ? 'Free' : billingInterval === 'yearly'
                                ? `$${formatPrice(getTotalYearlyPrice(plan))}`
                                : `$${formatPrice(price)}`
                              }
                            </span>
                            {!isFree && (
                              <span className="text-gray-500">/{billingInterval === 'yearly' ? 'year' : 'month'}</span>
                            )}
                          </div>
                          
                          {/* Discount Badge - Inside Card */}
                          {hasDiscount && !isFree && (
                            <div className="mt-2 inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-600 border border-red-200">
                              <ThunderboltOutlined className="mr-1" />
                              {plan.discountLabel || `${Number(plan.discountPercent).toFixed(2)}% OFF`}
                            </div>
                          )}
                          
                          {/* Yearly savings note */}
                          {billingInterval === 'yearly' && !isFree && savings > 0 && (
                            <div className="text-sm text-green-600 mt-1">
                              Save ${formatPrice(savings)} compared to monthly
                            </div>
                          )}
                          
                          {/* Free Trial Badge */}
                          {hasTrial && !isFree && (
                            <div className="mt-2 inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">
                              <SafetyCertificateOutlined className="mr-1" />
                              {plan.trialDays}-day free trial
                            </div>
                          )}
                        </div>

                        {/* Limits */}
                        <div className="space-y-2 mb-4 pb-4 border-b border-gray-100">
                          <div className="flex items-center text-sm">
                            <CheckOutlined className="text-green-500 mr-2" />
                            <span>Up to <strong>{plan.maxGates}</strong> gates</span>
                          </div>
                          <div className="flex items-center text-sm">
                            <CheckOutlined className="text-green-500 mr-2" />
                            <span>Up to <strong>{plan.maxUsers}</strong> users</span>
                          </div>
                          <div className="flex items-center text-sm">
                            <CheckOutlined className="text-green-500 mr-2" />
                            <span><strong>{plan.logRetentionDays}</strong> days log retention</span>
                          </div>
                        </div>

                        {/* Features */}
                        <div className="space-y-2">
                          {plan.features.csv_export && (
                            <div className="flex items-center text-sm text-gray-600">
                              <CheckOutlined className="text-blue-500 mr-2" />
                              CSV Export
                            </div>
                          )}
                          {plan.features.api_access && (
                            <div className="flex items-center text-sm text-gray-600">
                              <CheckOutlined className="text-blue-500 mr-2" />
                              API Access
                            </div>
                          )}
                          {plan.features.priority_support && (
                            <div className="flex items-center text-sm text-gray-600">
                              <CheckOutlined className="text-blue-500 mr-2" />
                              Priority Support
                            </div>
                          )}
                          {plan.features.advanced_analytics && (
                            <div className="flex items-center text-sm text-gray-600">
                              <CheckOutlined className="text-blue-500 mr-2" />
                              Advanced Analytics
                            </div>
                          )}
                          {plan.features.webhook_notifications && (
                            <div className="flex items-center text-sm text-gray-600">
                              <CheckOutlined className="text-blue-500 mr-2" />
                              Webhook Notifications
                            </div>
                          )}
                          {plan.features.custom_branding && (
                            <div className="flex items-center text-sm text-gray-600">
                              <CheckOutlined className="text-blue-500 mr-2" />
                              Custom Branding
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-6 p-4 bg-green-50 rounded-lg border border-green-200">
                  <Text className="text-green-700">
                    <SafetyCertificateOutlined className="mr-2" />
                    {selectedPlanDetails?.trialDays && selectedPlanDetails.trialDays > 0 ? (
                      <>No credit card required for free trial</>
                    ) : (
                      <>Get started instantly with your selected plan</>
                    )}
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
                    hasFeedback
                    rules={[{ required: true, message: 'Please enter your first name' }]}
                  >
                    <Input prefix={<UserOutlined />} placeholder="John" />
                  </Form.Item>

                  <Form.Item
                    name="lastName"
                    label="Last Name"
                    hasFeedback
                    rules={[{ required: true, message: 'Please enter your last name' }]}
                  >
                    <Input prefix={<UserOutlined />} placeholder="Doe" />
                  </Form.Item>
                </div>

                <Form.Item
                  name="email"
                  label="Email"
                  hasFeedback
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
                  hasFeedback
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
                  hasFeedback
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
                  hasFeedback
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

            {/* Step 4: Payment / Confirmation */}
            {currentStep === 3 && (
              <div>
                {/* Different UI for Free vs Paid plans */}
                {pricing.price === 0 ? (
                  /* FREE PLAN - No payment required */
                  <>
                    <Title level={4}>Confirm Your Free Plan</Title>
                    <Paragraph type="secondary">
                      You're signing up for the free plan. No payment required!
                    </Paragraph>

                    {/* Order Summary */}
                    <div className="bg-gradient-to-r from-green-50 to-emerald-50 p-6 rounded-xl border border-green-200 mb-6">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <Text className="text-gray-500 text-sm">Selected Plan</Text>
                          <div className="text-2xl font-bold text-gray-900 capitalize">{selectedPlan}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-3xl font-bold text-green-600">Free</div>
                          <Text className="text-gray-500">Forever</Text>
                        </div>
                      </div>
                      
                      <Divider className="my-4" />
                      
                      <div className="space-y-2">
                        <div className="flex items-center text-sm text-gray-600">
                          <CheckCircleOutlined className="text-green-500 mr-2" />
                          Up to {selectedPlanDetails?.maxGates || 3} gates
                        </div>
                        <div className="flex items-center text-sm text-gray-600">
                          <CheckCircleOutlined className="text-green-500 mr-2" />
                          Up to {selectedPlanDetails?.maxUsers || 50} users
                        </div>
                        <div className="flex items-center text-sm text-gray-600">
                          <CheckCircleOutlined className="text-green-500 mr-2" />
                          {selectedPlanDetails?.logRetentionDays || 30} days log retention
                        </div>
                      </div>
                    </div>

                    <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                      <Text className="text-blue-700 text-sm">
                        <CheckCircleOutlined className="mr-2" />
                        Your account will be created immediately with full access to the free plan features.
                        You can upgrade anytime from your dashboard.
                      </Text>
                    </div>
                  </>
                ) : (
                  /* PAID PLAN - Payment required */
                  <>
                    <Title level={4}>Payment Details</Title>
                    <Paragraph type="secondary">
                      {selectedPlanDetails?.trialDays && selectedPlanDetails.trialDays > 0
                        ? `Your card won't be charged during the ${selectedPlanDetails.trialDays}-day free trial period.`
                        : 'Complete your subscription to get started.'}
                    </Paragraph>

                    {/* Order Summary */}
                    <div className="bg-gray-50 p-5 rounded-xl mb-6">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <Text className="text-gray-500 text-sm">Plan</Text>
                          <div className="text-lg font-semibold text-gray-900 capitalize">{selectedPlan}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-bold text-blue-600">
                            ${formatPrice(pricing.price)}
                          </div>
                          <Text className="text-gray-500">/month</Text>
                        </div>
                      </div>

                      <div className="space-y-2 py-3 border-t border-b border-gray-200">
                        <div className="flex justify-between text-sm">
                          <Text>Billing cycle</Text>
                          <Text strong className="capitalize">{billingInterval}</Text>
                        </div>
                        {billingInterval === 'yearly' && selectedPlanDetails && (
                          <div className="flex justify-between text-sm">
                            <Text>Yearly total</Text>
                            <Text strong>${formatPrice(getTotalYearlyPrice(selectedPlanDetails))}</Text>
                          </div>
                        )}
                        {billingInterval === 'yearly' && selectedPlanDetails && getYearlySavings(selectedPlanDetails) > 0 && (
                          <div className="flex justify-between text-sm text-green-600">
                            <Text className="text-green-600">You save</Text>
                            <Text strong className="text-green-600">${formatPrice(getYearlySavings(selectedPlanDetails))}/year</Text>
                          </div>
                        )}
                      </div>

                      <div className="flex justify-between pt-3">
                        <Text strong>
                          {selectedPlanDetails?.trialDays && selectedPlanDetails.trialDays > 0
                            ? `Due today (${selectedPlanDetails.trialDays}-day free trial)`
                            : 'Due today'}
                        </Text>
                        <Text strong className={selectedPlanDetails?.trialDays ? "text-green-600 text-lg" : "text-blue-600 text-lg"}>
                          {selectedPlanDetails?.trialDays && selectedPlanDetails.trialDays > 0
                            ? '$0.00'
                            : `$${billingInterval === 'yearly' ? getTotalYearlyPrice(selectedPlanDetails!) : pricing.price}`}
                        </Text>
                      </div>
                    </div>

                    {/* Stripe Checkout Info */}
                    <div className="mb-6">
                      {/* Features included */}
                      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
                        <Text strong className="block mb-3 text-gray-700">What's included:</Text>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="flex items-center text-sm text-gray-600">
                            <CheckOutlined className="text-green-500 mr-2" />
                            Up to {selectedPlanDetails?.maxGates} gates
                          </div>
                          <div className="flex items-center text-sm text-gray-600">
                            <CheckOutlined className="text-green-500 mr-2" />
                            Up to {selectedPlanDetails?.maxUsers} users
                          </div>
                          <div className="flex items-center text-sm text-gray-600">
                            <CheckOutlined className="text-green-500 mr-2" />
                            {selectedPlanDetails?.logRetentionDays} days logs
                          </div>
                          {selectedPlanDetails?.features.api_access && (
                            <div className="flex items-center text-sm text-gray-600">
                              <CheckOutlined className="text-green-500 mr-2" />
                              API Access
                            </div>
                          )}
                          {selectedPlanDetails?.features.csv_export && (
                            <div className="flex items-center text-sm text-gray-600">
                              <CheckOutlined className="text-green-500 mr-2" />
                              CSV Export
                            </div>
                          )}
                          {selectedPlanDetails?.features.priority_support && (
                            <div className="flex items-center text-sm text-gray-600">
                              <CheckOutlined className="text-green-500 mr-2" />
                              Priority Support
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Stripe Payment Info */}
                      <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl p-5">
                        <div className="flex items-start">
                          <div className="bg-white p-2 rounded-lg shadow-sm mr-4">
                            <SafetyCertificateOutlined className="text-2xl text-indigo-600" />
                          </div>
                          <div className="flex-1">
                            <Text strong className="block text-gray-800 mb-1">
                              Secure Payment via Stripe
                            </Text>
                            <Text className="text-gray-600 text-sm block mb-3">
                              You'll be redirected to Stripe's secure checkout page to complete your payment.
                              We support all major credit cards, debit cards, and Stripe Link for faster checkout.
                            </Text>
                            <div className="flex items-center space-x-3">
                              <img src="https://js.stripe.com/v3/fingerprinted/img/visa-729c05c240c4bdb47b03ac81d9945bfe.svg" alt="Visa" className="h-6" />
                              <img src="https://js.stripe.com/v3/fingerprinted/img/mastercard-4d8844094130711885b5e41b28c9848f.svg" alt="Mastercard" className="h-6" />
                              <img src="https://js.stripe.com/v3/fingerprinted/img/amex-a49b82f46c5cd6a96a6e418a6ca1717c.svg" alt="Amex" className="h-6" />
                              <div className="bg-[#635BFF] text-white text-xs font-semibold px-2 py-1 rounded">
                                Link
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Security badges */}
                    <div className="flex items-center justify-center space-x-6 text-gray-400 text-xs">
                      <div className="flex items-center">
                        <LockOutlined className="mr-1" />
                        256-bit SSL
                      </div>
                      <div className="flex items-center">
                        <SafetyCertificateOutlined className="mr-1" />
                        PCI Compliant
                      </div>
                      <div className="flex items-center">
                        <ThunderboltOutlined className="mr-1" />
                        Instant Setup
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Navigation Buttons */}
            <div className="flex justify-between mt-8">
              <Button
                onClick={() => setCurrentStep(currentStep - 1)}
                disabled={currentStep === 0 || loading}
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
                <div className="flex gap-3">
                  {/* Free Trial Button - shown when plan has trial days */}
                  {selectedPlanDetails?.trialDays && selectedPlanDetails.trialDays > 0 && !isFreePlan && (
                    <Button
                      loading={trialLoading}
                      disabled={paymentLoading}
                      onClick={handleStartFreeTrial}
                      size="large"
                      icon={!trialLoading ? <GiftOutlined /> : undefined}
                      className="px-6 min-w-[180px] border-none text-white"
                      style={{
                        background: 'linear-gradient(to right, #22c55e, #059669)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'linear-gradient(to right, #16a34a, #047857)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'linear-gradient(to right, #22c55e, #059669)';
                      }}
                    >
                      {trialLoading ? 'Processing...' : `Start ${selectedPlanDetails.trialDays}-Day Trial`}
                    </Button>
                  )}
                  
                  {/* Payment / Create Account Button */}
                  <Button
                    type="primary"
                    loading={paymentLoading}
                    disabled={trialLoading}
                    onClick={handleSubmit}
                    size="large"
                    icon={!isFreePlan && !paymentLoading ? <CreditCardOutlined /> : undefined}
                    className="px-8 border-none min-w-[200px] text-white"
                    style={{
                      background: pricing.price === 0 
                        ? 'linear-gradient(to right, #22c55e, #059669)' 
                        : 'linear-gradient(to right, #4f46e5, #9333ea)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = pricing.price === 0 
                        ? 'linear-gradient(to right, #16a34a, #047857)' 
                        : 'linear-gradient(to right, #4338ca, #7e22ce)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = pricing.price === 0 
                        ? 'linear-gradient(to right, #22c55e, #059669)' 
                        : 'linear-gradient(to right, #4f46e5, #9333ea)';
                    }}
                  >
                    {paymentLoading ? (
                      <span>Processing...</span>
                    ) : pricing.price === 0 ? (
                      'Create Free Account'
                    ) : (
                      'Pay & Subscribe'
                    )}
                  </Button>
                </div>
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

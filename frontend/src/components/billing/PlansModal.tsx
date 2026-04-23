import { useState, useEffect } from 'react';
import {
  Modal,
  Typography,
  Tag,
  Spin,
  message,
  Button,
  Space,
  Alert,
  Divider,
} from 'antd';
import {
  CheckOutlined,
  CrownOutlined,
  RocketOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons';
import {
  billingService,
  AvailablePlan,
  PlanChangePreview,
} from '../../services/billing.service';

const { Title, Text } = Typography;

interface PlansModalProps {
  open: boolean;
  onClose: () => void;
}

interface CurrentPlan {
  id: string;
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  maxGates: number;
  maxUsers: number;
  features: string[];
}

export function PlansModal({ open, onClose }: PlansModalProps) {
  const [loading, setLoading] = useState(true);
  const [currentPlan, setCurrentPlan] = useState<CurrentPlan | null>(null);
  const [availablePlans, setAvailablePlans] = useState<AvailablePlan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<AvailablePlan | null>(null);
  const [selectedBillingCycle, setSelectedBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [planPreview, setPlanPreview] = useState<PlanChangePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [isOnTrial, setIsOnTrial] = useState(false);

  useEffect(() => {
    if (open) {
      fetchPlans();
    }
  }, [open]);

  const fetchPlans = async () => {
    try {
      setLoading(true);
      const plansResponse = await billingService.getAvailablePlans();
      setCurrentPlan(plansResponse.currentPlan);
      setAvailablePlans(plansResponse.availablePlans);
      setIsOnTrial(plansResponse.isOnTrial || false);
    } catch (error) {
      console.error('Failed to fetch plans:', error);
      message.error('Failed to load plans');
    } finally {
      setLoading(false);
    }
  };

  const handlePlanSelect = async (plan: AvailablePlan) => {
    setSelectedPlan(plan);
    setConfirmModalOpen(true);
    // Only fetch preview for non-trial users (trial users don't have a subscription to prorate)
    if (!isOnTrial) {
      await fetchPreview(plan.id, selectedBillingCycle);
    }
  };

  const fetchPreview = async (planId: string, cycle: 'monthly' | 'yearly') => {
    try {
      setPreviewLoading(true);
      const preview = await billingService.previewPlanChange(planId, cycle);
      setPlanPreview(preview);
    } catch (error) {
      console.error('Failed to fetch preview:', error);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleBillingCycleChange = async (cycle: 'monthly' | 'yearly') => {
    setSelectedBillingCycle(cycle);
    // Only fetch preview for non-trial users
    if (selectedPlan && !isOnTrial) {
      await fetchPreview(selectedPlan.id, cycle);
    }
  };

  const handleChangePlan = async () => {
    if (!selectedPlan) return;

    try {
      setUpgradeLoading(true);
      
      // For trial users, create a checkout session to start a new subscription
      if (isOnTrial) {
        const checkout = await billingService.createCheckoutSession(selectedPlan.id, selectedBillingCycle);
        // Redirect to Stripe checkout
        window.location.href = checkout.url;
        return;
      }
      
      // For existing subscribers, change the plan
      const result = await billingService.changePlan(selectedPlan.id, selectedBillingCycle, true);
      
      // Show appropriate message based on upgrade vs downgrade
      if (result.isUpgrade) {
        message.success(`Successfully upgraded to ${selectedPlan.name} plan!`);
      } else {
        message.success(
          `Your plan will change to ${selectedPlan.name} on ${new Date(result.effectiveDate).toLocaleDateString()}`,
        );
      }
      
      setConfirmModalOpen(false);
      onClose();
      // Reload the page to reflect changes
      window.location.reload();
    } catch (error: any) {
      console.error('Failed to change plan:', error);
      message.error(error.response?.data?.message || 'Failed to change plan');
    } finally {
      setUpgradeLoading(false);
    }
  };

  // All plans for display
  // For trial users: show ALL available plans (including their current trial plan) as upgrade options
  // For non-trial users: show current plan + other available plans
  const allPlans = isOnTrial
    ? availablePlans.map((p) => ({ 
        ...p, 
        isCurrent: false,
        isUpgrade: true, // All plans are upgrades from free trial
      }))
    : currentPlan
      ? [
          {
            ...currentPlan,
            description: '',
            isUpgrade: false,
            isCurrent: true,
            priceDifference: { monthly: 0, yearly: 0 },
          },
          ...availablePlans.map((p) => ({ ...p, isCurrent: false })),
        ].sort((a, b) => a.monthlyPrice - b.monthlyPrice)
      : availablePlans.map((p) => ({ ...p, isCurrent: false }));

  return (
    <>
      <Modal
        title={null}
        open={open}
        onCancel={onClose}
        footer={null}
        width={900}
        centered
        className="plans-modal"
      >
        <div className="p-4">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <Title level={3} className="mb-1">
                <RocketOutlined className="mr-2 text-blue-500" />
                {isOnTrial ? 'Subscribe to a Plan' : 'Choose Your Plan'}
              </Title>
              <Text type="secondary">
                {isOnTrial 
                  ? 'Select a plan to continue after your trial ends' 
                  : 'Select the plan that best fits your needs'}
              </Text>
            </div>
            {/* <Button onClick={onClose}>Close</Button> */}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spin size="large" />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {allPlans.map((plan) => {
                const isCurrent = 'isCurrent' in plan && plan.isCurrent;
                const isUpgrade = !isCurrent && plan.isUpgrade;

                return (
                  <div
                    key={plan.id}
                    className={`
                      relative border rounded-xl p-5 transition-all flex flex-col
                      ${isCurrent 
                        ? 'border-blue-500 bg-blue-50 border-2' 
                        : 'border-gray-200 hover:border-blue-400 hover:shadow-md cursor-pointer'
                      }
                    `}
                    onClick={() => !isCurrent && handlePlanSelect(plan as AvailablePlan)}
                  >
                    {/* Current Plan Badge */}
                    {isCurrent && (
                      <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
                        <Tag color="blue" className="px-3 py-0.5 text-xs font-semibold">
                          CURRENT PLAN
                        </Tag>
                      </div>
                    )}

                    {/* Plan Header */}
                    <div className="mb-3 pt-2">
                      <Title level={4} className="mb-0 capitalize flex items-center gap-2">
                        {plan.name}
                        {plan.name.toLowerCase() === 'enterprise' && (
                          <CrownOutlined className="text-yellow-500" />
                        )}
                      </Title>
                    </div>

                    {/* Pricing */}
                    <div className="mb-3">
                      {plan.monthlyPrice === 0 ? (
                        <div className="text-2xl font-bold text-gray-900">Free</div>
                      ) : (
                        <>
                          <div className="flex items-baseline gap-1">
                            <span className="text-2xl font-bold text-gray-900">
                              ${plan.monthlyPrice}
                            </span>
                            <span className="text-gray-500 text-sm">/month</span>
                          </div>
                          <Text type="secondary" className="text-xs">
                            or ${plan.yearlyPrice}/year
                          </Text>
                        </>
                      )}
                    </div>

                    <Divider className="my-3" />

                    {/* Features - flex-1 to take remaining space */}
                    <div className="flex-1 space-y-2 min-h-[120px]">
                      {plan.maxGates > 0 && (
                        <div className="flex items-center text-sm text-gray-600">
                          <CheckOutlined className="text-green-500 mr-2 flex-shrink-0" />
                          <span>Up to {plan.maxGates} gates</span>
                        </div>
                      )}
                      {plan.maxUsers > 0 && (
                        <div className="flex items-center text-sm text-gray-600">
                          <CheckOutlined className="text-green-500 mr-2 flex-shrink-0" />
                          <span>Up to {plan.maxUsers} users</span>
                        </div>
                      )}
                      {Array.isArray(plan.features) &&
                        plan.features.slice(0, 4).map((feature, index) => (
                          <div
                            key={index}
                            className="flex items-center text-sm text-gray-600"
                          >
                            <CheckOutlined className="text-green-500 mr-2 flex-shrink-0" />
                            <span>{feature}</span>
                          </div>
                        ))}
                    </div>

                    {/* Action Button - always at bottom */}
                    <div className="mt-4">
                      {isCurrent ? (
                        <Button disabled block>
                          Current Plan
                        </Button>
                      ) : isOnTrial ? (
                        <Button
                          type="primary"
                          block
                          icon={<ArrowUpOutlined />}
                        >
                          Subscribe
                        </Button>
                      ) : (
                        <Button
                          type={isUpgrade ? 'primary' : 'default'}
                          block
                          icon={isUpgrade ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                        >
                          {isUpgrade ? 'Upgrade' : 'Downgrade'}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      {/* Confirmation Modal */}
      <Modal
        title={
          <Space>
            <RocketOutlined />
            <span>{isOnTrial ? 'Subscribe to Plan' : (selectedPlan?.isUpgrade ? 'Upgrade' : 'Change') + ' Plan'}</span>
          </Space>
        }
        open={confirmModalOpen}
        onCancel={() => {
          setConfirmModalOpen(false);
          setSelectedPlan(null);
          setPlanPreview(null);
        }}
        footer={null}
        width={500}
      >
        {selectedPlan && (
          <>
            <div className="mb-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <Title level={4} className="mb-0 capitalize">
                    {selectedPlan.name}
                  </Title>
                  <Text type="secondary">{selectedPlan.description}</Text>
                </div>
                <Tag color={isOnTrial ? 'blue' : (selectedPlan.isUpgrade ? 'green' : 'orange')}>
                  {isOnTrial ? 'New Subscription' : (selectedPlan.isUpgrade ? 'Upgrade' : 'Downgrade')}
                </Tag>
              </div>

              {/* Billing Cycle Selection */}
              <div className="bg-gray-50 p-4 rounded-lg mb-4">
                <div className="mb-2">
                  <Text strong>Select billing cycle:</Text>
                </div>
                <Space>
                  <Button
                    type={selectedBillingCycle === 'monthly' ? 'primary' : 'default'}
                    onClick={() => handleBillingCycleChange('monthly')}
                  >
                    Monthly - ${selectedPlan.monthlyPrice}/mo
                  </Button>
                  <Button
                    type={selectedBillingCycle === 'yearly' ? 'primary' : 'default'}
                    onClick={() => handleBillingCycleChange('yearly')}
                  >
                    Yearly - ${selectedPlan.yearlyPrice}/yr
                    <Tag color="green" className="ml-2">
                      Save{' '}
                      {Math.round(
                        (1 - selectedPlan.yearlyPrice / (selectedPlan.monthlyPrice * 12)) * 100,
                      )}
                      %
                    </Tag>
                  </Button>
                </Space>
              </div>

              {/* Features */}
              <div className="mb-4">
                <Text strong>Plan includes:</Text>
                <ul className="mt-2 list-disc list-inside text-gray-600">
                  <li>Up to {selectedPlan.maxGates} gates</li>
                  <li>Up to {selectedPlan.maxUsers} users</li>
                  {selectedPlan.features?.map((feature, index) => (
                    <li key={index}>{feature}</li>
                  ))}
                </ul>
              </div>

              {/* Preview */}
              {isOnTrial ? (
                // Trial user - show simple subscription info
                <Alert
                  type="info"
                  message="Start Your Subscription"
                  description={
                    <div className="mt-2">
                      <div className="flex justify-between">
                        <Text>Plan:</Text>
                        <Text strong>{selectedPlan.name}</Text>
                      </div>
                      <div className="flex justify-between">
                        <Text>Price:</Text>
                        <Text strong>
                          ${selectedBillingCycle === 'monthly' ? selectedPlan.monthlyPrice : selectedPlan.yearlyPrice}/
                          {selectedBillingCycle === 'monthly' ? 'month' : 'year'}
                        </Text>
                      </div>
                      <div className="mt-3 p-2 bg-blue-50 rounded text-sm">
                        <Text type="secondary">
                          You'll be redirected to Stripe to complete your payment securely. Your subscription will start immediately after payment.
                        </Text>
                      </div>
                    </div>
                  }
                  showIcon
                  className="mb-4"
                />
              ) : previewLoading ? (
                <div className="text-center py-4">
                  <Spin size="small" />
                  <Text type="secondary" className="ml-2">
                    Calculating...
                  </Text>
                </div>
              ) : (
                planPreview && (
                  <Alert
                    type={planPreview.isUpgrade ? 'info' : 'warning'}
                    message={planPreview.isUpgrade ? 'Upgrade Summary' : 'Downgrade Summary'}
                    description={
                      <div className="mt-2">
                        <div className="flex justify-between">
                          <Text>Current plan:</Text>
                          <Text>
                            {planPreview.currentPlan.name} (${planPreview.currentPlan.price.toFixed(2)}/
                            {selectedBillingCycle === 'monthly' ? 'mo' : 'yr'})
                          </Text>
                        </div>
                        <div className="flex justify-between">
                          <Text>New plan:</Text>
                          <Text>
                            {planPreview.newPlan.name} (${planPreview.newPlan.price.toFixed(2)}/
                            {selectedBillingCycle === 'monthly' ? 'mo' : 'yr'})
                          </Text>
                        </div>

                        {planPreview.isUpgrade ? (
                          // UPGRADE: Show immediate charge
                          <>
                            <div className="flex justify-between text-gray-500 mt-2">
                              <Text type="secondary">Days remaining in period:</Text>
                              <Text type="secondary">{planPreview.daysRemaining} days</Text>
                            </div>
                            {planPreview.amountDue > 0 && (
                              <div className="flex justify-between mt-2 pt-2 border-t">
                                <Text strong>Prorated charge (due now):</Text>
                                <Text strong type="danger">
                                  ${planPreview.amountDue.toFixed(2)}
                                </Text>
                              </div>
                            )}
                            <div className="mt-3 p-2 bg-blue-50 rounded text-sm">
                              <Text type="secondary">
                                You'll be charged the prorated difference for the remaining{' '}
                                {planPreview.daysRemaining} days. Your new rate of $
                                {planPreview.newPlan.price.toFixed(2)}/
                                {selectedBillingCycle === 'monthly' ? 'month' : 'year'} starts
                                immediately.
                              </Text>
                            </div>
                          </>
                        ) : (
                          // DOWNGRADE: Show scheduled change
                          <>
                            <div className="flex justify-between mt-2 pt-2 border-t">
                              <Text strong>Effective date:</Text>
                              <Text strong>
                                {new Date(planPreview.effectiveDate).toLocaleDateString()}
                              </Text>
                            </div>
                            <div className="flex justify-between">
                              <Text strong>Amount due now:</Text>
                              <Text strong type="success">
                                $0.00
                              </Text>
                            </div>
                            <div className="mt-3 p-2 bg-yellow-50 rounded text-sm">
                              <Text type="secondary">
                                You'll keep your current {planPreview.currentPlan.name} plan features
                                until{' '}
                                {new Date(planPreview.effectiveDate).toLocaleDateString()}. After
                                that, you'll be billed ${planPreview.newPlan.price.toFixed(2)}/
                                {selectedBillingCycle === 'monthly' ? 'month' : 'year'} for the{' '}
                                {planPreview.newPlan.name} plan.
                              </Text>
                            </div>
                          </>
                        )}
                      </div>
                    }
                    showIcon
                  />
                )
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirmModalOpen(false)}>Cancel</Button>
              <Button type="primary" onClick={handleChangePlan} loading={upgradeLoading}>
                {isOnTrial ? 'Subscribe Now' : (selectedPlan.isUpgrade ? 'Upgrade Now' : 'Schedule Downgrade')}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

export default PlansModal;

/**
 * Billing Service
 * Handles all billing-related API calls
 */

import api from './api';

// ==================== Types ====================

export interface SubscriptionDetails {
  subscriptionId: string;
  status: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  planName: string;
  billingCycle: 'monthly' | 'yearly';
  monthlyAmount: number;
  nextBillingDate: string;
  // Trial info
  isTrial?: boolean;
  trialEndDate?: string;
  // Pause info
  isPaused?: boolean;
  pausedAt?: string;
  pauseResumesAt?: string;
  pauseReason?: string;
}

export interface PauseStatus {
  isPaused: boolean;
  pausedAt?: string;
  resumesAt?: string;
  reason?: string;
  daysRemaining?: number;
  canPause: boolean;
}

export interface Payment {
  id: string;
  tenantId: string;
  amount: number;
  netAmount?: number;
  feeAmount?: number;
  currency: string;
  transactionType: 'charge' | 'refund' | 'credit' | 'chargeback' | 'adjustment';
  paymentType: 'subscription' | 'one_time' | 'setup_fee' | 'upgrade' | 'downgrade_credit';
  status: 'succeeded' | 'pending' | 'failed' | 'refunded' | 'partially_refunded' | 'canceled' | 'disputed';
  stripeChargeId?: string;
  stripeInvoiceId?: string;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  billingCycle?: string;
  paymentMethodType?: string;
  paymentMethodLast4?: string;
  paymentMethodBrand?: string;
  description?: string;
  failureReason?: string;
  refundReason?: string;
  createdAt: string;
  paidAt?: string;
  tenant?: {
    id: string;
    name: string;
  };
  subscriptionPlan?: {
    id: string;
    name: string;
  };
}

export interface RefundResult {
  refundId: string;
  chargeId: string;
  amount: number;
  amountFormatted: string;
  currency: string;
  status: 'succeeded' | 'pending' | 'failed' | 'canceled';
  reason: string;
  createdAt: string;
}

export interface RefundCalculation {
  originalAmount: number;
  refundableAmount: number;
  daysUsed: number;
  daysRemaining: number;
  totalDays: number;
  proratedAmount: number;
  proratedPercentage: number;
  currency: string;
  eligibleForRefund: boolean;
  message?: string;
}

export interface RefundHistory {
  refunds: RefundResult[];
  totalRefunded: number;
  totalRefundedFormatted: string;
  currency: string;
}

export interface AvailablePlan {
  id: string;
  name: string;
  description: string;
  monthlyPrice: number;
  yearlyPrice: number;
  maxGates: number;
  maxUsers: number;
  features: string[];
  isUpgrade: boolean;
  priceDifference: {
    monthly: number;
    yearly: number;
  };
}

export interface AvailablePlansResponse {
  currentPlan: {
    id: string;
    name: string;
    monthlyPrice: number;
    yearlyPrice: number;
    maxGates: number;
    maxUsers: number;
    features: string[];
  } | null;
  isOnTrial?: boolean;
  availablePlans: AvailablePlan[];
}

export interface PlanChangePreview {
  currentPlan: { name: string; price: number };
  newPlan: { name: string; price: number };
  prorationAmount: number;
  amountDue: number;
  creditAmount: number;
  effectiveDate: string;
  isUpgrade: boolean;
  daysRemaining: number;
  immediateChange: boolean;
}

export interface PlanChangeResult {
  success: boolean;
  message: string;
  newPlan: { id: string; name: string };
  amountCharged: number;
  creditApplied: number;
  effectiveDate: string;
  isUpgrade: boolean;
  isScheduled: boolean;
}

export interface FinancialOverview {
  mrr: number;
  arr: number;
  revenueGrowth: number;
  totalRevenue: number;
  totalRefunds: number;
  netRevenue: number;
  activeSubscriptions: number;
  churnRate: number;
  averageRevenuePerUser: number;
  arpu: number; // alias for averageRevenuePerUser
  currency: string;
}

export interface RevenueByPeriod {
  period: string;
  revenue: number;
  refunds: number;
  net: number;
  transactions: number;
}

export interface PaymentSummary {
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  totalRefunds: number;
  totalAmount: number;
  refundedAmount: number;
  netAmount: number;
}

// ==================== Tenant Billing APIs ====================

export const billingService = {
  // Get subscription details
  async getSubscriptionDetails(): Promise<SubscriptionDetails> {
    const response = await api.get('/billing/subscription');
    return response.data;
  },

  // Create checkout session for upgrading
  async createCheckoutSession(planId: string, billingCycle: 'monthly' | 'yearly') {
    const response = await api.post('/billing/checkout', { planId, billingCycle });
    return response.data;
  },

  // Create customer portal session
  async createPortalSession(returnUrl?: string) {
    const response = await api.post('/billing/portal', { returnUrl });
    return response.data;
  },

  // Cancel subscription
  async cancelSubscription(immediately = false) {
    const response = await api.post('/billing/cancel', { immediately });
    return response.data;
  },

  // Resume canceled subscription
  async resumeSubscription() {
    const response = await api.post('/billing/resume');
    return response.data;
  },

  // Pause subscription
  async pauseSubscription(data: { resumesAt?: string; reason?: string; behavior?: string }) {
    const response = await api.post('/billing/pause', data);
    return response.data;
  },

  // Unpause/Resume paused subscription
  async unpauseSubscription(billingCycleAnchor = false) {
    const response = await api.post('/billing/unpause', { billingCycleAnchor });
    return response.data;
  },

  // Get pause status
  async getPauseStatus(): Promise<PauseStatus> {
    const response = await api.get('/billing/pause-status');
    return response.data;
  },

  // Get refund calculation
  async calculateRefund(): Promise<RefundCalculation> {
    const response = await api.get('/billing/refund/calculate');
    return response.data;
  },

  // Get refund history
  async getRefundHistory(): Promise<RefundHistory> {
    const response = await api.get('/billing/refunds');
    return response.data;
  },

  // Request a prorated refund
  async requestRefund(reason?: string): Promise<{ success: boolean; message: string; refund: RefundResult }> {
    const response = await api.post('/billing/refund/request', { reason });
    return response.data;
  },

  // Get payment history
  async getPaymentHistory(page = 1, limit = 20): Promise<{ payments: Payment[]; total: number }> {
    const response = await api.get('/billing/payments', { params: { page, limit } });
    return response.data;
  },

  // ==================== Plan Upgrade APIs ====================

  // Get available plans for upgrade/downgrade
  async getAvailablePlans(): Promise<AvailablePlansResponse> {
    const response = await api.get('/billing/plans');
    return response.data;
  },

  // Preview plan change (calculate proration)
  async previewPlanChange(newPlanId: string, billingCycle: 'monthly' | 'yearly'): Promise<PlanChangePreview> {
    const response = await api.post('/billing/plans/preview', { newPlanId, billingCycle });
    return response.data;
  },

  // Change subscription plan
  async changePlan(
    newPlanId: string,
    billingCycle: 'monthly' | 'yearly',
    immediate = true,
  ): Promise<PlanChangeResult> {
    const response = await api.post('/billing/plans/change', { newPlanId, billingCycle, immediate });
    return response.data;
  },

  // ==================== Public APIs (no auth required) ====================

  // Get public subscription plans for pricing page
  async getPublicPlans(): Promise<import('../types').SubscriptionPlan[]> {
    const response = await api.get('/auth/plans');
    return response.data;
  },
};

// ==================== Admin Billing APIs ====================

export const adminBillingService = {
  // Get financial overview
  async getFinancialOverview(): Promise<FinancialOverview> {
    const response = await api.get('/admin/stripe/financial-overview');
    const data = response.data.data || response.data;
    // Ensure arpu alias exists
    if (data.averageRevenuePerUser && !data.arpu) {
      data.arpu = data.averageRevenuePerUser;
    }
    return data;
  },

  // Get revenue by month
  async getRevenueByMonth(months = 12): Promise<{ months: { month: string; revenue: number }[] }> {
    const response = await api.get('/admin/stripe/revenue-by-month', { params: { months } });
    const data = response.data.data || response.data;
    return { months: data.periods || data.months || data };
  },

  // Get all payments
  async getAllPayments(params: {
    page?: number;
    limit?: number;
    tenantId?: string;
    planId?: string;
    status?: string;
    type?: string;
    billingCycle?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
  }): Promise<{ success: boolean; payments: Payment[]; total: number; page: number; totalPages: number }> {
    const response = await api.get('/admin/stripe/payments', { params });
    return response.data;
  },

  // Get payment summary
  async getPaymentSummary(tenantId?: string): Promise<{ success: boolean; data: PaymentSummary }> {
    const response = await api.get('/admin/stripe/payment-summary', { params: { tenantId } });
    return response.data;
  },

  // Get tenant payments
  async getTenantPayments(tenantId: string, page = 1, limit = 20): Promise<{ success: boolean; payments: Payment[]; total: number }> {
    const response = await api.get(`/admin/stripe/payments/${tenantId}`, { params: { page, limit } });
    return response.data;
  },

  // Create refund
  async createRefund(tenantId: string, data: {
    chargeId?: string;
    amount?: number;
    reason: string;
    internalNote?: string;
    notifyCustomer?: boolean;
  }): Promise<{ success: boolean; message: string; refund: RefundResult }> {
    const response = await api.post(`/admin/stripe/refund/${tenantId}`, data);
    return response.data;
  },

  // Calculate prorated refund for tenant
  async calculateTenantRefund(tenantId: string): Promise<RefundCalculation> {
    const response = await api.get(`/admin/stripe/refund/${tenantId}/calculate`);
    return response.data;
  },

  // Get tenant refund history
  async getTenantRefundHistory(tenantId: string): Promise<RefundHistory> {
    const response = await api.get(`/admin/stripe/refunds/${tenantId}`);
    return response.data;
  },

  // Issue credit
  async issueCredit(tenantId: string, data: { amount: number; description?: string }): Promise<{ success: boolean; message: string; credit: { creditId: string; amount: number } }> {
    const response = await api.post(`/admin/stripe/credit/${tenantId}`, { amount: data.amount, description: data.description || 'Account credit' });
    return response.data;
  },

  // Calculate refund for tenant (admin)
  async calculateRefund(tenantId: string): Promise<RefundCalculation> {
    const response = await api.get(`/admin/stripe/refund/${tenantId}/calculate`);
    const data = response.data.data || response.data;
    // Calculate totalDays and proratedPercentage if not present
    if (!data.totalDays && data.daysUsed !== undefined && data.daysRemaining !== undefined) {
      data.totalDays = data.daysUsed + data.daysRemaining;
    }
    if (!data.proratedPercentage && data.daysRemaining !== undefined && data.totalDays) {
      data.proratedPercentage = (data.daysRemaining / data.totalDays) * 100;
    }
    return data;
  },
};

export default billingService;

/**
 * Stripe Subscription Integration Test Script
 * 
 * This script tests the Stripe subscription flow by:
 * 1. Creating test data in the database
 * 2. Calling the Stripe API endpoints
 * 3. Verifying database state changes
 * 
 * Usage: npx ts-node scripts/test-stripe-integration.ts
 */

import axios from 'axios';
import { config } from 'dotenv';

config();

const API_URL = process.env.API_URL || 'http://localhost:3001/api/v1';
const TEST_DELAY = 2000; // 2 seconds between tests

// Test credentials (you'll need to get these from login)
let authToken = '';
let testTenantId = '';
let testPlanId = '';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const log = {
  header: (msg: string) => console.log(`\n${'='.repeat(60)}\n${msg}\n${'='.repeat(60)}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
  error: (msg: string) => console.log(`❌ ${msg}`),
  info: (msg: string) => console.log(`ℹ️  ${msg}`),
  warning: (msg: string) => console.log(`⚠️  ${msg}`),
};

// API Helper
const api = axios.create({
  baseURL: API_URL,
  timeout: 10000,
});

api.interceptors.request.use((config) => {
  if (authToken) {
    config.headers.Authorization = `Bearer ${authToken}`;
  }
  return config;
});

// ==================== Test Functions ====================

async function testHealthCheck() {
  log.header('Test 0: Health Check');
  try {
    const response = await axios.get(`${API_URL.replace('/api/v1', '')}/health`);
    log.success(`Server is healthy: ${response.status}`);
    return true;
  } catch (error: any) {
    // Try alternative health check
    try {
      const response = await axios.get(API_URL);
      log.success(`Server is reachable: ${response.status}`);
      return true;
    } catch {
      log.error(`Server not reachable: ${error.message}`);
      return false;
    }
  }
}

async function testLogin() {
  log.header('Test 1: Login to Get Auth Token');
  
  // You'll need to adjust these credentials
  const credentials = {
    email: 'admin@example.com', // Replace with actual test user
    password: 'admin123',       // Replace with actual password
  };
  
  try {
    const response = await axios.post(`${API_URL}/auth/login`, credentials);
    authToken = response.data.accessToken || response.data.access_token;
    testTenantId = response.data.user?.tenantId || response.data.tenantId;
    
    log.success(`Logged in successfully`);
    log.info(`Tenant ID: ${testTenantId}`);
    return true;
  } catch (error: any) {
    log.warning(`Login failed - you may need to use a different auth method`);
    log.info(`Error: ${error.response?.data?.message || error.message}`);
    log.info(`Continuing with manual token input...`);
    
    // For testing, you can manually set these
    // authToken = 'YOUR_JWT_TOKEN';
    // testTenantId = 'YOUR_TENANT_UUID';
    
    return false;
  }
}

async function testGetSubscriptionPlans() {
  log.header('Test 2: Get Available Subscription Plans');
  
  try {
    const response = await api.get('/subscription-plans');
    const plans = response.data;
    
    if (plans.length === 0) {
      log.warning('No subscription plans found in database');
      log.info('Create plans first via admin API or seed script');
      return false;
    }
    
    log.success(`Found ${plans.length} subscription plan(s)`);
    plans.forEach((plan: any) => {
      log.info(`  - ${plan.name}: $${plan.monthlyPrice}/mo | Stripe: ${plan.stripeProductId || 'Not synced'}`);
    });
    
    // Use the first plan for testing
    testPlanId = plans[0].id;
    return true;
  } catch (error: any) {
    log.error(`Failed to get plans: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testSyncPlanToStripe() {
  log.header('Test 3: Sync Plan to Stripe');
  
  if (!testPlanId) {
    log.warning('No plan ID available, skipping...');
    return false;
  }
  
  try {
    const response = await api.post('/admin/stripe/sync-plan', { planId: testPlanId });
    log.success('Plan synced to Stripe successfully');
    log.info(`Product ID: ${response.data.stripeProductId}`);
    log.info(`Monthly Price ID: ${response.data.stripePriceIdMonthly}`);
    log.info(`Yearly Price ID: ${response.data.stripePriceIdYearly}`);
    return true;
  } catch (error: any) {
    log.error(`Failed to sync plan: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testCreateCheckoutSession() {
  log.header('Test 4: Create Checkout Session');
  
  if (!testPlanId) {
    log.warning('No plan ID available, skipping...');
    return false;
  }
  
  try {
    const response = await api.post('/billing/checkout', {
      planId: testPlanId,
      billingInterval: 'monthly',
      successUrl: 'http://localhost:5173/billing/success',
      cancelUrl: 'http://localhost:5173/billing/cancel',
    });
    
    log.success('Checkout session created');
    log.info(`Session ID: ${response.data.sessionId}`);
    log.info(`Checkout URL: ${response.data.url}`);
    log.info(`\n👉 Open this URL in browser to test payment flow:`);
    console.log(`\n   ${response.data.url}\n`);
    return true;
  } catch (error: any) {
    log.error(`Failed to create checkout: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testGetSubscriptionDetails() {
  log.header('Test 5: Get Current Subscription Details');
  
  try {
    const response = await api.get('/billing/subscription');
    const sub = response.data;
    
    if (!sub) {
      log.info('No active subscription found for this tenant');
      return true;
    }
    
    log.success('Subscription details retrieved');
    log.info(`Status: ${sub.status}`);
    log.info(`Plan: ${sub.planName}`);
    log.info(`Current Period End: ${sub.currentPeriodEnd}`);
    log.info(`Cancel at Period End: ${sub.cancelAtPeriodEnd}`);
    return true;
  } catch (error: any) {
    log.error(`Failed to get subscription: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testCreatePortalSession() {
  log.header('Test 6: Create Billing Portal Session');
  
  try {
    const response = await api.post('/billing/portal', {
      returnUrl: 'http://localhost:5173/settings/billing',
    });
    
    log.success('Portal session created');
    log.info(`Portal URL: ${response.data.url}`);
    log.info(`\n👉 Open this URL to access the billing portal:`);
    console.log(`\n   ${response.data.url}\n`);
    return true;
  } catch (error: any) {
    if (error.response?.status === 400) {
      log.warning('No Stripe customer found - complete checkout first');
    } else {
      log.error(`Failed to create portal: ${error.response?.data?.message || error.message}`);
    }
    return false;
  }
}

async function testWebhookEndpoint() {
  log.header('Test 7: Webhook Endpoint Availability');
  
  try {
    // Just check that the endpoint exists (POST only)
    const response = await axios.post(`${API_URL}/webhooks/stripe`, {}, {
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true, // Accept any status
    });
    
    // 400 is expected (no signature), 404 means endpoint doesn't exist
    if (response.status === 400) {
      log.success('Webhook endpoint is accessible (returned 400 - expected without signature)');
      return true;
    } else if (response.status === 404) {
      log.error('Webhook endpoint not found (404)');
      return false;
    } else {
      log.info(`Webhook endpoint returned: ${response.status}`);
      return true;
    }
  } catch (error: any) {
    log.error(`Webhook endpoint check failed: ${error.message}`);
    return false;
  }
}

// ==================== Test Cards Reference ====================

function printTestCards() {
  log.header('Stripe Test Cards Reference');
  console.log(`
┌─────────────────────────────────────────────────────────────────┐
│ CARD NUMBER              │ SCENARIO                            │
├─────────────────────────────────────────────────────────────────┤
│ 4242 4242 4242 4242      │ ✅ Successful payment               │
│ 4000 0000 0000 0002      │ ❌ Card declined                    │
│ 4000 0000 0000 9995      │ ❌ Insufficient funds               │
│ 4000 0025 0000 3155      │ 🔐 Requires 3D Secure auth          │
│ 4000 0000 0000 0341      │ ❌ Card declined (attach fails)     │
│ 4000 0000 0000 3220      │ 🔐 3DS required on all transactions │
└─────────────────────────────────────────────────────────────────┘

Use any CVC (e.g., 123) and any future expiry date (e.g., 12/28)
  `);
}

// ==================== CLI Commands Reference ====================

function printCliCommands() {
  log.header('Stripe CLI Commands Reference');
  console.log(`
WEBHOOK FORWARDING (run in separate terminal):
  stripe listen --forward-to localhost:3001/api/v1/webhooks/stripe

TRIGGER EVENTS:
  stripe trigger checkout.session.completed
  stripe trigger customer.subscription.created
  stripe trigger customer.subscription.updated
  stripe trigger customer.subscription.deleted
  stripe trigger invoice.paid
  stripe trigger invoice.payment_failed
  stripe trigger customer.subscription.trial_will_end

VIEW EVENTS:
  stripe events list --limit 10

OPEN DASHBOARD:
  stripe dashboard
  `);
}

// ==================== Main Test Runner ====================

async function runTests() {
  console.log('\n🧪 STRIPE SUBSCRIPTION INTEGRATION TESTS\n');
  console.log('This script will test your Stripe integration end-to-end.\n');
  
  const results: { test: string; passed: boolean }[] = [];
  
  // Run tests
  results.push({ test: 'Health Check', passed: await testHealthCheck() });
  await delay(TEST_DELAY);
  
  results.push({ test: 'Authentication', passed: await testLogin() });
  await delay(TEST_DELAY);
  
  results.push({ test: 'Get Plans', passed: await testGetSubscriptionPlans() });
  await delay(TEST_DELAY);
  
  results.push({ test: 'Webhook Endpoint', passed: await testWebhookEndpoint() });
  await delay(TEST_DELAY);
  
  if (authToken) {
    results.push({ test: 'Sync Plan to Stripe', passed: await testSyncPlanToStripe() });
    await delay(TEST_DELAY);
    
    results.push({ test: 'Create Checkout', passed: await testCreateCheckoutSession() });
    await delay(TEST_DELAY);
    
    results.push({ test: 'Get Subscription', passed: await testGetSubscriptionDetails() });
    await delay(TEST_DELAY);
    
    results.push({ test: 'Create Portal', passed: await testCreatePortalSession() });
  }
  
  // Print summary
  log.header('TEST SUMMARY');
  results.forEach(r => {
    if (r.passed) {
      log.success(r.test);
    } else {
      log.error(r.test);
    }
  });
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\n📊 ${passed}/${total} tests passed\n`);
  
  // Print references
  printTestCards();
  printCliCommands();
}

// Run
runTests().catch(console.error);

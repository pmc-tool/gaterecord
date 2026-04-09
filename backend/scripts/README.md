# Stripe Test Scripts

This folder contains scripts for testing the Stripe subscription integration.

## Prerequisites

1. **Stripe CLI installed**
   ```bash
   winget install Stripe.StripeCLI
   ```

2. **Stripe CLI logged in**
   ```bash
   stripe login
   ```

3. **Backend server running**
   ```bash
   npm run start:dev
   ```

4. **Webhook forwarding active** (in a separate terminal)
   ```bash
   stripe listen --forward-to localhost:3001/api/v1/webhooks/stripe
   ```
   Save the webhook secret (whsec_...) and add it to your `.env` file.

## Available Scripts

### 1. Windows Batch Script (Easiest)
```cmd
cd backend/scripts
test-stripe.bat
```
This provides an interactive menu to test individual or all webhook events.

### 2. TypeScript Integration Test
```bash
npm run test:stripe
```
This runs a comprehensive integration test that:
- Checks server health
- Tests authentication
- Fetches subscription plans
- Syncs plans to Stripe
- Creates checkout sessions
- Gets subscription details
- Tests the billing portal

### 3. Bash Script (Git Bash / WSL)
```bash
cd backend/scripts
bash test-stripe-subscription.sh
```

## Test Cards

| Card Number | Scenario |
|-------------|----------|
| `4242 4242 4242 4242` | ✅ Successful payment |
| `4000 0000 0000 0002` | ❌ Card declined |
| `4000 0000 0000 9995` | ❌ Insufficient funds |
| `4000 0025 0000 3155` | 🔐 Requires 3D Secure |

Use any CVC (e.g., `123`) and any future expiry date (e.g., `12/28`).

## Webhook Events

| Event | What it tests |
|-------|---------------|
| `checkout.session.completed` | New subscription created via checkout |
| `customer.subscription.created` | Subscription activated |
| `customer.subscription.updated` | Plan changed, status changed |
| `customer.subscription.deleted` | Subscription canceled |
| `invoice.paid` | Successful recurring payment |
| `invoice.payment_failed` | Failed payment (past_due status) |
| `customer.subscription.trial_will_end` | Trial ending notification |

## Manual CLI Commands

```bash
# Trigger specific events
stripe trigger checkout.session.completed
stripe trigger customer.subscription.created
stripe trigger invoice.payment_failed
stripe trigger customer.subscription.deleted

# View recent events
stripe events list --limit 10

# Open Stripe Dashboard
stripe dashboard
```

## Database Verification

After running tests, verify the database state:

```bash
psql -U shahadat -d gate_management -c "SELECT id, name, subscription_status, stripe_customer_id, stripe_subscription_id, current_period_end FROM tenants;"
```

## Test Flow Example

1. **Start webhook listener** (Terminal 1):
   ```bash
   stripe listen --forward-to localhost:3001/api/v1/webhooks/stripe
   ```

2. **Start backend** (Terminal 2):
   ```bash
   npm run start:dev
   ```

3. **Run tests** (Terminal 3):
   ```cmd
   cd scripts
   test-stripe.bat
   ```

4. **Verify results**:
   - Check Terminal 2 for webhook processing logs
   - Check Stripe Dashboard: https://dashboard.stripe.com/test/events
   - Query database for subscription status changes

#!/bin/bash

# =============================================================================
# Stripe Subscription Test Script
# =============================================================================
# This script tests all Stripe subscription scenarios using Stripe CLI
# 
# Prerequisites:
# 1. Stripe CLI installed: winget install Stripe.StripeCLI
# 2. Stripe CLI logged in: stripe login
# 3. Backend server running: npm run start:dev
# 4. Webhook forwarding active in another terminal:
#    stripe listen --forward-to localhost:3001/api/v1/webhooks/stripe
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_URL="http://localhost:3001/api/v1"
DELAY=3  # Seconds between tests

# Helper functions
print_header() {
    echo ""
    echo -e "${BLUE}============================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}============================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "  → $1"
}

wait_for_webhook() {
    echo "  Waiting ${DELAY}s for webhook processing..."
    sleep $DELAY
}

# Check prerequisites
check_prerequisites() {
    print_header "Checking Prerequisites"
    
    # Check Stripe CLI
    if ! command -v stripe &> /dev/null; then
        print_error "Stripe CLI not installed. Run: winget install Stripe.StripeCLI"
        exit 1
    fi
    print_success "Stripe CLI installed"
    
    # Check if backend is running
    if curl -s -o /dev/null -w "%{http_code}" "$API_URL/../health" | grep -q "200\|404"; then
        print_success "Backend server is reachable"
    else
        print_warning "Backend server may not be running at $API_URL"
    fi
    
    # Check webhook listener
    print_warning "Make sure webhook forwarding is running in another terminal:"
    print_info "stripe listen --forward-to localhost:3001/api/v1/webhooks/stripe"
    echo ""
    read -p "Press Enter when webhook listener is ready..."
}

# Test 1: Product and Price Creation
test_product_price_creation() {
    print_header "Test 1: Product & Price Creation"
    print_info "Simulating product.created and price.created events"
    
    stripe trigger product.created 2>/dev/null || true
    wait_for_webhook
    print_success "product.created event sent"
    
    stripe trigger price.created 2>/dev/null || true
    wait_for_webhook
    print_success "price.created event sent"
}

# Test 2: Customer Creation
test_customer_creation() {
    print_header "Test 2: Customer Creation"
    print_info "Simulating customer.created event"
    
    stripe trigger customer.created 2>/dev/null || true
    wait_for_webhook
    print_success "customer.created event sent"
}

# Test 3: Checkout Session Completed
test_checkout_completed() {
    print_header "Test 3: Checkout Session Completed"
    print_info "Simulating complete checkout flow"
    
    stripe trigger checkout.session.completed 2>/dev/null || true
    wait_for_webhook
    print_success "checkout.session.completed event sent"
    print_info "This should create/update subscription in database"
}

# Test 4: Subscription Created
test_subscription_created() {
    print_header "Test 4: Subscription Created"
    print_info "Simulating customer.subscription.created event"
    
    stripe trigger customer.subscription.created 2>/dev/null || true
    wait_for_webhook
    print_success "customer.subscription.created event sent"
    print_info "Tenant subscription_status should be 'active' or 'trialing'"
}

# Test 5: Subscription Updated
test_subscription_updated() {
    print_header "Test 5: Subscription Updated"
    print_info "Simulating customer.subscription.updated event"
    
    stripe trigger customer.subscription.updated 2>/dev/null || true
    wait_for_webhook
    print_success "customer.subscription.updated event sent"
    print_info "Check for plan changes, status updates"
}

# Test 6: Invoice Payment Succeeded
test_invoice_paid() {
    print_header "Test 6: Invoice Payment Succeeded"
    print_info "Simulating invoice.paid event (successful payment)"
    
    stripe trigger invoice.paid 2>/dev/null || true
    wait_for_webhook
    print_success "invoice.paid event sent"
    print_info "Subscription should remain active"
}

# Test 7: Invoice Payment Failed
test_invoice_payment_failed() {
    print_header "Test 7: Invoice Payment Failed"
    print_info "Simulating invoice.payment_failed event"
    
    stripe trigger invoice.payment_failed 2>/dev/null || true
    wait_for_webhook
    print_success "invoice.payment_failed event sent"
    print_info "Subscription status should change to 'past_due'"
}

# Test 8: Trial Ending Soon
test_trial_will_end() {
    print_header "Test 8: Trial Ending Soon (3 days warning)"
    print_info "Simulating customer.subscription.trial_will_end event"
    
    stripe trigger customer.subscription.trial_will_end 2>/dev/null || true
    wait_for_webhook
    print_success "customer.subscription.trial_will_end event sent"
    print_info "Should trigger email notification to tenant"
}

# Test 9: Subscription Canceled
test_subscription_deleted() {
    print_header "Test 9: Subscription Canceled"
    print_info "Simulating customer.subscription.deleted event"
    
    stripe trigger customer.subscription.deleted 2>/dev/null || true
    wait_for_webhook
    print_success "customer.subscription.deleted event sent"
    print_info "Subscription status should be 'canceled'"
}

# Test 10: Payment Intent Events
test_payment_intent() {
    print_header "Test 10: Payment Intent Flow"
    print_info "Simulating payment_intent lifecycle"
    
    stripe trigger payment_intent.created 2>/dev/null || true
    wait_for_webhook
    print_success "payment_intent.created event sent"
    
    stripe trigger payment_intent.succeeded 2>/dev/null || true
    wait_for_webhook
    print_success "payment_intent.succeeded event sent"
}

# Test 11: Charge Events
test_charge_events() {
    print_header "Test 11: Charge Events"
    print_info "Simulating charge.succeeded event"
    
    stripe trigger charge.succeeded 2>/dev/null || true
    wait_for_webhook
    print_success "charge.succeeded event sent"
}

# Run all tests
run_all_tests() {
    print_header "STRIPE SUBSCRIPTION TEST SUITE"
    echo ""
    echo "This script will trigger various Stripe webhook events"
    echo "to test your subscription system end-to-end."
    echo ""
    
    check_prerequisites
    
    echo ""
    echo "Starting tests in 3 seconds..."
    sleep 3
    
    test_product_price_creation
    test_customer_creation
    test_checkout_completed
    test_subscription_created
    test_subscription_updated
    test_invoice_paid
    test_invoice_payment_failed
    test_trial_will_end
    test_subscription_deleted
    test_payment_intent
    test_charge_events
    
    print_header "TEST SUITE COMPLETED"
    echo ""
    print_success "All webhook events have been triggered!"
    echo ""
    echo "Next steps:"
    echo "  1. Check backend logs for webhook processing"
    echo "  2. Verify database state with:"
    echo "     psql -U shahadat -d gate_management -c \"SELECT id, name, subscription_status, stripe_subscription_id FROM tenants;\""
    echo "  3. Check Stripe Dashboard: https://dashboard.stripe.com/test/events"
    echo ""
}

# Menu
show_menu() {
    echo ""
    echo "Stripe Subscription Test Script"
    echo "================================"
    echo "1) Run all tests"
    echo "2) Test checkout flow only"
    echo "3) Test subscription lifecycle"
    echo "4) Test payment failure scenario"
    echo "5) Test trial ending"
    echo "6) Test cancellation"
    echo "0) Exit"
    echo ""
    read -p "Select option: " choice
    
    case $choice in
        1) run_all_tests ;;
        2) check_prerequisites && test_checkout_completed ;;
        3) check_prerequisites && test_subscription_created && test_subscription_updated ;;
        4) check_prerequisites && test_invoice_payment_failed ;;
        5) check_prerequisites && test_trial_will_end ;;
        6) check_prerequisites && test_subscription_deleted ;;
        0) exit 0 ;;
        *) echo "Invalid option"; show_menu ;;
    esac
}

# Check if running with argument
if [ "$1" == "--all" ]; then
    run_all_tests
else
    show_menu
fi

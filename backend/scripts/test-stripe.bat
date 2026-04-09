@echo off
REM =============================================================================
REM Stripe Subscription Test Script for Windows
REM =============================================================================
REM Prerequisites:
REM 1. Stripe CLI installed: winget install Stripe.StripeCLI
REM 2. Stripe CLI logged in: stripe login
REM 3. Backend server running: npm run start:dev
REM 4. Webhook forwarding in another terminal:
REM    stripe listen --forward-to localhost:3001/api/v1/webhooks/stripe
REM =============================================================================

setlocal EnableDelayedExpansion

set "DELAY=3"

echo.
echo ============================================
echo    STRIPE SUBSCRIPTION TEST SUITE
echo ============================================
echo.
echo Make sure in another terminal you're running:
echo   stripe listen --forward-to localhost:3001/api/v1/webhooks/stripe
echo.
pause

:menu
echo.
echo ============================================
echo    SELECT TEST OPTION
echo ============================================
echo.
echo  1) Run ALL webhook tests
echo  2) Test checkout.session.completed
echo  3) Test subscription.created
echo  4) Test subscription.updated  
echo  5) Test invoice.paid (successful payment)
echo  6) Test invoice.payment_failed
echo  7) Test subscription.trial_will_end
echo  8) Test subscription.deleted (canceled)
echo  9) Full payment flow simulation
echo  0) Exit
echo.
set /p choice="Enter choice: "

if "%choice%"=="1" goto all_tests
if "%choice%"=="2" goto test_checkout
if "%choice%"=="3" goto test_sub_created
if "%choice%"=="4" goto test_sub_updated
if "%choice%"=="5" goto test_invoice_paid
if "%choice%"=="6" goto test_invoice_failed
if "%choice%"=="7" goto test_trial_end
if "%choice%"=="8" goto test_sub_deleted
if "%choice%"=="9" goto full_flow
if "%choice%"=="0" exit /b 0
goto menu

:all_tests
echo.
echo [1/11] Testing product.created...
stripe trigger product.created
timeout /t %DELAY% >nul

echo [2/11] Testing price.created...
stripe trigger price.created
timeout /t %DELAY% >nul

echo [3/11] Testing customer.created...
stripe trigger customer.created
timeout /t %DELAY% >nul

echo [4/11] Testing checkout.session.completed...
stripe trigger checkout.session.completed
timeout /t %DELAY% >nul

echo [5/11] Testing customer.subscription.created...
stripe trigger customer.subscription.created
timeout /t %DELAY% >nul

echo [6/11] Testing customer.subscription.updated...
stripe trigger customer.subscription.updated
timeout /t %DELAY% >nul

echo [7/11] Testing invoice.paid...
stripe trigger invoice.paid
timeout /t %DELAY% >nul

echo [8/11] Testing invoice.payment_failed...
stripe trigger invoice.payment_failed
timeout /t %DELAY% >nul

echo [9/11] Testing customer.subscription.trial_will_end...
stripe trigger customer.subscription.trial_will_end
timeout /t %DELAY% >nul

echo [10/11] Testing customer.subscription.deleted...
stripe trigger customer.subscription.deleted
timeout /t %DELAY% >nul

echo [11/11] Testing payment_intent.succeeded...
stripe trigger payment_intent.succeeded
timeout /t %DELAY% >nul

echo.
echo ============================================
echo    ALL TESTS COMPLETED!
echo ============================================
echo.
echo Check your backend logs for webhook processing.
echo Check Stripe Dashboard: https://dashboard.stripe.com/test/events
echo.
goto menu

:test_checkout
echo Testing checkout.session.completed...
stripe trigger checkout.session.completed
timeout /t %DELAY% >nul
echo Done!
goto menu

:test_sub_created
echo Testing customer.subscription.created...
stripe trigger customer.subscription.created
timeout /t %DELAY% >nul
echo Done!
goto menu

:test_sub_updated
echo Testing customer.subscription.updated...
stripe trigger customer.subscription.updated
timeout /t %DELAY% >nul
echo Done!
goto menu

:test_invoice_paid
echo Testing invoice.paid...
stripe trigger invoice.paid
timeout /t %DELAY% >nul
echo Done!
goto menu

:test_invoice_failed
echo Testing invoice.payment_failed...
stripe trigger invoice.payment_failed
timeout /t %DELAY% >nul
echo Done!
goto menu

:test_trial_end
echo Testing customer.subscription.trial_will_end...
stripe trigger customer.subscription.trial_will_end
timeout /t %DELAY% >nul
echo Done!
goto menu

:test_sub_deleted
echo Testing customer.subscription.deleted...
stripe trigger customer.subscription.deleted
timeout /t %DELAY% >nul
echo Done!
goto menu

:full_flow
echo.
echo ============================================
echo    FULL PAYMENT FLOW SIMULATION
echo ============================================
echo.
echo This simulates a complete subscription lifecycle:
echo   1. Customer signs up
echo   2. Completes checkout
echo   3. Subscription becomes active
echo   4. Gets billed monthly
echo   5. Eventually cancels
echo.
pause

echo [1/6] Customer created...
stripe trigger customer.created
timeout /t %DELAY% >nul

echo [2/6] Checkout completed (new subscription)...
stripe trigger checkout.session.completed
timeout /t %DELAY% >nul

echo [3/6] Subscription created and active...
stripe trigger customer.subscription.created
timeout /t %DELAY% >nul

echo [4/6] Monthly invoice paid...
stripe trigger invoice.paid
timeout /t %DELAY% >nul

echo [5/6] Simulating failed payment...
stripe trigger invoice.payment_failed
timeout /t %DELAY% >nul

echo [6/6] Customer cancels subscription...
stripe trigger customer.subscription.deleted
timeout /t %DELAY% >nul

echo.
echo Full flow completed!
echo.
goto menu

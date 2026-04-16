import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ShieldCheckIcon,
  DevicePhoneMobileIcon,
  ChartBarIcon,
  BoltIcon,
  CreditCardIcon,
  ClipboardDocumentListIcon,
  CheckIcon,
  Bars3Icon,
  XMarkIcon,
  PlayCircleIcon,
} from '@heroicons/react/24/outline';
import { StarIcon } from '@heroicons/react/24/solid';
import { billingService } from '../../services/billing.service';
import type { SubscriptionPlan } from '../../types';

const navigation = [
  { name: 'Features', href: '#features' },
  { name: 'How it Works', href: '#how-it-works' },
  { name: 'Pricing', href: '#pricing' },
  { name: 'Testimonials', href: '#testimonials' },
];

const features = [
  {
    name: 'RFID Access Control',
    description: 'Seamless entry with RFID cards for residents and vehicles. No more waiting at gates.',
    icon: CreditCardIcon,
  },
  {
    name: 'Real-time Monitoring',
    description: 'Track all gate activities in real-time. Get instant notifications for every entry and exit.',
    icon: ChartBarIcon,
  },
  {
    name: 'Mobile App Ready',
    description: 'Manage access from anywhere with our mobile-friendly dashboard. Control gates remotely.',
    icon: DevicePhoneMobileIcon,
  },
  {
    name: 'Lightning Fast',
    description: 'Sub-second gate response times. Your residents never wait.',
    icon: BoltIcon,
  },
  {
    name: 'Activity Records',
    description: 'Complete history of all gate access events. Track who entered, when, and through which gate.',
    icon: ClipboardDocumentListIcon,
  },
  {
    name: 'Enterprise Security',
    description: 'Bank-grade encryption and security protocols protect your data 24/7.',
    icon: ShieldCheckIcon,
  },
];

const steps = [
  {
    number: '01',
    title: 'Install Hardware',
    description: 'Cloud Plus TypeB dual-channel controller with RFID, QR code, and PIN support. Connects via HTTP/TCP protocols.',
    image: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&h=400&fit=crop',
  },
  {
    number: '02',
    title: 'Register Users',
    description: 'Add residents and vehicles through our intuitive dashboard. Bulk import supported.',
    image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=600&h=400&fit=crop',
  },
  {
    number: '03',
    title: 'Go Live',
    description: 'Your smart gate system is ready. Monitor access and manage permissions effortlessly.',
    image: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=600&h=400&fit=crop',
  },
];

const testimonials = [
  {
    content: "GateRecord transformed our community's security. The RFID system is incredibly reliable, and residents love the convenience. Best investment we've made.",
    author: 'Sarah Johnson',
    role: 'Property Manager',
    company: 'Skyline Residences',
    avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&h=100&fit=crop&crop=face',
    rating: 5,
  },
  {
    content: "We manage 15 buildings and GateRecord handles them all seamlessly. The multi-tenant feature is a game-changer. Support team is exceptional.",
    author: 'Michael Chen',
    role: 'Operations Director',
    company: 'Urban Living Properties',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=face',
    rating: 5,
  },
  {
    content: "Installation was surprisingly easy. The ESP32 hardware is rock solid, and the dashboard gives us complete visibility into all gate activities.",
    author: 'David Williams',
    role: 'Security Director',
    company: 'Coastal Communities',
    avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&h=100&fit=crop&crop=face',
    rating: 5,
  },
];

const stats = [
  { value: '50K+', label: 'Daily Access Events' },
  { value: '99.9%', label: 'Uptime Guaranteed' },
  { value: '500+', label: 'Buildings Served' },
  // { value: '<1s', label: 'Average Response Time' },
];

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [demoModalOpen, setDemoModalOpen] = useState(false);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);

  // Fetch subscription plans on mount
  useEffect(() => {
    const fetchPlans = async () => {
      try {
        const data = await billingService.getPublicPlans();
        // Filter to only show public plans and sort by display order
        const publicPlans = data
          .filter((p) => p.isPublic !== false)
          .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
        setPlans(publicPlans);
      } catch (error) {
        console.error('Failed to fetch plans:', error);
      } finally {
        setLoadingPlans(false);
      }
    };
    fetchPlans();
  }, []);

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!demoModalOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDemoModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleEscape);
    };
  }, [demoModalOpen]);

  // Transform plans for display
  const pricing = useMemo(() => {
    return plans.map((plan) => {
      // Build features array from plan data
      const features: string[] = [];

      // Add limit-based features
      if (plan.maxUsers >= 10000 || plan.maxUsers === -1) {
        features.push('Unlimited residents');
      } else {
        features.push(`Up to ${plan.maxUsers} residents`);
      }

      if (plan.maxGates >= 1000 || plan.maxGates === -1) {
        features.push('Unlimited gates');
      } else {
        features.push(`${plan.maxGates} gates`);
      }

      // Standard features
      features.push('RFID access control');
      features.push('Real-time monitoring');

      // Feature flags
      if (plan.features?.advanced_analytics) features.push('Advanced analytics');
      if (plan.features?.priority_support) features.push('Priority support');
      if (plan.features?.api_access) features.push('API access');
      if (plan.features?.custom_branding) features.push('White-label option');
      if (plan.features?.multi_building) features.push('Multi-building support');

      // Log retention
      if (plan.logRetentionDays >= 3650 || plan.logRetentionDays === -1) {
        features.push('Unlimited history');
      } else if (plan.logRetentionDays >= 365) {
        features.push(`${Math.floor(plan.logRetentionDays / 365)}-year event history`);
      } else {
        features.push(`${plan.logRetentionDays}-day event history`);
      }

      // Visitor management for higher plans
      if ((plan.maxVisitorPassesPerMonth || 0) > 50) {
        features.push('Visitor management');
      }

      const isCustomPrice = plan.monthlyPrice === 0 && plan.name.toLowerCase().includes('enterprise');

      // Calculate discounted price
      const now = new Date();
      const originalPrice = plan.monthlyPrice;
      const discountPercent = plan.discountPercent || 0;
      const discountValidUntil = plan.discountValidUntil ? new Date(plan.discountValidUntil) : null;
      const isDiscountActive =
        discountPercent > 0 &&
        (!discountValidUntil || !Number.isNaN(discountValidUntil.getTime())) &&
        (!discountValidUntil || discountValidUntil >= now);
      const discountedPrice = isDiscountActive
        ? originalPrice * (1 - discountPercent / 100) 
        : originalPrice;
      const hasDiscount = isDiscountActive;

      return {
        id: plan.id,
        name: plan.name,
        price: isCustomPrice ? 'Custom' : String(Math.round(discountedPrice)),
        originalPrice: isCustomPrice ? null : (hasDiscount ? String(Math.round(originalPrice)) : null),
        discountPercent: hasDiscount ? discountPercent : null,
        discountLabel: hasDiscount ? (plan.discountLabel || `${discountPercent}% OFF`) : null,
        description: plan.description || `Perfect for ${plan.name.toLowerCase()} communities`,
        features,
        cta: isCustomPrice ? 'Contact Sales' : (plan.trialDays ? 'Start Free Trial' : 'Get Started'),
        popular: plan.isFeatured || false,
        badge: plan.badge,
      };
    });
  }, [plans]);

  return (
    <div className="bg-white">
      {/* Header */}
      <header className="fixed inset-x-0 top-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-100">
        <nav className="flex items-center justify-between p-4 lg:px-8 max-w-7xl mx-auto">
          <div className="flex lg:flex-1">
            <a href="#" className="-m-1.5 p-1.5">
              <img src="/logo.png" alt="GateRecord" className="h-12 object-contain" />
            </a>
          </div>
          <div className="flex lg:hidden">
            <button
              type="button"
              className="-m-2.5 inline-flex items-center justify-center rounded-md p-2.5 text-gray-700"
              onClick={() => setMobileMenuOpen(true)}
            >
              <Bars3Icon className="h-6 w-6" />
            </button>
          </div>
          <div className="hidden lg:flex lg:gap-x-8">
            {navigation.map((item) => (
              <a
                key={item.name}
                href={item.href}
                className="text-sm font-medium text-gray-700 hover:text-blue-600 transition-colors no-underline"
              >
                {item.name}
              </a>
            ))}
          </div>
          <div className="hidden lg:flex lg:flex-1 lg:justify-end lg:gap-x-4">
            <Link
              to="/login"
              className="text-sm font-medium text-gray-700 hover:text-blue-600 transition-colors px-4 py-2 no-underline"
            >
              Sign in
            </Link>
            <Link
              to="/signup"
              className="text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 px-5 py-2.5 rounded-full transition-all shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 no-underline"
            >
              Get Started
            </Link>
          </div>
        </nav>
      </header>

      {/* Mobile menu - Portal-style overlay */}
      {mobileMenuOpen && (
        <div className="lg:hidden fixed inset-0" style={{ zIndex: 9999 }}>
          {/* Backdrop with blur */}
          <div 
            className="absolute inset-0 bg-gray-900/50 backdrop-blur-sm"
            onClick={() => setMobileMenuOpen(false)}
          />
          {/* Menu panel */}
          <div className="absolute top-0 right-0 h-full w-full max-w-xs bg-white shadow-2xl flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <img src="/logo.png" alt="GateRecord" className="h-10 object-contain" />
              <button
                type="button"
                className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            
            {/* Navigation */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Navigation</p>
              <nav className="space-y-1">
                {navigation.map((item) => (
                  <a
                    key={item.name}
                    href={item.href}
                    className="flex items-center gap-3 px-3 py-3 text-base font-medium text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors no-underline"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    <span className="w-1.5 h-1.5 bg-gray-300 rounded-full" />
                    {item.name}
                  </a>
                ))}
              </nav>
            </div>
            
            {/* Footer with auth buttons */}
            <div className="border-t border-gray-100 p-6 space-y-3 flex-shrink-0">
              <Link
                to="/login"
                className="block text-center py-3 text-base font-medium text-blue-600 no-underline"
                onClick={() => setMobileMenuOpen(false)}
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                className="block text-center py-3 text-base font-medium text-white bg-blue-600 rounded-lg no-underline"
                onClick={() => setMobileMenuOpen(false)}
              >
                Get Started
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Hero Section */}
      <section className="relative isolate pt-24 lg:pt-32">
        <div className="absolute inset-x-0 -top-40 -z-10 transform-gpu overflow-hidden blur-3xl sm:-top-80">
          <div
            className="relative left-[calc(50%-11rem)] aspect-[1155/678] w-[36.125rem] -translate-x-1/2 rotate-[30deg] bg-gradient-to-tr from-blue-600 to-indigo-400 opacity-20 sm:left-[calc(50%-30rem)] sm:w-[72.1875rem]"
            style={{
              clipPath:
                'polygon(74.1% 44.1%, 100% 61.6%, 97.5% 26.9%, 85.5% 0.1%, 80.7% 2%, 72.5% 32.5%, 60.2% 62.4%, 52.4% 68.1%, 47.5% 58.3%, 45.2% 34.5%, 27.5% 76.7%, 0.1% 64.9%, 17.9% 100%, 27.6% 76.8%, 76.1% 97.7%, 74.1% 44.1%)',
            }}
          />
        </div>

        <div className="mx-auto max-w-7xl px-6 py-16 sm:py-24 lg:px-8 lg:py-32">
          <div className="lg:grid lg:grid-cols-12 lg:gap-x-8 lg:gap-y-20">
            <div className="max-w-2xl mx-auto lg:mx-0 lg:col-span-7 lg:pt-8">
              <div className="mb-8 flex">
                {/* <div className="relative rounded-full px-4 py-1.5 text-sm leading-6 text-gray-600 ring-1 ring-gray-900/10 hover:ring-gray-900/20 flex items-center gap-x-2">
                  <span className="font-semibold text-blue-600">New</span>
                  <span className="h-4 w-px bg-gray-300" />
                  <span>Mobile app now available</span>
                  <a href="#" className="font-semibold text-blue-600 ml-1">
                    Learn more →
                  </a>
                </div> */}
              </div>
              <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl lg:text-7xl">
                Smart Gate Access for{' '}
                <span className="bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
                  Modern Communities
                </span>
              </h1>
              <p className="mt-6 text-lg leading-8 text-gray-600 sm:text-xl">
                Transform your property's security with intelligent RFID access control.
                Real-time monitoring, seamless resident experience, and complete control
                from anywhere in the world.
              </p>
              <div className="mt-10 flex flex-col sm:flex-row items-center gap-3">
                <div style={{ width: '210px', height: '44px', flexShrink: 0 }}>
                  <Link
                    to="/signup"
                    className="flex w-full h-full items-center justify-center rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 text-base font-semibold text-white shadow-none transition-all hover:from-blue-700 hover:to-indigo-700 sm:shadow-md sm:shadow-blue-500/20 no-underline overflow-hidden"
                  >
                    Start Free Trial
                  </Link>
                </div>
                <div style={{ width: '210px', height: '44px', flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => setDemoModalOpen(true)}
                    className="flex w-full h-full items-center justify-center gap-2 rounded-full border border-gray-300 text-base font-semibold text-gray-900 transition-colors hover:border-blue-300 hover:text-blue-600 cursor-pointer overflow-hidden"
                  >
                    <PlayCircleIcon className="h-6 w-6 text-blue-600" />
                    Watch Demo
                  </button>
                </div>
              </div>

              {/* Stats */}
              <div className="mt-16 grid grid-cols-2 gap-8 sm:grid-cols-4">
                {stats.map((stat) => (
                  <div key={stat.label} className="flex flex-col">
                    <dt className="text-sm font-medium text-gray-500">{stat.label}</dt>
                    <dd className="text-3xl font-bold tracking-tight text-gray-900">{stat.value}</dd>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-16 sm:mt-24 lg:mt-0 lg:col-span-5 lg:row-span-2">
              <div className="relative">
                <div className="absolute -inset-4 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-3xl opacity-10 blur-2xl" />
                <img
                  src="https://images.unsplash.com/photo-1558036117-15d82a90b9b1?w=800&h=1000&fit=crop"
                  alt="Modern apartment building with secure gate"
                  className="relative rounded-2xl shadow-2xl ring-1 ring-gray-900/10 w-full object-cover"
                />

                {/* Floating card */}
                <div className="absolute -bottom-8 -left-8 bg-white rounded-2xl shadow-xl p-4 ring-1 ring-gray-100 hidden sm:block">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                      <CheckIcon className="w-6 h-6 text-green-600" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">Access Granted</p>
                      <p className="text-xs text-gray-500">Vehicle: ABC-1234</p>
                    </div>
                  </div>
                </div>

                {/* Floating notification */}
                <div className="absolute -top-4 -right-4 bg-white rounded-2xl shadow-xl p-4 ring-1 ring-gray-100 hidden sm:block">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                      <ShieldCheckIcon className="w-5 h-5 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">Gate Online</p>
                      <p className="text-xs text-green-600">All systems operational</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Trusted by logos */}
        <div className="mx-auto max-w-7xl px-6 lg:px-8 pb-16">
          <p className="text-center text-sm font-medium text-gray-500 mb-8">
            Trusted by leading property management companies
          </p>
          <div className="flex flex-wrap justify-center items-center gap-x-12 gap-y-6 opacity-60">
            {['Skyline Properties', 'Urban Living', 'Coastal Homes', 'Metro Residences', 'Premier Estates'].map((company) => (
              <span key={company} className="text-lg font-semibold text-gray-400">
                {company}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-24 bg-gray-50">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <span className="inline-flex items-center rounded-full bg-blue-100 px-4 py-1.5 text-sm font-medium text-blue-700 mb-4">
              Features
            </span>
            <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-5xl">
              Everything you need to secure your property
            </h2>
            <p className="mt-6 text-lg leading-8 text-gray-600">
              Comprehensive gate management features designed for modern residential and commercial properties.
            </p>
          </div>

          <div className="mx-auto mt-16 max-w-5xl">
            <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((feature) => (
                <div
                  key={feature.name}
                  className="relative bg-white rounded-2xl p-8 shadow-sm ring-1 ring-gray-100 hover:shadow-lg hover:ring-blue-100 transition-all group"
                >
                  <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                    <feature.icon className="w-7 h-7 text-white" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">{feature.name}</h3>
                  <p className="text-gray-600 leading-relaxed">{feature.description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* How it Works Section */}
      <section id="how-it-works" className="py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <span className="inline-flex items-center rounded-full bg-indigo-100 px-4 py-1.5 text-sm font-medium text-indigo-700 mb-4">
              How it Works
            </span>
            <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-5xl">
              Up and running in minutes
            </h2>
            <p className="mt-6 text-lg leading-8 text-gray-600">
              Simple setup, powerful results. Get your smart gate system operational in three easy steps.
            </p>
          </div>

          <div className="mx-auto mt-16 max-w-6xl">
            <div className="space-y-16 lg:space-y-24">
              {steps.map((step, index) => (
                <div
                  key={step.number}
                  className={`flex flex-col lg:flex-row gap-8 lg:gap-16 items-center ${
                    index % 2 === 1 ? 'lg:flex-row-reverse' : ''
                  }`}
                >
                  <div className="flex-1">
                    <span className="text-6xl font-bold text-blue-100">{step.number}</span>
                    <h3 className="text-2xl font-bold text-gray-900 mt-4 mb-4">{step.title}</h3>
                    <p className="text-lg text-gray-600 leading-relaxed">{step.description}</p>
                  </div>
                  <div className="flex-1">
                    <div className="relative">
                      <div className="absolute -inset-4 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl opacity-10 blur-xl" />
                      <img
                        src={step.image}
                        alt={step.title}
                        className="relative rounded-2xl shadow-xl w-full object-cover aspect-video"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-24 bg-gray-900">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <span className="inline-flex items-center rounded-full bg-blue-500/10 px-4 py-1.5 text-sm font-medium text-blue-400 mb-4">
              Pricing
            </span>
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-5xl">
              Simple, transparent pricing
            </h2>
            <p className="mt-6 text-lg leading-8 text-gray-400">
              Choose the plan that fits your community. All plans include a free trial and no need for a credit card.
            </p>
          </div>

          <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-8 lg:grid-cols-3">
            {loadingPlans ? (
              // Loading skeleton
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="relative rounded-3xl p-8 bg-gray-800 ring-1 ring-gray-700 animate-pulse">
                  <div className="h-6 bg-gray-700 rounded w-24 mb-4" />
                  <div className="h-4 bg-gray-700 rounded w-32 mb-6" />
                  <div className="h-12 bg-gray-700 rounded w-20 mb-8" />
                  <div className="space-y-3">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <div key={j} className="h-4 bg-gray-700 rounded w-full" />
                    ))}
                  </div>
                  <div className="h-12 bg-gray-700 rounded-full mt-8" />
                </div>
              ))
            ) : (
              pricing.map((plan) => (
                <div
                  key={plan.id || plan.name}
                  className={`relative rounded-3xl p-8 ${
                    plan.popular
                      ? 'bg-gradient-to-b from-blue-600 to-indigo-700 ring-2 ring-blue-500'
                      : 'bg-gray-800 ring-1 ring-gray-700'
                  }`}
                >
                  {(plan.popular || plan.badge) && (
                    <span className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-blue-400 to-indigo-400 px-4 py-1 text-sm font-semibold text-white">
                      {plan.badge || 'Most Popular'}
                    </span>
                  )}
                  <h3 className={`text-xl font-semibold ${plan.popular ? 'text-white' : 'text-white'}`}>
                    {plan.name}
                  </h3>
                  <p className={`mt-2 text-sm ${plan.popular ? 'text-blue-100' : 'text-gray-400'}`}>
                    {plan.description}
                  </p>
                  <div className="mt-6">
                    {/* Discount label */}
                    {plan.discountLabel && (
                      <span className={`inline-block mb-2 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        plan.popular ? 'bg-yellow-400 text-yellow-900' : 'bg-green-500 text-white'
                      }`}>
                        {plan.discountLabel}
                      </span>
                    )}
                    <p className="flex items-center gap-x-2 mt-2">
                      {/* Original price (crossed out) */}
                      {plan.originalPrice && (
                        <span className={`text-lg line-through ${plan.popular ? 'text-blue-200' : 'text-gray-500'}`}>
                          ${plan.originalPrice}
                        </span>
                      )}
                      {/* Discounted/current price with $ sign same size */}
                      {plan.price !== 'Custom' && (
                        <span className={`flex items-end`}>
                          <span className={`text-5xl font-bold tracking-tight ${plan.popular ? 'text-white' : 'text-white'}`}>$
                            {plan.price}
                          </span>
                        </span>
                      )}
                      {plan.price !== 'Custom' && <span className={`text-sm ${plan.popular ? 'text-blue-100' : 'text-gray-400'}`}>/month</span>}
                    </p>
                  </div>
                  <ul className="mt-8 space-y-3">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-x-3">
                        <CheckIcon className={`h-5 w-5 flex-none ${plan.popular ? 'text-blue-200' : 'text-blue-500'}`} />
                        <span className={`text-sm ${plan.popular ? 'text-blue-50' : 'text-gray-300'}`}>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={plan.price === 'Custom' ? '/signup?plan=enterprise' : `/signup?plan=${plan.name.toLowerCase()}`}
                    className={`mt-8 block rounded-full py-3 px-4 text-center text-sm font-semibold transition-all no-underline ${
                      plan.popular
                        ? 'bg-white text-blue-600 hover:bg-blue-50 shadow-lg'
                        : 'bg-blue-600 text-white hover:bg-blue-500'
                    }`}
                  >
                    {plan.cta}
                  </Link>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Testimonials Section */}
      <section id="testimonials" className="py-24">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <span className="inline-flex items-center rounded-full bg-green-100 px-4 py-1.5 text-sm font-medium text-green-700 mb-4">
              Testimonials
            </span>
            <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-5xl">
              Loved by property managers
            </h2>
            <p className="mt-6 text-lg leading-8 text-gray-600">
              See what our customers have to say about transforming their gate security.
            </p>
          </div>

          <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-8 lg:grid-cols-3">
            {testimonials.map((testimonial) => (
              <div
                key={testimonial.author}
                className="relative bg-white rounded-2xl p-8 shadow-sm ring-1 ring-gray-100"
              >
                <div className="flex gap-1 mb-4">
                  {[...Array(testimonial.rating)].map((_, i) => (
                    <StarIcon key={i} className="w-5 h-5 text-yellow-400" />
                  ))}
                </div>
                <p className="text-gray-700 leading-relaxed mb-6">"{testimonial.content}"</p>
                <div className="flex items-center gap-4">
                  <img
                    src={testimonial.avatar}
                    alt={testimonial.author}
                    className="w-12 h-12 rounded-full object-cover"
                  />
                  <div>
                    <p className="font-semibold text-gray-900">{testimonial.author}</p>
                    <p className="text-sm text-gray-500">
                      {testimonial.role}, {testimonial.company}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {demoModalOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 px-4 py-8 backdrop-blur-sm"
          onClick={() => setDemoModalOpen(false)}
        >
          <div
            className="relative w-full max-w-5xl overflow-hidden rounded-3xl bg-slate-950 shadow-2xl shadow-blue-950/40"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="GateRecord demo video"
          >
            <button
              type="button"
              onClick={() => setDemoModalOpen(false)}
              className="absolute right-4 top-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
            >
              <span className="sr-only">Close demo video</span>
              <XMarkIcon className="h-6 w-6" />
            </button>

            <div className="border-b border-white/10 px-6 py-5 pr-16">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-300">Live Demo</p>
              <h2 className="mt-2 text-2xl font-bold text-white">See GateRecord in action</h2>
              <p className="mt-2 text-sm text-slate-300">
                Watch a quick walkthrough of the GateRecord experience for residents, staff, and property teams.
              </p>
            </div>

            <div className="aspect-video w-full bg-black">
              <iframe
                className="h-full w-full"
                src="https://www.youtube.com/embed/3gHCv0HdaSc?autoplay=1&rel=0"
                title="GateRecord demo video"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            </div>
          </div>
        </div>
      )}

      {/* CTA Section */}
      <section className="relative py-24 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-600 to-indigo-700" />
        <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=1920')] bg-cover bg-center opacity-10" />

        <div className="relative mx-auto max-w-7xl px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-5xl">
            Ready to secure your property?
          </h2>
          <p className="mt-6 text-lg leading-8 text-blue-100 max-w-2xl mx-auto">
            Join hundreds of communities using GateRecord to manage access.
            Start your free trial today — no credit card required.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/signup"
              className="w-full sm:w-auto inline-flex items-center justify-center rounded-full bg-white px-8 py-4 text-base font-semibold text-blue-600 shadow-lg hover:bg-blue-50 transition-all no-underline"
            >
              Start Free Trial
            </Link>
            <a
              href="mailto:sales@gaterecord.com"
              className="w-full sm:w-auto inline-flex items-center justify-center rounded-full ring-2 ring-white/30 px-8 py-4 text-base font-semibold text-white hover:bg-white/10 transition-all no-underline"
            >
              Contact Sales
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 py-16">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 lg:gap-16">
            <div className="col-span-2 md:col-span-1">
              <div className="mb-4">
                <img src="/logo.png" alt="GateRecord" className="h-12 object-contain" />
              </div>
              <p className="text-gray-400 text-sm leading-relaxed">
                Smart gate access control for modern communities. Secure, reliable, and easy to manage.
              </p>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-white mb-4">Product</h3>
              <ul className="space-y-3">
                <li><a href="#features" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">Features</a></li>
                <li><a href="#pricing" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">Pricing</a></li>
                {/* <li><a href="#" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">Integrations</a></li>
                <li><a href="#" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">API</a></li> */}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-white mb-4">Company</h3>
              <ul className="space-y-3">
                <li><Link to="/about" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">About</Link></li>
                <li><Link to="/blog" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">Blog</Link></li>
                {/* <li><a href="#" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">Careers</a></li> */}
                <li><Link to="/contact" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">Contact</Link></li>
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-white mb-4">Legal</h3>
              <ul className="space-y-3">
                <li><Link to="/privacy" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">Privacy</Link></li>
                <li><Link to="/terms" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">Terms</Link></li>
                <li><Link to="/security" className="text-gray-400 hover:text-white text-sm transition-colors no-underline">Security</Link></li>
              </ul>
            </div>
          </div>

          <div className="mt-16 pt-8 border-t border-gray-800 flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-gray-500 text-sm">
              © {new Date().getFullYear()} GateRecord. All rights reserved.
            </p>
            <div className="flex gap-6">
              <a href="#" className="text-gray-500 hover:text-white transition-colors no-underline">
                <span className="sr-only">Twitter</span>
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8.29 20.251c7.547 0 11.675-6.253 11.675-11.675 0-.178 0-.355-.012-.53A8.348 8.348 0 0022 5.92a8.19 8.19 0 01-2.357.646 4.118 4.118 0 001.804-2.27 8.224 8.224 0 01-2.605.996 4.107 4.107 0 00-6.993 3.743 11.65 11.65 0 01-8.457-4.287 4.106 4.106 0 001.27 5.477A4.072 4.072 0 012.8 9.713v.052a4.105 4.105 0 003.292 4.022 4.095 4.095 0 01-1.853.07 4.108 4.108 0 003.834 2.85A8.233 8.233 0 012 18.407a11.616 11.616 0 006.29 1.84" />
                </svg>
              </a>
              <a href="#" className="text-gray-500 hover:text-white transition-colors no-underline">
                <span className="sr-only">LinkedIn</span>
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
                </svg>
              </a>
              <a href="#" className="text-gray-500 hover:text-white transition-colors no-underline">
                <span className="sr-only">GitHub</span>
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

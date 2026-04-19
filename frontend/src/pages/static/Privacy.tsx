import { Link } from 'react-router-dom';

const sections = [
  {
    title: 'Information We Collect',
    body: 'We collect account details, operational device data, access-event records, and support communications that are necessary to deliver gate management, troubleshooting, and security auditing.',
  },
  {
    title: 'How We Use Information',
    body: 'GateRecord uses collected information to authenticate users, manage residents and gates, generate alerts, maintain audit history, improve reliability, and respond to customer support requests.',
  },
  {
    title: 'How We Protect Data',
    body: 'We use role-based access control, encrypted transport, monitored infrastructure, and restricted administrative access to reduce the risk of unauthorized access, disclosure, or misuse.',
  },
  {
    title: 'Retention and Control',
    body: 'We retain data according to product requirements, contract terms, and operational needs. Customers may request updates or deletion of certain account information subject to legal and security obligations.',
  },
];

export default function Privacy() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.25),_transparent_55%)] pointer-events-none" />
      <div className="relative mx-auto max-w-5xl px-6 py-16 lg:px-8 lg:py-24">
        <div className="mb-10 flex items-center justify-between gap-4">
          <Link to="/" className="no-underline">
            <img src="/logo.svg" alt="GateRecord" className="h-14 object-contain" />
          </Link>
          <Link
            to="/"
            className="rounded-full border border-slate-700 px-5 py-2 text-sm font-semibold text-slate-200 transition hover:border-blue-400 hover:text-white no-underline"
          >
            Back to Home
          </Link>
        </div>

        <div className="overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-900/80 shadow-2xl shadow-blue-950/20 backdrop-blur">
          <div className="border-b border-slate-800 px-8 py-10 lg:px-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-400">Legal</p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight text-white lg:text-5xl">Privacy Policy</h1>
            <p className="mt-4 max-w-3xl text-base leading-8 text-slate-300 lg:text-lg">
              This policy explains what information GateRecord collects, why we collect it, how we use it,
              and the controls available to customers using our access control platform.
            </p>
            <p className="mt-4 text-sm text-slate-400">Last updated: April 16, 2026</p>
          </div>

          <div className="grid gap-6 px-8 py-10 lg:grid-cols-2 lg:px-12">
            {sections.map((section) => (
              <section key={section.title} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-6">
                <h2 className="text-xl font-semibold text-white">{section.title}</h2>
                <p className="mt-3 text-sm leading-7 text-slate-300">{section.body}</p>
              </section>
            ))}
          </div>

          <div className="border-t border-slate-800 px-8 py-8 lg:px-12">
            <h2 className="text-xl font-semibold text-white">Contact</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300">
              For privacy requests, data access questions, or compliance inquiries, contact our team at{' '}
              <a href="mailto:privacy@gaterecord.com" className="text-blue-400 hover:text-blue-300 no-underline">
                privacy@gaterecord.com
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

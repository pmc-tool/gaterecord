import { Link } from 'react-router-dom';

const sections = [
  {
    title: 'Infrastructure Controls',
    body: 'GateRecord uses segmented environments, encrypted traffic, monitored services, and tightly controlled administrative access to protect platform infrastructure and customer data.',
  },
  {
    title: 'Application Security',
    body: 'We apply role-based authorization, audit logging, secure coding practices, and change review processes to reduce the risk of unauthorized access and application-level abuse.',
  },
  {
    title: 'Device and Access Security',
    body: 'Connected gate devices are managed with authenticated communication, operational event logging, and security-focused update practices to help maintain trusted field operations.',
  },
  {
    title: 'Incident Response',
    body: 'Security events are triaged, investigated, and escalated according to internal response procedures. We prioritize containment, impact assessment, remediation, and customer communication where appropriate.',
  },
];

export default function Security() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.22),_transparent_55%)] pointer-events-none" />
      <div className="relative mx-auto max-w-5xl px-6 py-16 lg:px-8 lg:py-24">
        <div className="mb-10 flex items-center justify-between gap-4">
          <Link to="/" className="no-underline">
            <img src="/logo.png" alt="GateRecord" className="h-14 object-contain" />
          </Link>
          <Link
            to="/"
            className="rounded-full border border-slate-700 px-5 py-2 text-sm font-semibold text-slate-200 transition hover:border-emerald-400 hover:text-white no-underline"
          >
            Back to Home
          </Link>
        </div>

        <div className="overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-900/80 shadow-2xl shadow-emerald-950/20 backdrop-blur">
          <div className="border-b border-slate-800 px-8 py-10 lg:px-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">Trust Center</p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight text-white lg:text-5xl">Security</h1>
            <p className="mt-4 max-w-3xl text-base leading-8 text-slate-300 lg:text-lg">
              Security is built into the way GateRecord manages access events, user roles, device connectivity,
              and operational alerts. This page outlines our core security approach.
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
            <h2 className="text-xl font-semibold text-white">Report a Security Issue</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300">
              If you need to report a suspected vulnerability or security concern, contact{' '}
              <a href="mailto:security@gaterecord.com" className="text-emerald-400 hover:text-emerald-300 no-underline">
                security@gaterecord.com
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

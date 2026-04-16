import { Link } from 'react-router-dom';

const channels = [
  {
    title: 'Sales',
    value: 'sales@gaterecord.com',
    description: 'Talk to our team about plans, onboarding, and the right setup for your property.',
  },
  {
    title: 'Support',
    value: 'support@gaterecord.com',
    description: 'Get help with accounts, access issues, or day-to-day product questions.',
  },
  {
    title: 'Partnerships',
    value: 'partners@gaterecord.com',
    description: 'Reach out for integration, distribution, or collaboration opportunities.',
  },
  {
    title: 'Security',
    value: 'security@gaterecord.com',
    description: 'Report vulnerabilities or concerns related to platform or device security.',
  },
];

export default function Contact() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.24),_transparent_55%)] pointer-events-none" />
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
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">Contact</p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight text-white lg:text-5xl">Get in Touch</h1>
            <p className="mt-4 max-w-3xl text-base leading-8 text-slate-300 lg:text-lg">
              Whether you are exploring GateRecord for a new property or need help with an active setup,
              our team is available through the channels below.
            </p>
          </div>

          <div className="grid gap-6 px-8 py-10 lg:grid-cols-2 lg:px-12">
            {channels.map((channel) => (
              <section key={channel.title} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-6">
                <h2 className="text-xl font-semibold text-white">{channel.title}</h2>
                <p className="mt-3 text-sm leading-7 text-slate-300">{channel.description}</p>
                <a
                  href={`mailto:${channel.value}`}
                  className="mt-4 inline-block text-sm font-semibold text-emerald-400 hover:text-emerald-300 no-underline"
                >
                  {channel.value}
                </a>
              </section>
            ))}
          </div>

          <div className="border-t border-slate-800 px-8 py-8 lg:px-12">
            <h2 className="text-xl font-semibold text-white">Business Hours</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300">
              General inquiries are typically answered Monday to Friday, 9:00 AM to 6:00 PM. Critical platform and security issues are prioritized as part of ongoing operational support.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

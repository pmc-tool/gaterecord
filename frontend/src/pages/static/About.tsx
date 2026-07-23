import { Link } from 'react-router-dom';

const sections = [
  {
    title: 'What We Build',
    body: 'Yaad delivers modern gate access control software for residential communities, commercial properties, and managed facilities that need reliable access records, resident management, and operational visibility.',
  },
  {
    title: 'Why Teams Choose Yaad',
    body: 'We focus on simple operations, dependable event tracking, and a clean experience for residents, administrators, and security staff. The platform is designed to reduce manual coordination and improve response time at the gate.',
  },
  {
    title: 'How We Work',
    body: 'Our product approach is practical: secure access, clear audit trails, maintainable integrations, and tools that support day-to-day operations without unnecessary complexity.',
  },
  {
    title: 'Who We Support',
    body: 'Yaad is built for property managers, developers, gated communities, apartment operators, and facility teams that need a dependable system for access control and visitor flow.',
  },
];

export default function About() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.25),_transparent_55%)] pointer-events-none" />
      <div className="relative mx-auto max-w-5xl px-6 py-16 lg:px-8 lg:py-24">
        <div className="mb-10 flex items-center justify-between gap-4">
          <Link to="/" className="no-underline">
            <img src="/logo.svg" alt="Yaad" className="h-14 object-contain" />
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
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-400">Company</p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight text-white lg:text-5xl">About Yaad</h1>
            <p className="mt-4 max-w-3xl text-base leading-8 text-slate-300 lg:text-lg">
              Yaad helps properties modernize access control with a platform built for visibility,
              consistency, and secure day-to-day operations.
            </p>
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
              To learn more about our platform or partnership opportunities, email{' '}
              <a href="mailto:hello@gaterecord.com" className="text-blue-400 hover:text-blue-300 no-underline">
                hello@gaterecord.com
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

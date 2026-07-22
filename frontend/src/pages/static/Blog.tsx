import { Link } from 'react-router-dom';

const articles = [
  {
    category: 'Operations',
    title: 'How Modern Communities Reduce Gate Delays',
    description: 'Practical ways to streamline resident entry, visitor processing, and access-event review without increasing operational overhead.',
  },
  {
    category: 'Security',
    title: 'Why Audit Trails Matter in Access Control',
    description: 'A clear event history helps teams investigate incidents faster, improve accountability, and support better operational decisions.',
  },
  {
    category: 'Technology',
    title: 'Connecting Smart Gates to Daily Property Workflows',
    description: 'A look at how gate systems, visitor records, and resident permissions work together in a modern management stack.',
  },
];

export default function Blog() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.24),_transparent_55%)] pointer-events-none" />
      <div className="relative mx-auto max-w-5xl px-6 py-16 lg:px-8 lg:py-24">
        <div className="mb-10 flex items-center justify-between gap-4">
          <Link to="/" className="no-underline">
            <img src="/logo.svg" alt="Yaad" className="h-14 object-contain" />
          </Link>
          <Link
            to="/"
            className="rounded-full border border-slate-700 px-5 py-2 text-sm font-semibold text-slate-200 transition hover:border-indigo-400 hover:text-white no-underline"
          >
            Back to Home
          </Link>
        </div>

        <div className="overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-900/80 shadow-2xl shadow-indigo-950/20 backdrop-blur">
          <div className="border-b border-slate-800 px-8 py-10 lg:px-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-400">Insights</p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight text-white lg:text-5xl">Yaad Blog</h1>
            <p className="mt-4 max-w-3xl text-base leading-8 text-slate-300 lg:text-lg">
              Updates, ideas, and practical guidance for property teams managing gate operations,
              visitor access, and community security.
            </p>
          </div>

          <div className="grid gap-6 px-8 py-10 lg:px-12">
            {articles.map((article) => (
              <article key={article.title} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-400">{article.category}</p>
                <h2 className="mt-3 text-2xl font-semibold text-white">{article.title}</h2>
                <p className="mt-3 text-sm leading-7 text-slate-300">{article.description}</p>
              </article>
            ))}
          </div>

          <div className="border-t border-slate-800 px-8 py-8 lg:px-12">
            <h2 className="text-xl font-semibold text-white">Editorial Contact</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300">
              For product updates, press requests, or editorial questions, contact{' '}
              <a href="mailto:media@gaterecord.com" className="text-indigo-400 hover:text-indigo-300 no-underline">
                media@gaterecord.com
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

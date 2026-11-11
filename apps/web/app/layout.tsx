import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Job Hunter',
  description: 'Latest jobs that fit my profile',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 font-sans text-slate-900 antialiased">{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';
import { ExitProvider } from '@/context/ExitContext';
import { Nav } from '@/components/nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Unilateral Exit',
  description: 'Recover your Spark wallet funds on-chain',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-zinc-950 text-zinc-200 min-h-screen antialiased">
        <ExitProvider>
          <main className="max-w-lg mx-auto pb-20">
            {children}
          </main>
          <Nav />
        </ExitProvider>
      </body>
    </html>
  );
}

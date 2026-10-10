import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WORLDSTATE',
  description: 'A persistent multiplayer civilization built on the real Earth.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#07090c' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DueloDev',
  description: 'Duelos de programación en tiempo real',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}

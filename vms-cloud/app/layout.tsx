import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'VMS Cloud',
  description: 'Análise de eventos de câmeras por IA, sem armazenamento de vídeo.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="antialiased bg-slate-950 text-slate-100">{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QuoteDesk',
  description: 'Turns RFQ emails with spreadsheets and PDFs into quotes a rep can check and send. Synthetic data only.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-10">{children}</div>
      </body>
    </html>
  );
}

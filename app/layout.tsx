import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'مركز المراقبة والاستجابة الطبية',
  description:
    'لوحة تحكم GIS لمراقبة الموارد الطبية وتوجيه سيارات الإسعاف في محافظات سوريا',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body className="antialiased">{children}</body>
    </html>
  );
}

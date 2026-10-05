import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pg talks to Postgres over TCP; exceljs and unpdf read attachments. All three stay plain Node dependencies.
  serverExternalPackages: ['pg', 'exceljs', 'unpdf'],
};

export default nextConfig;

// Builds node-postgres connection options from DATABASE_URL.
// Hosted providers such as Supabase require TLS. Their connection strings carry `sslmode=require`,
// which recent node-postgres versions interpret as full certificate verification against the system
// CA store (Supabase uses its own CA). We therefore keep TLS encryption and, unless a CA certificate
// is supplied via DATABASE_CA_CERT, skip CA verification (libpq `sslmode=require` semantics).
import type { ClientConfig } from 'pg';

export function pgConfig(url: string): ClientConfig {
  const u = new URL(url);
  const mode = u.searchParams.get('sslmode');
  const hosted = /supabase\.(co|com)$/.test(u.hostname) || /pooler\.supabase\.com$/.test(u.hostname);
  if (!mode && !hosted) return { connectionString: url };
  if (mode === 'disable') return { connectionString: url };
  u.searchParams.delete('sslmode');
  u.searchParams.delete('uselibpqcompat');
  const ca = process.env.DATABASE_CA_CERT;
  return {
    connectionString: u.toString(),
    ssl: ca ? { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true } : { rejectUnauthorized: false },
  };
}

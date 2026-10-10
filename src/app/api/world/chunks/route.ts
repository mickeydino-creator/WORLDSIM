import { getRoute } from '@/server/http';
import { loadChunks } from '@/server/services/land';

export const GET = getRoute(async ({ db, url }) => {
  const keys = (url.searchParams.get('keys') ?? '').split(',').filter(Boolean);
  return { chunks: await loadChunks(db, keys) };
});

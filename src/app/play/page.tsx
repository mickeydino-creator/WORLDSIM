import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, userForToken } from '@/server/auth';
import GameShell from '@/client/ui/GameShell';

export const dynamic = 'force-dynamic';

export default async function Play() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await userForToken(token))) redirect('/');
  return <GameShell />;
}

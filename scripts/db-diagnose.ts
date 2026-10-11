// Explains database connection failures without printing secrets.
export function describeDatabaseUrl(url: string): string[] {
  const lines: string[] = [];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return ['DATABASE_URL is not a valid URL. It should start with postgresql:// (check for spaces or a missing part).'];
  }
  const pw = decodeURIComponent(u.password);
  lines.push(`host: ${u.hostname}  port: ${u.port || '5432'}  user: ${decodeURIComponent(u.username)}  database: ${u.pathname.slice(1) || '(none)'}`);
  lines.push(`password: ${pw.length} characters${pw ? '' : ' (EMPTY)'}`);
  if (/YOUR-PASSWORD|\[|\]/i.test(pw)) lines.push('PROBLEM: the password still contains the placeholder or square brackets. Replace [YOUR-PASSWORD] (including the brackets) with your real password.');
  if (/\s/.test(url)) lines.push('PROBLEM: DATABASE_URL contains a space or line break. Paste it again as one line.');
  if (u.hostname.includes('pooler.supabase.com') && !decodeURIComponent(u.username).startsWith('postgres.')) {
    lines.push('PROBLEM: with the Supabase pooler the user must be "postgres.<project-ref>", not just "postgres".');
  }
  if (u.port === '6543') lines.push('PROBLEM: port 6543 is the Transaction pooler. Use the Session pooler (port 5432).');
  if (/^db\..*\.supabase\.co$/.test(u.hostname)) lines.push('PROBLEM: this is the Direct connection host, which Render cannot reach. Use the Session pooler URI.');
  return lines;
}

export function explainConnectionError(err: unknown, url: string) {
  const code = (err as { code?: string }).code;
  console.error('\n========== DATABASE CONNECTION FAILED ==========');
  console.error(`error: ${(err as Error).message}${code ? ` (code ${code})` : ''}`);
  for (const l of describeDatabaseUrl(url)) console.error(l);
  if (code === '28P01') {
    console.error('The password was rejected. Usual causes:');
    console.error(' - the URL still has the password of another project, or the reset has not propagated yet (wait 1-2 minutes);');
    console.error(' - the password contains characters like @ # % / ? : - reset it to letters and digits only;');
    console.error(' - DATABASE_URL was edited on a different Render service, or not saved.');
  }
  if (code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') console.error('The host could not be reached. Use the Supabase Session pooler URI.');
  console.error('================================================\n');
}

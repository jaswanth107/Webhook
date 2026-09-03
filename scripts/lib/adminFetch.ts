/**
 * Admin API calls from the CLI scripts.
 *
 * ADMIN_API_TOKEN is optional: unset, these calls go out bare and a receiver
 * with no token configured answers normally. Set, every script keeps working
 * against a locked-down receiver without any other change.
 */
export function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env.ADMIN_API_TOKEN?.trim();
  return token ? { ...extra, 'x-admin-token': token } : { ...extra };
}

export function adminFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: adminHeaders((init.headers as Record<string, string>) ?? {}),
  });
}

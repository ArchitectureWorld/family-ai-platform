export function validateGatewayBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('GATEWAY_URL_INVALID');
  }

  const rootPath = parsed.pathname === '' || parsed.pathname === '/';
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    !rootPath ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error('GATEWAY_URL_INVALID');
  }

  return parsed.origin;
}

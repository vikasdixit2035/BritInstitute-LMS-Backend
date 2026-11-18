const apiBase = process.argv[2]?.replace(/\/+$/, '');

async function checkRoutes() {
  if (!apiBase) {
    throw new Error('Provide the API base URL, including /api.');
  }

  const endpoints = [
    ['/auth/forgot-password', 'Enter your username.'],
    ['/auth/reset-password', 'Invalid or expired code.'],
  ];
  for (const [path, message] of endpoints) {
    // Empty requests exercise route registration without accessing accounts or sending email.
    const response = await fetch(apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null);
    if (response.status !== 400 || body?.success !== false || !body.message?.startsWith(message)) {
      throw new Error(`POST ${apiBase + path} returned HTTP ${response.status} with an unexpected response.`);
    }
    console.log(`POST ${path} is deployed (HTTP 400 for empty input).`);
  }
}

checkRoutes().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

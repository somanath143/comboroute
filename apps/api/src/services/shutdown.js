export async function drainHttpServer(server, timeoutMs = 10000) {
  // SSE connections can remain open for minutes; bound draining on redeploy.
  const timeout = setTimeout(() => server.closeAllConnections(), timeoutMs);
  timeout.unref();
  try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  finally { clearTimeout(timeout); }
}

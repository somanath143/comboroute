export async function streamOrderEvents(req, res, { loadUser, ownedOrder }) {
  if (res.destroyed || res.writableEnded) return;
  let closed = false, sending = false, previous = '', timer, timeout;
  const cleanup = () => { closed = true; clearInterval(timer); clearTimeout(timeout); };
  res.once('close', cleanup);
  const send = async () => {
    if (closed || sending || res.writableEnded) return;
    sending = true;
    try {
      req.user = await loadUser(req);
      if (closed) return;
      if (!req.user) { res.end(); cleanup(); return; }
      const order = await ownedOrder(req);
      if (closed || res.writableEnded) return;
      const payload = JSON.stringify({ status: order.status, legs: order.legs, events: order.events, payment_status: order.payment_status });
      if (payload !== previous) { res.write(`event: order\ndata: ${payload}\n\n`); previous = payload; }
      else res.write(': keepalive\n\n');
    } catch { if (!closed) res.end(); cleanup(); }
    finally { sending = false; }
  };
  await send();
  if (closed || res.writableEnded) return;
  timer = setInterval(send, 5000);
  timeout = setTimeout(() => { res.end(); cleanup(); }, 15 * 60_000);
}

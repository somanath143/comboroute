import { timingSafeEqual } from 'node:crypto';
// Private portfolio gate, NOT per-user production identity. Covers *all* API and admin routes.
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function demoGate(req, res, next) {
    if (req.path === '/api/health')
        return next();
    const required = process.env.REQUIRE_DEMO_AUTH === 'true' || (process.env.NODE_ENV === 'production' && process.env.REQUIRE_DEMO_AUTH !== 'false');
    if (!required)
        return next();
    const expected = process.env.DEMO_PASSWORD;
    if (!expected) {
        res.status(503).json({ error: 'DEMO_PASSWORD is required for private deployment' });
        return;
    }
    const basic = req.headers.authorization ?? '';
    let user = '', password = '';
    if (basic.startsWith('Basic '))
        try {
            const parts = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
            user = parts.shift() ?? '';
            password = parts.join(':');
        }
        catch { }
    if (!equal(user, process.env.DEMO_USER ?? 'demo') || !equal(password, expected)) {
        res.setHeader('WWW-Authenticate', 'Basic realm="ComboRoute Private Demo"');
        res.setHeader('Cache-Control', 'no-store');
        res.status(401).send('Private ComboRoute demo. Log in with the credentials configured by the owner.');
        return;
    }
    next();
}

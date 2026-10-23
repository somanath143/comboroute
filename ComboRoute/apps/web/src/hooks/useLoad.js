import { useEffect, useState } from 'react';
export function useLoad(loader, deps = []) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [nonce, refresh] = useState(0);
    useEffect(() => { let active = true; setLoading(true); setError(''); loader().then(v => { if (active)
        setData(v); }).catch(e => { if (active)
        setError(e.message); }).finally(() => { if (active)
        setLoading(false); }); return () => { active = false; }; }, [nonce, ...deps]);
    return { data, loading, error, reload: () => refresh(n => n + 1) };
}

let scriptPromise;

export function loadRazorpay() {
  if (typeof window.Razorpay === 'function') return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const fail = () => {
        clearTimeout(timer);
        script.remove();
        scriptPromise = undefined;
        reject(new Error('Razorpay Checkout could not load. Check your connection or browser extensions, then retry.'));
      };
      const timer = setTimeout(fail, 15000);
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.onload = () => {
        if (typeof window.Razorpay !== 'function') return fail();
        clearTimeout(timer);
        resolve();
      };
      script.onerror = fail;
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

export function paymentFailure(error) {
  const details = [error?.reason, error?.code, error?.step].filter(Boolean).join(' · ');
  const reference = error?.metadata?.payment_id;
  return (error?.description || 'Test payment failed. Check the payment in the Razorpay Test Dashboard.')
    + (details ? ` (${details})` : '') + (reference ? ` Payment reference: ${reference}.` : '');
}

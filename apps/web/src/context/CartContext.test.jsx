import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CartProvider, useCart } from './CartContext';
afterEach(() => {
  cleanup();
});
const item = (id, r) => ({ id, restaurant_id: r, name: 'Food ' + id, description: '', category: 'Main', price_paise: 18900, is_veg: true, is_available: true, popular: false, image_key: 'biryani' });
function Probe() { const c = useCart(); return <><span data-testid="qty">{c.count}</span><span data-testid="total">{c.subtotal}</span><span role="alert">{c.error}</span><button onClick={() => c.add(item(1, 1))}>Add A</button><button onClick={() => c.add(item(2, 2))}>Add B</button><button onClick={() => c.add(item(3, 3))}>Add C</button><button onClick={() => c.remove(1)}>Remove A</button></>; }
beforeEach(() => localStorage.clear());
describe('cart persistence and boundaries', () => {
    it('adds and removes correctly', () => { render(<CartProvider><Probe /></CartProvider>); fireEvent.click(screen.getByText('Add A')); expect(screen.getByTestId('qty')).toHaveTextContent('1'); expect(screen.getByTestId('total')).toHaveTextContent('18900'); fireEvent.click(screen.getByText('Remove A')); expect(screen.getByTestId('qty')).toHaveTextContent('0'); });
    it('rejects a third kitchen', () => { render(<CartProvider><Probe /></CartProvider>); fireEvent.click(screen.getByText('Add A')); fireEvent.click(screen.getByText('Add B')); fireEvent.click(screen.getByText('Add C')); expect(screen.getByTestId('qty')).toHaveTextContent('2'); expect(screen.getByRole('alert')).toHaveTextContent('maximum of two restaurants'); });
});

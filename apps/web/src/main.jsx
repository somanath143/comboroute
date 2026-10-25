import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { CartProvider } from './context/CartContext';
import { Layout } from './components/Layout';
import { RequireRole } from './components/RequireRole';
import { Home } from './pages/Home';
import { RestaurantPage } from './pages/Restaurant';
import { CartPage } from './pages/Cart';
import { CheckoutPage } from './pages/Checkout';
import { OrdersPage } from './pages/Orders';
import { TrackingPage } from './pages/Tracking';
import { ConsolePage } from './pages/Console';
import { AuthPage } from './pages/Auth';
import { ProfilePage } from './pages/Profile';
import { PartnerPage } from './pages/Partner';
import { AdminPage } from './pages/Admin';
import './styles/index.css';
const Protected = ({ roles, children }) => <RequireRole roles={roles}>{children}</RequireRole>;
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><AuthProvider><CartProvider><Routes><Route element={<Layout/>}>
  <Route path="/" element={<Home/>}/><Route path="/restaurant/:id" element={<RestaurantPage/>}/><Route path="/cart" element={<CartPage/>}/>
  <Route path="/login" element={<AuthPage/>}/><Route path="/signup" element={<AuthPage register/>}/>
  <Route path="/checkout" element={<Protected roles={['customer']}><CheckoutPage/></Protected>}/>
  <Route path="/orders" element={<Protected roles={['customer']}><OrdersPage/></Protected>}/>
  <Route path="/tracking/:id" element={<Protected roles={['customer','restaurant','partner','admin']}><TrackingPage/></Protected>}/>
  <Route path="/profile" element={<Protected><ProfilePage/></Protected>}/>
  <Route path="/console" element={<Protected roles={['restaurant','admin']}><ConsolePage/></Protected>}/>
  <Route path="/partner" element={<Protected roles={['partner']}><PartnerPage/></Protected>}/>
  <Route path="/admin" element={<Protected roles={['admin']}><AdminPage/></Protected>}/>
  <Route path="*" element={<div className="content-width py-24 text-center"><h1 className="text-5xl font-black">Page not found</h1><a className="btn-primary mt-5" href="/">Explore restaurants</a></div>}/>
</Route></Routes></CartProvider></AuthProvider></BrowserRouter></React.StrictMode>);

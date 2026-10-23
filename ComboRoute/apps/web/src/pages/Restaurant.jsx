import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Clock3, Star, MapPin, ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { useLoad } from '../hooks/useLoad';
import { getRestaurant, image } from '../lib';
import { Loading, ErrorView, MenuRow } from '../components/UI';
import { useCart } from '../context/CartContext';
export function RestaurantPage() {
    const { id } = useParams();
    const { data, loading, error, reload } = useLoad(() => getRestaurant(Number(id)), [id]);
    const [filter, setFilter] = useState('All');
    const cart = useCart();
    if (loading)
        return <Loading />;
    if (error)
        return <main className="content-width mt-8"><ErrorView message={error} onRetry={reload}/></main>;
    if (!data)
        return null;
    const categories = ['All', ...new Set(data.menu.map(i => i.category))];
    const menu = data.menu.filter(i => filter === 'All' || i.category === filter);
    return <div className="content-width"><Link to="/" className="flex items-center gap-2 text-muted text-sm font-semibold mt-8 hover:text-coral"><ArrowLeft size={16}/> Back to restaurants</Link><section className="mt-5 overflow-hidden rounded-2xl border border-gray-100 shadow-soft"><div className="md:flex"><div className="md:w-[39%] h-56 md:h-64 overflow-hidden"><img className="w-full h-full object-cover" src={image(data.image_key)} alt={data.name + ' signature dish'}/></div><div className="md:flex-1 p-6 sm:p-9"><span className="text-coral text-xs uppercase tracking-widest font-black">Fresh from the kitchen</span><h1 className="font-outfit text-3xl sm:text-4xl font-black mt-2">{data.name}</h1><p className="text-muted mt-2">{data.cuisine} · {data.description}</p><div className="flex gap-5 mt-6 text-sm font-bold"><span className="flex items-center gap-1 text-green-700"><Star fill="currentColor" size={16}/>{data.rating.toFixed(1)} ({data.ratings_count.toLocaleString('en-IN')})</span><span className="flex items-center gap-1"><Clock3 size={16}/>{data.prep_minutes}–{data.prep_minutes + 12} min</span></div><p className="text-xs text-muted mt-4 flex items-center gap-2"><MapPin size={14}/> Demo kitchens · Kharagpur, West Bengal</p></div></div></section>
 <div className="mt-8 md:flex gap-12 items-start"><aside className="md:w-52 shrink-0 mb-8"><div className="font-extrabold mb-4">Explore menu</div><div className="flex md:flex-col gap-2 overflow-auto pb-2">{categories.map(c => <button key={c} onClick={() => setFilter(c)} className={'text-left text-sm font-semibold px-4 py-2 rounded-xl whitespace-nowrap ' + (filter === c ? 'bg-peach text-coral' : 'hover:bg-light text-muted')}>{c}</button>)}</div><div className="hidden md:block bg-peach mt-9 p-5 rounded-2xl"><p className="font-bold text-sm">Two cravings?</p><p className="text-sm text-muted mt-2">Add an item, then explore a second restaurant from your bag.</p><Link to="/cart" className="text-coral font-bold text-sm mt-3 flex items-center">Go to cart <ArrowRight size={15}/></Link></div></aside><div className="flex-1 min-w-0"><div className="flex justify-between items-center border-b pb-3"><h2 className="section-heading">{filter === 'All' ? 'Full menu' : filter} <span className="text-muted text-sm">({menu.length})</span></h2><span className="text-xs text-muted">All prices in INR</span></div>{menu.map(i => <MenuRow key={i.id} item={i}/>)}{!menu.length && <p className="text-muted py-10">No items in this category.</p>}</div></div></div>;
}

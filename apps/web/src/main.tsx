import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import './index.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Home } from './pages/Home';
import { RoomRoute } from './pages/Room';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/r/:code" element={<RoomRoute />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);

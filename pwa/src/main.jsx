import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

class StartupErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Axiom failed during startup or rendering.', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main role="alert" style={{ minHeight: '100dvh', padding: 24, display: 'grid', placeItems: 'center', background: '#10110e', color: '#f0efe7', fontFamily: 'system-ui, sans-serif' }}>
          <section style={{ width: '100%', maxWidth: 520, border: '1px solid rgba(240,239,231,.25)', borderLeft: '4px solid #d5ff35', padding: 20 }}>
            <p style={{ color: '#d5ff35', fontSize: 12, letterSpacing: '.16em', fontWeight: 700 }}>AXIOM / STARTUP ERROR</p>
            <h1 style={{ fontSize: 26, margin: '14px 0 8px' }}>Axiom could not start.</h1>
            <p style={{ color: '#c1c0b5', fontSize: 14, lineHeight: 1.5 }}>The app caught a startup error instead of leaving you with a blank screen. Restart Axiom after the issue has been fixed.</p>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: '#ffb49e', background: '#0b0c0a', padding: 12, fontSize: 12 }}>{String(this.state.error?.message || this.state.error)}</pre>
            <button type="button" onClick={() => window.location.reload()} style={{ minHeight: 44, padding: '0 18px', border: 0, background: '#d5ff35', color: '#10110e', fontWeight: 700 }}>Restart Axiom</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StartupErrorBoundary>
    <React.StrictMode><App /></React.StrictMode>
  </StartupErrorBoundary>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => console.error('Axiom service worker registration failed.', error));
  });
}

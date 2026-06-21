import React, { Component } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './popup.css';

interface EBState { hasError: boolean; message: string; }

class ErrorBoundary extends Component<{ children: React.ReactNode }, EBState> {
  state: EBState = { hasError: false, message: '' };

  static getDerivedStateFromError(err: Error): EBState {
    return { hasError: true, message: err.message };
  }

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="m-3">
        <div className="glass-card px-4 py-5 text-center space-y-3">
          <p className="text-sm font-semibold text-slate-700">Something went wrong</p>
          <p className="text-xs text-slate-400 break-words">{this.state.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, message: '' })}
            className="px-4 py-1.5 text-xs font-medium text-white bg-sky-500 hover:bg-sky-600 rounded-lg transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

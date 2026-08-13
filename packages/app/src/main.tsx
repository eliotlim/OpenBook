import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import {AppErrorBoundary} from './AppErrorBoundary';
import {suppressNativeContextMenu} from './nativeContextMenu';
import './styles.css';

suppressNativeContextMenu(import.meta.env.PROD);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);

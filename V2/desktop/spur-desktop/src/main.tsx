import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installMicrophoneCapture } from './microphone';
import './styles.css';

if (window.spur) installMicrophoneCapture();

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

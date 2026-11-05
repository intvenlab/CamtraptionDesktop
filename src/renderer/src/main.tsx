import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// No StrictMode: its double-run effects would open GATT connections and log history events twice.
createRoot(document.getElementById('root')!).render(<App />)

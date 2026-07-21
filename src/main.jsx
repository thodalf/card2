import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.jsx'
import './index.css'

// Applies a newly-deployed version as soon as it's detected instead of waiting
// for the user to manually "Vider le cache & recharger" or for the browser's
// own (infrequent) service-worker update check — onNeedRefresh fires once a
// new SW has finished installing, and updateSW(true) skips waiting + reloads.
// The periodic registration.update() call is what actually notices a new
// deployment while the tab stays open on a single long-lived session.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh(){ updateSW(true) },
  onRegisteredSW(_url, registration){
    if(registration) setInterval(()=>registration.update(), 60_000)
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

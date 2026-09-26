import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '../../../../src/App';
import {applyTheme,applyFont,storeTheme,storeFont} from '../../../../src/theme/applyTheme';
import './preview.css';
// This origin is dedicated to the disposable documentation preview.
for(const key of Object.keys(localStorage))if(key.startsWith('redline.'))localStorage.removeItem(key);
localStorage.setItem('redline.tocOpen','false');
localStorage.setItem('redline.terminalWorkspace.v1',JSON.stringify({tabs:[{id:'readme-terminal',cwd:null}],tiles:['readme-terminal'],focusedTile:0,zoomedId:null}));
// Keep the full sample plan above the app's floating margin controls.
const keys={'redline.onboardingDone':true,'redline.sidebar.collapsed':false,'redline.commentPane.collapsed':false,'redline.terminalPane.collapsed':false,'redline.terminalPane.height':128,'redline.sidebar.width':215,'redline.commentPane.width':430};
for(const [key,value]of Object.entries(keys))localStorage.setItem(key,JSON.stringify(value));
storeTheme('terminal');storeFont('san-francisco');applyTheme('terminal');applyFont('san-francisco');
window.addEventListener('error',e=>{document.documentElement.dataset.previewError=e.message});
window.addEventListener('unhandledrejection',e=>{document.documentElement.dataset.previewError=String(e.reason)});
createRoot(document.getElementById('root')!).render(<App/>);

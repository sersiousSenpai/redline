import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const native=path.join(root,'native.ts');
const server=await createServer({configFile:false,root,cacheDir:path.join(root,'.cache'),plugins:[react(),tailwindcss()],resolve:{alias:[{find:/^@tauri-apps\/(api\/.+|plugin-.+)$/,replacement:native}]},server:{host:'127.0.0.1',port:8848,strictPort:true,fs:{allow:[path.resolve(root,'../../../..')]},watch:{ignored:['**/src-tauri/**','**/docs/assets/readme/*.png']}},clearScreen:false});
await server.listen();console.log('Component preview: http://127.0.0.1:8848/');

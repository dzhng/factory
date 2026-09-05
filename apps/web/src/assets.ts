export const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Factory</title>
    <link rel="stylesheet" href="/assets/app.css">
  </head>
  <body>
    <a class="skip-link" href="#content">Skip to evidence</a>
    <div id="app" aria-live="polite"><p>Loading Factory evidence…</p></div>
    <script src="/assets/app.js" defer></script>
  </body>
</html>`

export const STYLES = `:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#18211d;background:#f5f3ed}*{box-sizing:border-box}body{margin:0}.skip-link{position:absolute;left:-999px}.skip-link:focus{left:1rem;top:1rem;background:#fff;padding:.75rem;z-index:2}#app{max-width:92rem;margin:auto;padding:2rem}a,button{font:inherit}:focus-visible{outline:3px solid #bd5b33;outline-offset:3px}`

export const CLIENT = `const app=document.querySelector('#app');
const text=(tag,value,attrs={})=>{const node=document.createElement(tag);node.textContent=String(value);for(const [key,val] of Object.entries(attrs))node.setAttribute(key,String(val));return node};
async function load(){try{const response=await fetch('/api/snapshot',{headers:{Accept:'application/json'}});const snapshot=await response.json();app.replaceChildren(text('main',snapshot.state==='ready'?'Factory evidence loaded':snapshot.title,{id:'content'}));app.dataset.ready='true'}catch{app.replaceChildren(text('main','Factory evidence is unavailable',{id:'content'}));app.dataset.ready='error'}}
load();`

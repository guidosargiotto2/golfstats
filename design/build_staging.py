"""Builds staging.html = index.html + the v2 design layer (design/v2.css + a few lines of script).
Run from the repo root:  python design/build_staging.py
Staging uses the same accounts, rounds and courses as the live app; only the look changes."""
import io, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = io.open(os.path.join(root, 'index.html'), encoding='utf-8').read()
css = io.open(os.path.join(root, 'design', 'v2.css'), encoding='utf-8').read()
head = ('\n<meta name="robots" content="noindex,nofollow">'
        '\n<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
        '\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT@0,9..144,300..700,0..100;1,9..144,300..700,0..100&family=IBM+Plex+Mono:wght@400;500;600&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap">'
        '\n<script>document.documentElement.classList.add("v2");</script>')
js = r'''
<script id="v2js">
/* v2: the signal line under the headline — a control chart of 22 rounds drawn once; one round leaves the limits */
(function(){
 function sig(){var h=document.querySelector('#landing h1');if(!h||document.querySelector('.v2sig'))return;
   var es=(document.documentElement.getAttribute('data-oblang')==='es')||/Encontr/.test(h.textContent);
   var y=[40,34,45,38,30,43,36,47,41,33,44,37,31,42,35,46,39,10,36,43,34,40],W=560,st=W/(y.length-1),d='';
   y.forEach(function(v,i){d+=(i?'L':'M')+(i*st).toFixed(1)+' '+v;});
   var s='<svg class="v2sig" viewBox="0 0 560 74" aria-hidden="true"><line class="lim" x1="0" x2="560" y1="18" y2="18"/><line class="lim" x1="0" x2="560" y1="58" y2="58"/><line class="mid" x1="0" x2="560" y1="38" y2="38"/><path class="run" d="'+d+'"/>';
   y.forEach(function(v,i){s+='<circle class="'+(v<18?'hit':'pt')+'" cx="'+(i*st).toFixed(1)+'" cy="'+v+'" r="'+(v<18?4:2.4)+'" style="animation-delay:'+(v<18?2.3:(.35+i*.09)).toFixed(2)+'s"/>';});
   s+='<text class="sg" x="'+(17*st+10).toFixed(0)+'" y="9">'+(es?'SEÑAL':'SIGNAL')+'</text><text x="0" y="72">'+(es?'TODO LO DEMÁS: RUIDO':'EVERYTHING ELSE: NOISE')+'</text></svg>';
   h.insertAdjacentHTML('afterend',s);}
 function tag(){if(document.getElementById('stagingTag'))return;var t=document.createElement('div');t.id='stagingTag';t.textContent='STAGING · DESIGN V2';document.body.appendChild(t);}
 function go(){sig();tag();}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();
 setInterval(sig,1500);   /* the headline is re-rendered when the language changes */
})();
</script>
'''
i = src.find('<head>') + len('<head>')
out = src[:i] + head + src[i:]
j = out.rfind('</body>')
out = out[:j] + '\n<style id="v2">\n' + css + '\n</style>' + js + out[j:]
io.open(os.path.join(root, 'staging.html'), 'w', encoding='utf-8').write(out)
print('staging.html', len(out) // 1024, 'KB')

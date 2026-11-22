(function(){
  var KEY='gs-land-lang',lang='en';
  try{lang=new URLSearchParams(location.search).get('lang')||localStorage.getItem(KEY)||((navigator.language||'').slice(0,2)==='es'?'es':'en');}catch(e){}
  function apply(l){lang=l==='es'?'es':'en';document.documentElement.setAttribute('data-lang',lang);document.documentElement.lang=lang;
    document.querySelectorAll('[data-l]').forEach(function(el){var p=el.getAttribute('data-l').split('|');el.textContent=lang==='es'?(p[1]||p[0]):p[0];});
    var b=document.getElementById('lang');if(b)b.textContent=lang==='es'?'EN':'ES';try{localStorage.setItem(KEY,lang);}catch(e){}}
  apply(lang);
  var b=document.getElementById('lang');if(b)b.onclick=function(){apply(lang==='es'?'en':'es');};
})();

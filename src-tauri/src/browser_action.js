(function(op){try{const e=op.selector?document.querySelector(op.selector):document.activeElement;let result={};
const visible=(el)=>!!el&&!!(el.getBoundingClientRect().width||el.getBoundingClientRect().height)&&getComputedStyle(el).visibility!=='hidden';
if(op.selector&&!e)return JSON.stringify(op.kind==='wait'?{ok:true,ready:op.visible===false}:{ok:false,error:'Target no longer exists'});
switch(op.kind){
case 'click':if(!visible(e)||e.matches(':disabled,[inert],[inert] *')||typeof e.click!=='function')throw Error('Target is not actionable');e.click();result={clicked:true,selector:op.selector,value:e.value??null,checked:e.checked??null};break;
case 'fill':if(!e||(!e.matches('input,textarea')&&!e.isContentEditable)||e.matches(':disabled,[inert],[inert] *')||e.readOnly||e.matches('input[type="file"],input[type="checkbox"],input[type="radio"],input[type="button"],input[type="submit"],input[type="reset"],input[type="hidden"]'))throw Error('Target is not editable');e.focus();if(e.isContentEditable)e.textContent=op.value;else{const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(e,op.value);}e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));result={value:e.isContentEditable?e.textContent:e.value};if(result.value!==op.value)throw Error('Page rejected the requested value');break;
case 'select':if(!e||e.tagName!=='SELECT'||e.matches(':disabled'))throw Error('Target is not an enabled select control');if(![...e.options].some(option=>option.value===op.value&&!option.disabled&&!option.parentElement?.matches('optgroup:disabled')))throw Error('Option not found or disabled');e.value=op.value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));if(e.value!==op.value)throw Error('Page rejected the requested option');result={value:e.value};break;
case 'scroll':{const target=op.selector?e:window;target.scrollBy({left:op.x,top:op.y,behavior:'instant'});result={x:op.selector?e.scrollLeft:scrollX,y:op.selector?e.scrollTop:scrollY};break;}
case 'key': {
  if(!e||e.matches(':disabled,[inert],[inert] *'))throw Error('No enabled focused element');
  const state=()=>JSON.stringify({value:e.value??null,start:e.selectionStart??null,end:e.selectionEnd??null,checked:e.checked??null});
  e.focus();if(document.activeElement!==e)throw Error('Target did not accept keyboard focus');const before=state(),focused=document.activeElement;
  const allowed=e.dispatchEvent(new KeyboardEvent('keydown',{key:op.key,bubbles:true,cancelable:true}));let outcome;
  try {
    // Synthetic keyboard events do not perform browser defaults. Implement
    // bounded DOM defaults and reject unsupported keys rather than report a noop.
    if(!allowed){if(state()!==before||document.activeElement!==focused)outcome='page-handler';else throw Error('Page canceled the key; no resulting change was observed');}
    else if(op.key==='Tab'){
      const targets=[...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex],[contenteditable="true"]')].filter(el=>el.tabIndex>=0&&!el.matches(':disabled,[inert],[inert] *')&&visible(el)).sort((a,b)=>(a.tabIndex||Infinity)-(b.tabIndex||Infinity));
      const next=targets[(targets.indexOf(e)+1)%targets.length];
      if(!next||next===e)throw Error('No next page focus target; native browser focus is required');
      next.focus();if(document.activeElement!==next)throw Error('Page rejected the focus change');outcome='focus-next';
    }
    else if(op.key==='Escape'&&window.__redline_inspect_stop){window.__redline_inspect_stop();outcome='inspection-closed';}
    else if(e.matches('input,textarea')&&e.selectionStart!==null&&e.selectionEnd!==null&&(Array.from(op.key).length===1||['Backspace','Delete','ArrowLeft','ArrowRight','Home','End'].includes(op.key)||(op.key==='Enter'&&e.tagName==='TEXTAREA'))){
      let start=e.selectionStart,end=e.selectionEnd;const value=e.value;
      if(['ArrowLeft','ArrowRight','Home','End'].includes(op.key)){
        const previous=Math.max(0,start-(Array.from(value.slice(0,start)).at(-1)?.length||1));
        const next=Math.min(value.length,end+(Array.from(value.slice(end))[0]?.length||1));
        const lineStart=e.tagName==='TEXTAREA'?value.lastIndexOf('\n',Math.max(-1,start-1))+1:0;
        const newline=e.tagName==='TEXTAREA'?value.indexOf('\n',end):-1,lineEnd=newline<0?value.length:newline;
        const position=op.key==='Home'?lineStart:op.key==='End'?lineEnd:op.key==='ArrowLeft'?(start!==end?start:previous):(start!==end?end:next);
        e.setSelectionRange(position,position);outcome='caret';
      }else{
        if(e.readOnly)throw Error('Target is read-only');
        if(op.key==='Backspace'&&start===end)start=Math.max(0,start-(Array.from(value.slice(0,start)).at(-1)?.length||1));
        if(op.key==='Delete'&&start===end)end=Math.min(value.length,end+(Array.from(value.slice(end))[0]?.length||1));
        const text=op.key==='Enter'?'\n':['Backspace','Delete'].includes(op.key)?'':op.key;
        const inputType=op.key==='Backspace'?'deleteContentBackward':op.key==='Delete'?'deleteContentForward':op.key==='Enter'?'insertLineBreak':'insertText';
        if(!e.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType,data:text||null})))throw Error('Page canceled the requested edit');
        const requested=value.slice(0,start)+text+value.slice(end),proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(e,requested);e.setSelectionRange(start+text.length,start+text.length);
        e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType,data:text||null}));
        if(e.value!==requested)throw Error('Page rejected the requested value');outcome='text-edit';
      }
    }
    else if(((op.key==='Enter'||op.key===' ')&&e.matches('button,input[type="button"],input[type="submit"],input[type="reset"],a[href]'))||(op.key===' '&&e.matches('input[type="checkbox"],input[type="radio"]'))){
      if(op.key===' '&&e.matches('a[href]'))throw Error('This key requires native browser input');e.click();outcome='control-activation';
    }
    else if(op.key==='Enter'&&e.tagName==='INPUT'&&e.form&&!e.matches('[type="checkbox"],[type="radio"],[type="file"]')){if(!e.form.noValidate&&!e.form.checkValidity())throw Error('Form validation prevented submission');e.form.requestSubmit();outcome='form-submit-requested';}
    else if(state()!==before||document.activeElement!==focused)outcome='page-handler';
    else throw Error('This key requires native browser input; no resulting change was observed');
    result={key:op.key,outcome,value:e.value??null,selectionStart:e.selectionStart??null,selectionEnd:e.selectionEnd??null,checked:e.checked??null};
  }finally{(document.activeElement||e).dispatchEvent(new KeyboardEvent('keyup',{key:op.key,bubbles:true}));}
  break;
}
case 'wait':result={ready:!!e&&(op.visible===undefined||op.visible===null||visible(e)===op.visible)&&(op.text===null||op.text===undefined||(e.textContent||'').includes(op.text))};break;
default:throw Error('Unsupported page operation');}
return JSON.stringify({ok:true,...result,url:location.href,revision:window.__redline_revision?window.__redline_revision():String(performance.timeOrigin)});
}catch(error){return JSON.stringify({ok:false,error:String(error)});}})

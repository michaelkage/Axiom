"use strict";

const ACTION_TYPES = new Set(["click", "fill", "select"]);
function normalizeBrowserAction(input) {
  if (!input || typeof input !== "object" || !ACTION_TYPES.has(input.type)) throw new TypeError("Choose a supported browser action.");
  if (typeof input.target !== "string" || !input.target.trim() || input.target.length > 160 || /[\0\r\n]/.test(input.target)) {
    throw new TypeError("Browser action target must be 1–160 characters on one line.");
  }
  const target = input.target.trim();
  if (input.type === "click") return { type: "click", target };
  if (typeof input.value !== "string" || input.value.length > 4000) throw new TypeError("Browser field value must be a string no longer than 4000 characters.");
  return { type: input.type, target, value: input.value };
}
function buildBrowserActionScript(action) {
  const normalized = normalizeBrowserAction(action);
  return "(function(action){" +
    "const visible=e=>!!(e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';" +
    "const norm=s=>(s||'').replace(/\\s+/g,' ').trim().toLocaleLowerCase();" +
    "const target=norm(action.target);let nodes=[];" +
    "if(action.type==='click'){nodes=[...document.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit]')].filter(e=>visible(e)&&norm(e.getAttribute('aria-label')||e.innerText||e.textContent||e.value||e.title)===target);}" +
    "else{nodes=[...document.querySelectorAll('input:not([type=password]):not([type=file]):not([type=hidden]),textarea,select,[role=textbox],[contenteditable=true]')].filter(e=>visible(e)&&norm(e.getAttribute('aria-label')||e.labels?.[0]?.innerText||e.getAttribute('placeholder')||e.getAttribute('name'))===target);}" +
    "if(nodes.length!==1)throw new Error(nodes.length?'Target is ambiguous; use a more specific accessible label.':'No unique visible control matched that target.');" +
    "const el=nodes[0];if(el.disabled||el.getAttribute('aria-disabled')==='true')throw new Error('The matched control is disabled.');" +
    "if(action.type==='click'){el.click();return {type:'click',target:action.target,matched:true};}" +
    "if(action.type==='select'){if(el.tagName!=='SELECT')throw new Error('Select actions require a select control.');if(![...el.options].some(o=>o.value===action.value))throw new Error('The requested option value is not available.');el.value=action.value;}" +
    "else if(el.isContentEditable){el.textContent=action.value;}" +
    "else{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!setter)throw new Error('This field cannot be updated safely.');setter.call(el,action.value);}" +
    "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));" +
    "return {type:action.type,target:action.target,matched:true};" +
  "})(" + JSON.stringify(normalized) + ")";
}
module.exports = { normalizeBrowserAction, buildBrowserActionScript, ACTION_TYPES };

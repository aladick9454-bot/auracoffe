'use strict';
const toggle=document.querySelector('.menu-toggle');
const mobileNav=document.querySelector('#mobile-nav');
function closeMenu(){toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Открыть меню');mobileNav.hidden=true;}
toggle.addEventListener('click',()=>{const open=toggle.getAttribute('aria-expanded')==='true';toggle.setAttribute('aria-expanded',String(!open));toggle.setAttribute('aria-label',open?'Открыть меню':'Закрыть меню');mobileNav.hidden=open;});
mobileNav.querySelectorAll('a').forEach(link=>link.addEventListener('click',closeMenu));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!mobileNav.hidden){closeMenu();toggle.focus();}});
window.addEventListener('resize',()=>{if(window.innerWidth>760&&!mobileNav.hidden)closeMenu();});
const tabs=document.querySelectorAll('.menu-tab');
const cards=document.querySelectorAll('.menu-card');
tabs.forEach(tab=>tab.addEventListener('click',()=>{const category=tab.dataset.category;tabs.forEach(t=>{const active=t===tab;t.classList.toggle('is-active',active);t.setAttribute('aria-pressed',String(active));});cards.forEach(card=>{card.hidden=category!=='all'&&card.dataset.category!==category;});}));
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('in-view');observer.unobserve(entry.target);}});},{threshold:.12});document.querySelectorAll('.scroll-reveal').forEach(el=>observer.observe(el));}else{document.querySelectorAll('.scroll-reveal').forEach(el=>el.classList.add('in-view'));}
const form=document.querySelector('#booking-form');const status=document.querySelector('#form-status');const dateInput=document.querySelector('#booking-date');
const today=new Date();const localToday=new Date(today.getTime()-today.getTimezoneOffset()*60000).toISOString().slice(0,10);dateInput.min=localToday;
form.addEventListener('submit',async event=>{event.preventDefault();status.className='form-status';status.textContent='';if(!form.checkValidity()){form.reportValidity();return;}
const payload=Object.fromEntries(new FormData(form).entries());payload.consent=form.elements.consent.checked;
const button=form.querySelector('[type="submit"]');button.disabled=true;button.textContent='ОТПРАВЛЯЕМ…';
try{const response=await fetch("https://aura-coffee-api-2lty.onrender.com/api/reservations",{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Не удалось отправить запрос. Попробуйте позже.');status.classList.add('success');status.textContent='Запрос отправлен! Сотрудник кофейни свяжется с вами для подтверждения.';form.reset();dateInput.min=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);}catch(error){status.classList.add('error');status.textContent=location.protocol==='file:'||location.port==='5500'||location.port==='5501'?'Для отправки заявок открой сайт через Node.js сервер (инструкция в README.md).':error.message;}finally{button.disabled=false;button.innerHTML='ОТПРАВИТЬ ЗАПРОС <span aria-hidden="true">↗</span>';}});

'use strict';
require('dotenv').config();
const express=require('express');
const path=require('path');
const app=express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const allowedOrigin = 'https://aladick9454-bot.github.io';


app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'aura-coffee-api',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime())
  });
});


app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});
app.use(express.json({limit:'12kb'}));
app.use(express.static(path.join(__dirname),{index:'index.html',dotfiles:'deny',extensions:false}));
const requests=new Map();
const MAX_PER_15_MIN=5;
setInterval(()=>{const now=Date.now();for(const [ip,entry] of requests){if(now-entry.start>900000)requests.delete(ip);}},900000).unref();
function safeText(value,max){return typeof value==='string'?value.trim().slice(0,max):'';}
function validDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)return false;const today=new Date();const start=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()));return d>=start&&d<=new Date(start.getTime()+90*86400000);}
app.post('/api/booking',async(req,res)=>{
res.set('Cache-Control','no-store');
const ip=req.ip||'unknown';const now=Date.now();let entry=requests.get(ip);if(!entry||now-entry.start>900000){entry={start:now,count:0};requests.set(ip,entry);}entry.count++;if(entry.count>MAX_PER_15_MIN)return res.status(429).json({error:'Слишком много запросов. Попробуйте через 15 минут.'});
const body=req.body||{};if(body.website)return res.json({ok:true});
const name=safeText(body.name,80),phone=safeText(body.phone,24),date=safeText(body.date,10),time=safeText(body.time,5),comment=safeText(body.comment,300),guests=Number(body.guests);
if(name.length<2||!/^\+?[\d\s()\-]{7,24}$/.test(phone)||!validDate(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||time<'08:00'||time>'22:00'||!Number.isInteger(guests)||guests<1||guests>6||body.consent!==true)return res.status(400).json({error:'Проверьте данные формы и согласие на обработку.'});
const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
if(!token||!chatId)return res.status(503).json({error:'Приём бронирований пока не подключён. Попробуйте позже.'});
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const message=`☕ <b>Новый запрос AURA COFFEE</b>\nИмя: ${escape(name)}\nТелефон: ${escape(phone)}\nДата: ${escape(date)}\nВремя: ${escape(time)}\nГостей: ${guests}\nПожелания: ${escape(comment||'нет')}\n\n⚠️ Запрос требует подтверждения сотрудником.`;
try{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);let response;try{response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:message,parse_mode:'HTML'}),signal:controller.signal});}finally{clearTimeout(timeout);}if(!response.ok)throw Error('Telegram returned '+response.status);res.json({ok:true});}catch(error){console.error('Booking delivery error:',error.message);res.status(502).json({error:'Не удалось доставить запрос. Попробуйте позже.'});}
});
app.get('/api/health',(_req,res)=>res.json({ok:true,telegramConfigured:Boolean(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID)}));
const port=Number(process.env.PORT)||3000;app.listen(port,()=>console.log(`AURA COFFEE: http://localhost:${port}`));

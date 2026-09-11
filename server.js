import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();
const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is required');

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(morgan('combined'));
app.use(cookieParser());
app.use('/api/payments/paystack/webhook', express.raw({type:'application/json'}));
app.use(express.json({limit:'100kb'}));
app.use(express.urlencoded({extended:false}));
app.use(express.static('public'));

const asyncHandler = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const money = n => Number(n).toFixed(2);
const sign = user => jwt.sign({sub:user.id,role:user.role,email:user.email}, JWT_SECRET,{expiresIn:'7d'});
function setAuth(res,user){res.cookie('legacy_token',sign(user),{httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',maxAge:7*24*3600*1000});}
function auth(req,res,next){
  const token=req.cookies.legacy_token || (req.headers.authorization||'').replace(/^Bearer\s+/,'');
  if(!token) return res.status(401).json({error:'Authentication required'});
  try{req.auth=jwt.verify(token,JWT_SECRET);next()}catch{return res.status(401).json({error:'Invalid or expired session'})}
}
function role(...roles){return (req,res,next)=>roles.includes(req.auth?.role)?next():res.status(403).json({error:'Forbidden'});}
function cleanPhone(p){return String(p).replace(/\D/g,'');}
function paystackProvider(network){return network==='MTN'?'mtn':network==='AirtelTigo'?'atl':network==='Telecel'?'vod':null;}

app.get('/api/health',(req,res)=>res.json({ok:true,service:'legacy-enterprises'}));
app.get('/api/config',(req,res)=>res.json({paystackPublicKey:process.env.PAYSTACK_PUBLIC_KEY||null}));
app.get('/api/bundles',asyncHandler(async(req,res)=>{
  const bundles=await prisma.bundle.findMany({where:{active:true},orderBy:[{network:'asc'},{price:'asc'}]});
  res.json(bundles.map(b=>({...b,price:money(b.price)})));
}));

const registerSchema=z.object({name:z.string().min(2).max(80),email:z.string().email().max(150),phone:z.string().min(9).max(15),password:z.string().min(8).max(100)});
app.post('/api/auth/register',asyncHandler(async(req,res)=>{
  const data=registerSchema.parse(req.body);
  const exists=await prisma.user.findUnique({where:{email:data.email.toLowerCase()}});
  if(exists) return res.status(409).json({error:'Email already registered'});
  const user=await prisma.user.create({data:{name:data.name,email:data.email.toLowerCase(),phone:cleanPhone(data.phone),passwordHash:await bcrypt.hash(data.password,12)}});
  setAuth(res,user);res.status(201).json({user:{id:user.id,name:user.name,email:user.email,phone:user.phone,role:user.role}});
}));
app.post('/api/auth/login',asyncHandler(async(req,res)=>{
  const {email,password}=req.body||{};
  if(!email||!password) return res.status(400).json({error:'Email and password are required'});
  const user=await prisma.user.findUnique({where:{email:String(email).toLowerCase()}});
  if(!user || !(await bcrypt.compare(password,user.passwordHash))) return res.status(401).json({error:'Invalid email or password'});
  setAuth(res,user);res.json({user:{id:user.id,name:user.name,email:user.email,phone:user.phone,role:user.role}});
}));
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('legacy_token');res.json({ok:true})});
app.get('/api/auth/me',auth,asyncHandler(async(req,res)=>{const u=await prisma.user.findUnique({where:{id:req.auth.sub},select:{id:true,name:true,email:true,phone:true,role:true,createdAt:true}});res.json({user:u})}));

const orderSchema=z.object({bundleId:z.string().min(1),recipientPhone:z.string().min(9).max(15)});
app.post('/api/orders',auth,asyncHandler(async(req,res)=>{
  const data=orderSchema.parse(req.body);
  const bundle=await prisma.bundle.findFirst({where:{id:data.bundleId,active:true}});
  if(!bundle) return res.status(404).json({error:'Bundle not found'});
  const reference=`LE-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const order=await prisma.order.create({data:{reference,userId:req.auth.sub,bundleId:bundle.id,recipientPhone:cleanPhone(data.recipientPhone),amount:bundle.price}});
  res.status(201).json({order:{...order,amount:money(order.amount),bundle:{...bundle,price:money(bundle.price)}}});
}));

async function paystack(path,options={}){
  if(!process.env.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  const r=await fetch(`https://api.paystack.co${path}`,{...options,headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`,'Content-Type':'application/json',...(options.headers||{})}});
  const body=await r.json().catch(()=>({}));
  if(!r.ok || body.status===false) throw new Error(body.message||`Paystack HTTP ${r.status}`);
  return body;
}

app.post('/api/payments/paystack/momo',auth,asyncHandler(async(req,res)=>{
  const {orderId,email,provider}=req.body||{};
  const order=await prisma.order.findFirst({where:{id:orderId,userId:req.auth.sub},include:{bundle:true}});
  if(!order) return res.status(404).json({error:'Order not found'});
  if(order.status!=='PENDING_PAYMENT') return res.status(409).json({error:'Order is not payable'});
  const p=provider||paystackProvider(order.bundle.network);
  if(!['mtn','atl','vod'].includes(p)) return res.status(400).json({error:'Unsupported Ghana mobile-money provider'});
  const customerEmail=email || req.auth.email;
  const result=await paystack('/charge',{method:'POST',body:JSON.stringify({email:customerEmail,amount:Math.round(Number(order.amount)*100),currency:'GHS',mobile_money:{phone:order.recipientPhone,provider:p},reference:order.reference,metadata:{orderId:order.id,bundleId:order.bundleId,network:order.bundle.network,recipientPhone:order.recipientPhone}})});
  await prisma.order.update({where:{id:order.id},data:{provider:'paystack',providerReference:result.data?.reference||order.reference}});
  res.json({reference:result.data?.reference, status:result.data?.status, displayText:result.data?.display_text||'Approve the mobile-money payment on your phone.'});
}));

app.get('/api/payments/paystack/verify/:reference',auth,asyncHandler(async(req,res)=>{
  const order=await prisma.order.findFirst({where:{providerReference:req.params.reference,userId:req.auth.sub}});
  if(!order) return res.status(404).json({error:'Order not found'});
  const result=await paystack(`/transaction/verify/${encodeURIComponent(req.params.reference)}`,{method:'GET'});
  const d=result.data;
  if(d.status==='success') await markPaid(order.id,d);
  res.json({status:d.status,reference:d.reference,amount:d.amount,currency:d.currency});
}));

async function markPaid(orderId,payment){
  const order=await prisma.order.findUnique({where:{id:orderId},include:{bundle:true}});
  if(!order) return;
  const expected=Math.round(Number(order.amount)*100);
  if(payment.currency!=='GHS' || Number(payment.amount)!==expected) throw new Error('Payment amount/currency mismatch');
  if(order.paymentStatus==='SUCCESS') return;
  await prisma.order.update({where:{id:orderId},data:{paymentStatus:'SUCCESS',status:'PAID',providerReference:payment.reference||order.providerReference}});
  // DATA FULFILMENT HOOK: call your licensed data-vending provider here.
}

function validPaystackSignature(req){
  const secret=process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;
  if(!secret) return false;
  const hash=crypto.createHmac('sha512',secret).update(req.body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(req.headers['x-paystack-signature']||''));
}
app.post('/api/payments/paystack/webhook',asyncHandler(async(req,res)=>{
  if(!validPaystackSignature(req)) return res.status(401).send('invalid signature');
  const event=JSON.parse(req.body.toString('utf8'));
  const eventId=String(event.id || `${event.event}:${event.data?.reference||crypto.randomUUID()}`);
  try{await prisma.webhookEvent.create({data:{eventId,event:event.event,payload:event}})}catch(e){if(e.code==='P2002') return res.sendStatus(200);throw e}
  if(event.event==='charge.success' || event.event==='transaction.success'){
    const ref=event.data?.reference;
    const order=await prisma.order.findFirst({where:{providerReference:ref}});
    if(order) await markPaid(order.id,event.data);
  }
  res.sendStatus(200);
}));

app.get('/api/orders',auth,asyncHandler(async(req,res)=>{
  const where=req.auth.role==='ADMIN'?{}:{userId:req.auth.sub};
  const orders=await prisma.order.findMany({where,include:{bundle:true,user:{select:{name:true,email:true,phone:true}}},orderBy:{createdAt:'desc'},take:100});
  res.json(orders.map(o=>({...o,amount:money(o.amount),bundle:{...o.bundle,price:money(o.bundle.price)}})));
}));
app.get('/api/admin/stats',auth,role('ADMIN'),asyncHandler(async(req,res)=>{
  const [customers,orders,pending,paid]=await Promise.all([
    prisma.user.count({where:{role:'CUSTOMER'}}),prisma.order.count(),prisma.order.count({where:{status:{in:['PENDING_PAYMENT','PROCESSING']}}}),prisma.order.aggregate({where:{paymentStatus:'SUCCESS'},_sum:{amount:true}})
  ]);
  res.json({customers,orders,pendingSales:pending,totalSales:money(paid._sum.amount||0)});
}));
app.patch('/api/admin/orders/:id/status',auth,role('ADMIN'),asyncHandler(async(req,res)=>{
  const status=z.enum(['PROCESSING','DELIVERED','FAILED','CANCELLED']).parse(req.body?.status);
  const order=await prisma.order.update({where:{id:req.params.id},data:{status}});res.json(order);
}));
app.post('/api/admin/bundles',auth,role('ADMIN'),asyncHandler(async(req,res)=>{
  const data=z.object({network:z.string(),name:z.string(),price:z.coerce.number().positive(),active:z.boolean().optional()}).parse(req.body);
  const b=await prisma.bundle.create({data:{...data}});res.status(201).json(b);
}));
app.patch('/api/admin/bundles/:id',auth,role('ADMIN'),asyncHandler(async(req,res)=>{
  const data=z.object({price:z.coerce.number().positive().optional(),active:z.boolean().optional(),name:z.string().optional()}).parse(req.body);
  const b=await prisma.bundle.update({where:{id:req.params.id},data});res.json(b);
}));
app.get('/api/admin/customers',auth,role('ADMIN'),asyncHandler(async(req,res)=>res.json(await prisma.user.findMany({where:{role:'CUSTOMER'},select:{id:true,name:true,email:true,phone:true,createdAt:true},orderBy:{createdAt:'desc'}}))));

app.use((err,req,res,next)=>{console.error(err);if(err instanceof z.ZodError)return res.status(400).json({error:'Invalid input',details:err.issues});res.status(500).json({error:err.message||'Server error'})});
app.listen(PORT,()=>console.log(`Legacy Enterprises running on http://localhost:${PORT}`));

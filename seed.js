import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();
const bundles={
 MTN:[["1GB",4.30],["2GB",8.40],["3GB",12.70],["4GB",16.50],["5GB",20.75],["6GB",25.30],["8GB",33.30],["10GB",40.65],["15GB",61.50],["20GB",81.60],["25GB",101.55],["30GB",122.30]],
 AirtelTigo:[["1GB",3.99],["2GB",7.90],["3GB",12],["4GB",15.80],["5GB",19.80],["6GB",24],["7GB",28],["8GB",31.80],["10GB",39.80],["12GB",47.50],["15GB",59],["20GB",79]],
 Telecel:[["5GB",23],["10GB",40],["15GB",57],["20GB",96],["25GB",96],["30GB",110],["40GB",148],["50GB",182],["100GB",352],["200GB",700]]
};
for (const [network, plans] of Object.entries(bundles)) for (const [name,price] of plans)
  await prisma.bundle.upsert({where:{network_name:{network,name}},update:{price,active:true},create:{network,name,price}}).catch(async()=>{const existing=await prisma.bundle.findFirst({where:{network,name}}); if(existing) await prisma.bundle.update({where:{id:existing.id},data:{price,active:true}}); else await prisma.bundle.create({data:{network,name,price}})});
const email=process.env.ADMIN_EMAIL||'admin@legacyenterprises.com';
const password=process.env.ADMIN_PASSWORD||'ChangeMeImmediately123!';
await prisma.user.upsert({where:{email},update:{role:'ADMIN'},create:{name:'Legacy Administrator',email,passwordHash:await bcrypt.hash(password,12),role:'ADMIN'}});
console.log('Seed complete. Admin:',email);
await prisma.$disconnect();

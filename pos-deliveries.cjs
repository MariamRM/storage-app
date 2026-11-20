// Server-only POS delivery adapter for the existing Storage Manage Method app.
// No staff password or browser user ID is accepted as integration authentication.
const {createHash,timingSafeEqual,randomUUID} = require('node:crypto');

function installPosIntegration({app,loadData,saveData,mainStorageBranchId,token=process.env.POS_INTEGRATION_KEY}) {
  // Legacy routes read/modify/save a shared JSON file. Serialize their complete
  // async handlers with connector writes so simultaneous requests cannot erase data.
  let pending=Promise.resolve();
  for(const method of ['post','put','patch','delete']) {
    const register=app[method].bind(app);
    app[method]=(route,...handlers)=>{
      if(!handlers.length)return register(route);
      const handler=handlers.pop();
      return register(route,...handlers,(req,res,next)=>{
        const result=pending.then(()=>handler(req,res,next));
        pending=result.catch(()=>{});
        result.catch(next);
      });
    };
  }
  function check(value,message,status=400){if(!value)throw Object.assign(new Error(message),{status});}
  function text(value,max=200){check(typeof value==='string'&&value.trim().length<=max,'Invalid delivery field.');return value.trim();}
  function authorize(req){
    check(typeof token==='string'&&token.length>=32,'POS integration is not configured.',503);
    const supplied=String(req.headers.authorization||'').replace(/^Bearer /,'');
    check(supplied.length<=256&&timingSafeEqual(createHash('sha256').update(supplied).digest(),createHash('sha256').update(token).digest()),'Integration authentication required.',401);
  }
  const route=fn=>async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{authorize(req);await fn(req,res);}catch(error){res.status(error.status||500).json({error:error.status?error.message:'Delivery integration failed.'});}
  };
  function publicDelivery(data,row){
    const driver=(data.users||[]).find(u=>u.id===row.driverUserId);
    return {requestId:row.posRequestId,id:row.id,fromBranchId:row.fromBranchId,invoiceNo:row.invoiceNo,
      status:row.status,revision:row.posRevision,driverName:driver?.name||'',
      etaLabel:row.driverEtaLabel||'',etaAt:row.driverEtaAt||'',updatedAt:row.updatedAt||row.createdAt,
      deliveredAt:row.deliveredAt||'',chargeFils:row.posChargeFils};
  }
  app.get('/api/integrations/pos/catalogue',route(async(req,res)=>{
    const data=await loadData();
    res.json({version:2,branches:data.branches.filter(b=>b.id!==mainStorageBranchId).map(b=>({id:b.id,name:b.name})),
      areas:(data.deliveryAreas||[]).filter(a=>a.active!==false&&a.active!==0).map(a=>({name:a.name,nameAr:a.nameAr||'',zone:a.zone||'',chargeFils:Math.round(Number(a.charge||0)*1000)}))});
  }));
  app.get('/api/integrations/pos/deliveries/:requestId',route(async(req,res)=>{
    const data=await loadData(),row=data.deliveries.find(d=>d.posRequestId===req.params.requestId);
    check(row,'Delivery request not found.',404);res.json(publicDelivery(data,row));
  }));
  app.post('/api/integrations/pos/deliveries',route(async(req,res)=>{
    check(req.body&&JSON.stringify(req.body).length<=18000,'Delivery payload is too large.',413);
    const body=req.body,requestId=text(body.requestId,100),sourceOrderId=text(body.sourceOrderId,100),
      sourceBranchId=text(body.sourceBranchId,100),fromBranchId=text(body.fromBranchId,100),invoiceNo=text(body.invoiceNo,150),
      desired=text(body.desiredStatus,20),revision=body.revision;
    check(/^[a-zA-Z0-9-]{16,100}$/.test(requestId)&&sourceOrderId&&sourceBranchId&&invoiceNo,'Invalid source invoice.');
    check(Number.isSafeInteger(revision)&&revision>=0&&['new','ready','cancelled'].includes(desired),'Invalid delivery revision or status.');
    const data=await loadData();
    check(fromBranchId!==mainStorageBranchId&&data.branches.some(b=>b.id===fromBranchId),'Choose a mapped destination-app branch.');
    const payloadHash=createHash('sha256').update(JSON.stringify(['customerName','customerPhone','address','areaName','chargeFils','dueDate','readyTimeAt','note'].map(k=>body[k]??''))).digest('hex');
    let row=data.deliveries.find(d=>d.posRequestId===requestId);
    if(!row)check(['ready','cancelled'].includes(desired)&&typeof body.approvedAt==='string'&&Number.isFinite(Date.parse(body.approvedAt))&&typeof body.approvedBy==='string'&&body.approvedBy.length>0,'Reception approval is required before creating a delivery.',409);
    if(row){
      check(row.posOrderId===sourceOrderId&&row.posBranchId===sourceBranchId&&row.fromBranchId===fromBranchId&&row.invoiceNo===invoiceNo,'Delivery source cannot change.',409);
      if(revision<=row.posRevision){if(revision===row.posRevision)check(row.posPayloadHash===payloadHash,'Delivery revision was reused with different details.',409);res.json(publicDelivery(data,row));return;}
      check(!(desired==='cancelled'&&['in_transit','delivered'].includes(row.status)),'Delivery is already with the driver or delivered. Contact dispatch before cancelling.',409);
      check(!(desired==='new'&&['in_transit','delivered'].includes(row.status)),'The driver already has this delivery. Contact dispatch.',409);
      check(row.status!=='cancelled'||desired==='cancelled','A cancelled request cannot be reopened.',409);
    }
    const stamp=new Date().toISOString();
    let fields;
    if(!row||row.posPayloadHash!==payloadHash){
      check(!row||!['in_transit','delivered','cancelled'].includes(row.status),'Dispatched delivery details cannot change.',409);
      const customerName=text(body.customerName,100),customerPhone=text(body.customerPhone,30),address=text(body.address,1500),areaName=text(body.areaName,150);
      check(customerName&&/^[+\d\s()-]{5,30}$/.test(customerPhone)&&address,'Customer name, phone and address are required.');
      const area=(data.deliveryAreas||[]).find(a=>a.name===areaName&&a.active!==false&&a.active!==0);
      check(area,'The delivery area is inactive or missing.');
      const chargeFils=Math.round(Number(area.charge||0)*1000);
      check(Number.isSafeInteger(chargeFils)&&chargeFils>=0&&chargeFils===body.chargeFils,'The delivery price changed. Review the request in POS.',409);
      const dueDate=text(body.dueDate||'',10),readyTimeAt=text(body.readyTimeAt||'',40);
      check(!dueDate||/^\d{4}-\d{2}-\d{2}$/.test(dueDate),'Invalid due date.');
      check(!readyTimeAt||Number.isFinite(Date.parse(readyTimeAt)),'Invalid ready time.');
      fields={customerName,customerPhone,address,areaName,areaNameAr:area.nameAr||'',areaZone:area.zone||'',
        posChargeFils:chargeFils,deliveryCharge:(chargeFils/1000).toFixed(3),dueDate,readyTimeAt,readyTimeLabel:readyTimeAt?'POS scheduled time':'',note:text(body.note||'',1000),posPayloadHash:payloadHash};
    }
    if(!row){
      row={id:'DEL-POS-'+randomUUID(),posRequestId:requestId,posOrderId:sourceOrderId,posBranchId:sourceBranchId,
        posRevision:revision,posReady:desired==='ready',posApprovedAt:body.approvedAt,posApprovedBy:body.approvedBy,...fields,
        fromBranchId,invoiceNo,driverEtaLabel:'',driverEtaAt:'',driverUserId:null,
        createdByUserId:'pos-integration',createdAt:stamp,updatedAt:stamp,deliveredAt:null,status:desired};
      data.deliveries.push(row);
    }else{
      Object.assign(row,fields||{});row.posRevision=revision;row.posReady=desired==='ready';row.updatedAt=stamp;if(body.approvedAt){row.posApprovedAt=body.approvedAt;row.posApprovedBy=body.approvedBy;}
      if(!['in_transit','delivered'].includes(row.status))row.status=desired;
    }
    await saveData(data);res.json(publicDelivery(data,row));
  }));
}

function guardPosDelivery(delivery,next){
  if(!delivery?.posRequestId)return;
  if(delivery.status==='cancelled')throw Object.assign(new Error('This POS delivery was cancelled.'),{status:409});
  if(['new','ready'].includes(next))throw Object.assign(new Error('Reception must approve and send the delivery request from POS.'),{status:409});
  if(['in_transit','delivered'].includes(next)&&!delivery.posReady)throw Object.assign(new Error('Reception must approve the work and mark the request Ready in POS.'),{status:409});
  if(next==='in_transit'&&!['ready','in_transit'].includes(delivery.status))throw Object.assign(new Error('Delivery is not ready for pickup.'),{status:409});
  if(next==='delivered'&&!['in_transit','delivered'].includes(delivery.status))throw Object.assign(new Error('Record driver pickup before delivery.'),{status:409});
}
module.exports={installPosIntegration,guardPosDelivery};

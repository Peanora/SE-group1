import { buildKit, equal as eq, length as len, variable as v } from './definition-kit.mjs';
export const reservations = Object.freeze({id:'reservations',requirementFile:'reservations.md',keys:['auth','resources','bookings','waitlist','workflow','audit','consistency','ui','evolution'],evolutionKind:'workflow'});
export function reservationsDefinition({requirements,coverage,version=0}){
  if(![0,1].includes(version))throw new Error('Unsupported benchmark version');
  const k=buildKit({...reservations,id:`reservations-v${version}`,name:'资源预约、占位与有序候补固定业务预期',requirements,coverage,sessions:['alice','bob','carol','scheduler',...(version?['dave']:[])]}),{api,login,race,restart,b,browserLogin}=k;
  api('auth',null,'GET','/api/bookings',401);for(const u of['alice','bob','carol','scheduler',...(version?['dave']:[])])login(u,u);
  api('resources','alice','GET','/api/resources?q=ROOM&site=east&page=1&pageSize=2',200,undefined,[eq('$.total',2),eq('$.items[0].id','ROOM-A')]);
  api('resources','alice','GET','/api/resources/ROOM-W',404);
  api('bookings','alice','POST','/api/holds',400,{resourceId:'ROOM-A',slot:'not-a-slot',reference:'BAD',key:'bad'});
  race(['consistency','bookings'],[['alice','POST','/api/holds',[201,409],{resourceId:'ROOM-A',slot:'2030-05-01-AM',reference:'RACE-A',key:'race-A'}],['bob','POST','/api/holds',[201,409],{resourceId:'ROOM-A',slot:'2030-05-01-AM',reference:'RACE-B',key:'race-B'}]],[201,409]);
  api('consistency','scheduler','GET','/api/availability?resourceId=ROOM-A&slot=2030-05-01-AM',200,undefined,[eq('$.held',1),eq('$.confirmed',0),eq('$.available',0)]);
  api('bookings','alice','POST','/api/holds',201,{resourceId:'ROOM-A',slot:'2030-05-01-PM',reference:'BENCH-A',key:'hold-A'},[eq('$.item.version',1)],[['booking','$.item.id']]);
  api('consistency','alice','POST','/api/holds',200,{resourceId:'ROOM-A',slot:'2030-05-01-PM',reference:'BENCH-A',key:'hold-A'},[eq('$.replayed',true),eq('$.item.id',v('booking'))]);
  api('auth','bob','GET','/api/bookings/${booking}',404);
  api('waitlist','bob','POST','/api/waitlist',201,{resourceId:'ROOM-A',slot:'2030-05-01-PM',reference:'BENCH-B'},[eq('$.item.position',1)],[['waiter','$.item.id']]);
  api('waitlist','carol','POST','/api/waitlist',201,{resourceId:'ROOM-A',slot:'2030-05-01-PM',reference:'BENCH-C'},[eq('$.item.position',2)]);
  api('waitlist','bob','POST','/api/waitlist',409,{resourceId:'ROOM-A',slot:'2030-05-01-PM',reference:'DUP'});
  api('workflow','alice','POST','/api/bookings/${booking}/confirm',200,{version:1},[eq('$.item.status','confirmed'),eq('$.item.version',2)]);
  api('consistency','alice','POST','/api/bookings/${booking}/confirm',409,{version:1},[eq('$.error.code','stale_version')]);
  api('workflow','bob','POST','/api/bookings/${booking}/cancel',404,{version:2});
  if(version)race(['evolution','consistency'],[['alice','POST','/api/bookings/${booking}/cancel',200,{version:2},[eq('$.item.status','cancelled')]],['dave','POST','/api/holds',409,{resourceId:'ROOM-A',slot:'2030-05-01-PM',reference:'NO-QUEUE-JUMP',key:'no-queue-jump'}]],[200,409]);
  else api('workflow','alice','POST','/api/bookings/${booking}/cancel',200,{version:2},[eq('$.item.status','cancelled')]);
  api(['evolution','workflow'],'scheduler','GET','/api/availability?resourceId=ROOM-A&slot=2030-05-01-PM',200,undefined,[eq('$.held',version?1:0),eq('$.available',version?0:1),eq('$.queued',version?1:2)]);
  api(['evolution','waitlist'],'scheduler','POST','/api/waitlist/${waiter}/promote',version?409:200,{version:1},version?[eq('$.error.code','automatic_promotion')]:[eq('$.item.status','held')]);
  api('waitlist','bob','GET','/api/bookings?reference=BENCH-B',200,undefined,[eq('$.total',1),eq('$.items[0].status','held')],[['promoted','$.items[0].id'],['promotedVersion','$.items[0].version']]);
  api('workflow','bob','POST','/api/bookings/${promoted}/confirm',200,{version:v('promotedVersion')},[eq('$.item.status','confirmed')]);
  api('audit','scheduler','GET','/api/audit?resourceId=ROOM-A&slot=2030-05-01-PM',200,undefined,[len('$.items',7),eq('$.items[0].action','held'),eq('$.items[4].action','cancelled'),eq('$.items[5].action','promoted'),eq('$.items[5].actorId',version?'system':'scheduler')]);
  api('bookings','scheduler','GET','/api/bookings?q=BENCH&status=confirmed&resourceId=ROOM-A&page=1&pageSize=1',200,undefined,[eq('$.total',1),eq('$.items[0].reference','BENCH-B')]);
  api('bookings','scheduler','GET','/api/bookings?q=BENCH&resourceId=ROOM-A&page=2&pageSize=1',200,undefined,[eq('$.total',2),eq('$.items[0].reference','BENCH-B')]);
  api('bookings','alice','GET','/api/bookings?page=0',400);
  restart('consistency');api('consistency','bob','GET','/api/bookings/${promoted}',200,undefined,[eq('$.item.status','confirmed')]);
  if(version)api('evolution','alice','GET','/api/bookings?reference=KEPT-R1',200,undefined,[eq('$.total',1),eq('$.items[0].status','confirmed'),eq('$.items[0].slot','2030-06-01-AM')]);
  api('auth','alice','POST','/api/logout',204,{});api('auth','alice','GET','/api/bookings',401);
  browserLogin('owner','alice');b('ui','owner','goto','/bookings?q=WEB');b('resources','owner','fill','booking-resource','ROOM-A');b('bookings','owner','fill','booking-slot','2030-05-02-AM');b('bookings','owner','fill','booking-reference','WEB-A');b('bookings','owner','click','booking-hold');b('bookings','owner','count','booking-row',1);b('bookings','owner','click','booking-first-open');b('workflow','owner','text','booking-status','held');b('workflow','owner','click','booking-confirm');b('workflow','owner','text','booking-status','confirmed');
  b('resources','owner','text','booking-resource-id','ROOM-A');
  browserLogin('waiter','bob');b('waitlist','waiter','goto','/bookings?q=WEB');b('waitlist','waiter','fill','booking-resource','ROOM-A');b('waitlist','waiter','fill','booking-slot','2030-05-02-AM');b('waitlist','waiter','fill','booking-reference','WEB-B');b('waitlist','waiter','click','booking-wait');b('waitlist','waiter','text','waitlist-position','1');b('auth','waiter','count','booking-row',0);
  b('workflow','owner','click','booking-cancel');b('workflow','owner','text','booking-status','cancelled');
  if(!version){browserLogin('operator','scheduler');b('workflow','operator','goto','/waitlist?resourceId=ROOM-A&slot=2030-05-02-AM');b('evolution','operator','click','waitlist-first-promote');b('evolution','operator','text','waitlist-total','0');}
  b('evolution','waiter','goto','/bookings?q=WEB');b('evolution','waiter','count','booking-row',1);b('evolution','waiter','click','booking-first-open');b('evolution','waiter','text','booking-status','held');b('workflow','waiter','click','booking-confirm');b('workflow','waiter','text','booking-status','confirmed');b('audit','waiter','text','audit-count','3');
  b('bookings','owner','goto','/bookings?q=WEB&status=cancelled');b('bookings','owner','count','booking-row',1);b('consistency','waiter','goto','/bookings?q=WEB&status=confirmed');b('consistency','waiter','count','booking-row',1);
  if(version){b('evolution','owner','goto','/bookings?reference=KEPT-R1');b('evolution','owner','count','booking-row',1);b('evolution','owner','click','booking-first-open');b('evolution','owner','text','booking-status','confirmed');}
  return k.finish();
}

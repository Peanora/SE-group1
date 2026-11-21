import { buildKit, equal as eq, length as len, variable as v } from './definition-kit.mjs';
export const inventory = Object.freeze({ id:'inventory', requirementFile:'inventory.md', keys:['auth','catalog','documents','workflow','ledger','audit','consistency','ui','evolution'], evolutionKind:'permission' });
export function inventoryDefinition({requirements,coverage,version=0}) {
  if(![0,1].includes(version))throw new Error('Unsupported benchmark version');
  const k=buildKit({...inventory,id:`inventory-v${version}`,name:'库存、出库单与不可重复记账固定业务预期',requirements,coverage,sessions:['alice','bob','keeper','keeper2','auditor']}),{api,login,race,restart,b,browserLogin}=k;
  api('auth',null,'GET','/api/stock',401);for(const[s,u]of[['alice','alice'],['bob','bob'],['keeper','keeper'],['keeper2','keeper'],['auditor','auditor']])login(s,u);
  api('catalog','keeper','GET','/api/stock?warehouse=W1&q=SKU&page=1&pageSize=2',200,undefined,[eq('$.total',2),eq('$.items[0].sku','SKU-A'),eq('$.items[0].quantity',10)]);
  api('auth','alice','GET','/api/stock?warehouse=W2',404);
  api('documents','alice','POST','/api/outbounds',400,{reference:'BAD',warehouseId:'W1',sku:'SKU-A',quantity:-1,memo:''});
  api('documents','alice','POST','/api/outbounds',201,{reference:'BENCH-A',warehouseId:'W1',sku:'SKU-A',quantity:6,memo:'initial'},[eq('$.item.version',1)],[['first','$.item.id']]);
  api('documents','bob','POST','/api/outbounds',201,{reference:'BENCH-B',warehouseId:'W1',sku:'SKU-A',quantity:6,memo:'initial'},[],[['second','$.item.id']]);
  api('documents','keeper','PATCH','/api/outbounds/${first}',200,{version:1,memo:'reviewed'},[eq('$.item.version',2)]);
  api('documents','keeper','PATCH','/api/outbounds/${second}',200,{version:1,memo:'reviewed'},[eq('$.item.version',2)]);
  api('auth','alice','POST','/api/outbounds/${first}/post',403,{version:2,key:'not-allowed'});
  api('auth','bob','GET','/api/outbounds/${first}',404);
  api('auth','alice','POST','/api/outbounds',404,{reference:'FOREIGN',warehouseId:'W2',sku:'SKU-X',quantity:1,memo:''});
  api('consistency','keeper','PATCH','/api/outbounds/${first}',409,{version:1,memo:'stale'},[eq('$.error.code','stale_version')]);
  race(['workflow','consistency'],[['keeper','POST','/api/outbounds/${first}/post',[200,409],{version:2,key:'post-A'}],['keeper2','POST','/api/outbounds/${second}/post',[200,409],{version:2,key:'post-B'}]],[200,409]);
  api('consistency','keeper','GET','/api/stock?warehouse=W1&q=SKU-A',200,undefined,[eq('$.items[0].quantity',4)]);
  api('documents','keeper','GET','/api/outbounds?q=BENCH&status=posted&page=1&pageSize=2',200,undefined,[eq('$.total',1),eq('$.items[0].quantity',6)],[['winner','$.items[0].id'],['winnerVersion','$.items[0].version'],['winnerKey','$.items[0].postKey']]);
  api('documents','keeper','GET','/api/outbounds?q=BENCH&status=draft&page=1&pageSize=2',200,undefined,[eq('$.total',1)],[['loser','$.items[0].id'],['loserVersion','$.items[0].version']]);
  api('ledger','keeper','POST','/api/outbounds/${winner}/post',200,{version:2,key:v('winnerKey')},[eq('$.replayed',true)]);
  api('ledger','keeper','POST','/api/outbounds/${winner}/post',409,{version:v('winnerVersion'),key:'different-key'});
  api('workflow','keeper','PATCH','/api/outbounds/${winner}',409,{version:v('winnerVersion'),quantity:1});
  api('documents','keeper','GET','/api/outbounds?q=BENCH&warehouse=W1&page=1&pageSize=1',200,undefined,[eq('$.total',2),eq('$.items[0].reference','BENCH-A')]);
  api('documents','keeper','GET','/api/outbounds?q=BENCH&warehouse=W1&page=2&pageSize=1',200,undefined,[eq('$.total',2),eq('$.items[0].reference','BENCH-B')]);
  api('workflow','keeper','POST','/api/outbounds/${loser}/cancel',200,{version:v('loserVersion')},[eq('$.item.status','cancelled')]);
  api('audit','auditor','GET','/api/audit?referencePrefix=BENCH',200,undefined,[len('$.items',6),eq('$.items[0].action','created'),eq('$.items[2].action','updated'),eq('$.items[4].action','posted'),eq('$.items[5].action','cancelled')]);
  api('ledger','auditor','GET','/api/ledger?warehouse=W1&sku=SKU-A',200,undefined,[len('$.items',2),eq('$.items[0].kind','opening'),eq('$.items[1].delta',-6),eq('$.balance',4)]);
  api('auth','auditor','POST','/api/outbounds/${winner}/post',403,{version:v('winnerVersion'),key:v('winnerKey')});
  api('documents','keeper','GET','/api/outbounds?pageSize=51',400);
  restart('consistency');api('consistency','keeper','GET','/api/stock?warehouse=W1&q=SKU-A',200,undefined,[eq('$.items[0].quantity',4)]);
  if(version){api('evolution','alice','GET','/api/outbounds?q=KEPT-D1',200,undefined,[eq('$.total',1),eq('$.items[0].memo','kept-memo')],[['kept','$.items[0].id'],['keptVersion','$.items[0].version']]);api('evolution','alice','PATCH','/api/outbounds/${kept}',200,{version:v('keptVersion'),memo:'owner-edit-v1'},[eq('$.item.memo','owner-edit-v1')]);api('evolution','alice','PATCH','/api/outbounds/${kept}',403,{version:2,quantity:2});api('evolution','bob','PATCH','/api/outbounds/${kept}',404,{version:2,memo:'foreign'});}
  else api('evolution','alice','PATCH','/api/outbounds/${first}',403,{version:3,memo:'not-allowed-v0'});
  api('auth','alice','POST','/api/logout',204,{});api('auth','alice','GET','/api/outbounds',401);
  browserLogin('owner','alice');b('ui','owner','goto','/outbounds?q=WEB');b('documents','owner','fill','outbound-reference','WEB-A');b('catalog','owner','fill','outbound-sku','SKU-A');b('documents','owner','fill','outbound-quantity','2');b('documents','owner','fill','outbound-memo','<b>memo</b>');b('documents','owner','click','outbound-create');b('documents','owner','count','outbound-row',1);b('documents','owner','text','outbound-first-reference','WEB-A');b('documents','owner','value','outbound-reference','');
  b('catalog','owner','value','outbound-sku','SKU-A');
  b('documents','owner','fill','outbound-reference','WEB-B');b('documents','owner','click','outbound-create');b('documents','owner','fill','outbound-reference','WEB-C');b('documents','owner','click','outbound-create');b('documents','owner','text','outbound-total','3');b('documents','owner','count','outbound-row',2);b('documents','owner','click','outbound-next');b('documents','owner','count','outbound-row',1);
  b('documents','owner','fill','outbound-query','WEB-A');b('documents','owner','fill','outbound-status-filter','draft');b('documents','owner','click','outbound-filter');b('documents','owner','click','outbound-first-open');b('documents','owner','text','outbound-memo-text','<b>memo</b>');b('workflow','owner','visible','outbound-post',false);
  browserLogin('operator','keeper');b('workflow','operator','goto','/outbounds?q=WEB-A');b('workflow','operator','click','outbound-first-open');b('workflow','operator','click','outbound-post');b('workflow','operator','text','outbound-status','posted');b('ledger','operator','text','stock-quantity','8');b('audit','operator','text','audit-count','2');
  b('consistency','owner','goto','/outbounds?q=WEB-A');b('consistency','owner','click','outbound-first-open');b('consistency','owner','text','outbound-status','posted');
  b('ledger','operator','goto','/ledger?warehouse=W1&sku=SKU-A');b('ledger','operator','text','ledger-balance','8');b('ledger','operator','count','ledger-row',2);
  if(version){b('evolution','owner','goto','/outbounds?q=KEPT-D1');b('evolution','owner','click','outbound-first-open');b('evolution','owner','fill','outbound-memo-edit','web-owner-v1');b('evolution','owner','click','outbound-save-memo');b('evolution','owner','text','outbound-memo-text','web-owner-v1');b('evolution','owner','visible','outbound-quantity-edit',false);}
  else b('evolution','owner','visible','outbound-save-memo',false);
  return k.finish();
}
